"""登录、验证码与凭据管理。

自动识别部分对齐原项目 login.py：拉取验证码 -> 识别缺口 -> 提交校验。
只尝试一次：失败立即返回，由前端直接弹出滑块窗口，避免用户干等。
手动部分对齐原项目 main.py：滑块 0~100 的比例直接提交，
验证失败后自动换图并复位滑块。
"""

from __future__ import annotations

import base64
import io
import json
import threading
import time
from typing import Any, Callable, Dict, Optional, Tuple

from PIL import Image

from .bus import EventBus
from .client import ZhsClient, ZhsError
from .config import clear_credentials, load_credentials, save_credentials
from .legacy import ensure_legacy_path

CAPTCHA_ID = "75f9f716460a422f89a628f50fd8cc2b"
CAPTCHA_REFERER = "https://passport.zhihuishu.com/login"

# 自动识别只尝试一次：失败立刻转手动滑块，不让用户在后台干等
MAX_CAPTCHA_RETRY = 1

# 低于该置信度的缺口结果直接视为识别失败（宁可直接转手动，也不要提交错位置）
MIN_GAP_CONFIDENCE = 0.45

LOGIN_MESSAGES = {
    -2: "用户名或密码错误",
    -6: "连续 5 次登录失败，请 5 分钟后重试",
    -1: "登录失败，出现未知错误",
}


def _solve_gap(background: bytes) -> Tuple[Optional[int], float, str, str]:
    """识别滑块缺口横坐标（背景图原始像素），与 login.py 的 recognize_gap 一致。

    返回 (x, confidence, method, error)。error 非空表示识别不可用，
    调用方会把它写进日志，避免打包环境里的依赖问题被静默吞掉。
    """
    try:
        from captcha_recognizer.slider import Slider

        box, confidence = Slider().identify(source=background, show=False)
        # box 兼容 (x, y) / (x1, y1, x2, y2) / dict
        x = int(box.get("x", 0) if isinstance(box, dict) else box[0])
        if x > 0:
            return x, float(confidence), "captcha_recognizer", ""
        return None, 0.0, "captcha_recognizer", "未检测到缺口"
    except Exception as exc:
        return None, 0.0, "", "%s: %s" % (type(exc).__name__, exc)


def _percent(gap_x: int, width: int) -> float:
    """缺口像素 -> 0~100 的滑动比例，与原项目一致。"""
    if width <= 0:
        return 0.0
    return max(0.0, min(100.0, gap_x / float(width) * 100.0))


class AuthManager:
    def __init__(self, bus: EventBus, settings_provider: Callable[[], Dict[str, Any]]) -> None:
        self.bus = bus
        self._settings = settings_provider
        self._lock = threading.RLock()
        self.client: Optional[ZhsClient] = None
        self.profile: Optional[Dict[str, str]] = None
        self._captcha: Any = None
        self._captcha_raw: Tuple[bytes, bytes] = (b"", b"")
        self._pending: Dict[str, Any] = {}

    # ------------------------------------------------------------------ 内部
    def _prepare_client(self, client: ZhsClient) -> ZhsClient:
        # 用户可见的提示（弹窗答题结果这类）无条件送界面。
        # 之前它们走 log_hook，而 log_hook 只在 log_api=True 时才挂上（默认 False），
        # 结果界面上只剩「正在自动作答」，答题成功与否完全看不见。
        client.notice_hook = lambda text, level="info": self.bus.publish(
            {"type": "log", "level": level, "message": str(text)[:3000],
             "time": time.strftime("%H:%M:%S", time.localtime())}
        )
        if self._settings().get("log_api"):
            client.log_hook = lambda text: self.bus.publish(
                {"type": "log", "level": "debug", "message": str(text)[:3000],
                 "time": time.strftime("%H:%M:%S", time.localtime())}
            )
        return client

    def _new_captcha(self, username: str, password: str, remember: bool) -> Dict[str, Any]:
        ensure_legacy_path()
        from captcha.captcha import Captcha

        captcha = Captcha(CAPTCHA_ID, CAPTCHA_REFERER)
        data = captcha.captcha_data
        background = base64.b64decode(data["bigImage"])
        piece = base64.b64decode(data["smallImage"])
        width, height = Image.open(io.BytesIO(background)).size
        piece_width, piece_height = Image.open(io.BytesIO(piece)).size

        with self._lock:
            self._captcha = captcha
            self._captcha_raw = (background, piece)
            self._pending = {"username": username, "password": password, "remember": remember}

        return {
            "background": "data:image/png;base64," + data["bigImage"],
            "piece": "data:image/png;base64," + data["smallImage"],
            "width": width,
            "height": height,
            "piece_width": piece_width,
            "piece_height": piece_height,
            "type": data.get("type"),
        }

    def _check(self, captcha: Any, ratio: float) -> Tuple[bool, str, str]:
        """提交滑块比例，返回 (是否通过, 提示, validate)。"""
        try:
            ratio = max(0.0, min(100.0, float(ratio)))
        except (TypeError, ValueError):
            raise ZhsError("滑块比例无效")

        try:
            payload = json.loads(captcha.check_captcha(ratio))
        except (ValueError, TypeError) as exc:
            raise ZhsError("验证码校验失败：%s" % exc) from exc

        data = payload.get("data") or {}
        if not data.get("result"):
            return False, "验证未通过，请调整滑块位置后重试", ""
        return True, "验证通过", data.get("validate") or ""

    def _do_login(self, captcha: Any, validate: str) -> Tuple[bool, str, Optional[Dict[str, str]]]:
        with self._lock:
            pending = dict(self._pending)
        username = pending.get("username", "")
        password = pending.get("password", "")

        client = self._prepare_client(ZhsClient())
        secret = captcha.encrypt_login_data(username, password, validate, captcha.fp)
        code, extra = client.login(secret)
        if code != 0:
            if code == -2:
                return False, "用户名或密码错误（第 %s 次）" % extra, None
            return False, LOGIN_MESSAGES.get(code, "登录失败，错误码 %s" % code), None

        # 登录接口已通过：先落盘会话，避免后面取用户信息失败时白验证一次滑块
        credentials: Dict[str, Any] = {
            "username": username,
            "cookies": client.cookie_dict(),
            "fp": captcha.fp,
            "validate": validate,
            "updated_at": int(time.time()),
        }
        if pending.get("remember"):
            credentials["password"] = password
        save_credentials(credentials)
        self.client = client

        name = ""
        # 登录已成功，这里只是补拉用户信息：少次数、短超时，避免网络抖动时卡住界面
        for _ in range(3):
            name = client.get_real_name(retries=1, timeout=8) or ""
            if name:
                break
            time.sleep(0.4)
        if not name:
            # 不能留「半登录」：main.py 里 authenticated 看 profile，
            # 各处业务守卫看 client，两者不一致会让前端停在登录页而后端认为已登录。
            # cookies 已经落盘，下次 login_with_cookie 还能恢复。
            self.client = None
            raise ZhsError("登录已通过，但获取用户信息失败（可能是网络波动），请稍后重试")

        self.profile = {"name": name, "username": username, "avatar": client.avatar}
        self.bus.log("登录成功，欢迎 %s" % name, "success")
        return True, "登录成功", self.profile

    # ------------------------------------------------------------------ 对外
    def refresh_captcha(self) -> Dict[str, Any]:
        pending = dict(self._pending)
        if not pending.get("username"):
            saved = load_credentials()
            # 只在“记住密码”开启时回填密码，避免关闭后旧密码仍被带上
            remember = bool(self._settings().get("remember_password"))
            pending = {
                "username": saved.get("username", ""),
                "password": saved.get("password", "") if remember else "",
                "remember": remember,
            }
        return self._new_captcha(pending["username"], pending.get("password", ""), pending.get("remember", False))

    def start_captcha(self, username: str, password: str, remember: bool) -> Dict[str, Any]:
        return self._new_captcha(username, password, remember)

    def auto_solve(self, refresh: bool = False) -> Dict[str, Any]:
        """识别当前验证码的缺口比例；refresh=True 时先换一张（对应 main.py 的“换一张”）。"""
        if refresh:
            self.refresh_captcha()
        with self._lock:
            background, _piece = self._captcha_raw
            has_user = bool(self._pending.get("username"))
        if not background or not has_user:
            return {
                "ratio": None,
                "confidence": 0.0,
                "method": "",
                "message": "验证码已过期，请重新登录",
                "expired": True,
            }

        x, confidence, method, error = _solve_gap(background)
        if x is None:
            self.bus.log("自动识别不可用：%s" % (error or "未检测到缺口"), "warn")
            return {"ratio": None, "confidence": 0.0, "method": "", "message": "自动识别失败，请手动拖动滑块"}
        width = Image.open(io.BytesIO(background)).size[0] or 1
        ratio = _percent(x, width)
        return {
            "ratio": round(ratio, 2),
            "confidence": round(confidence, 4),
            "method": method,
            "x": x,
            "width": width,
            "message": "自动识别完成",
        }

    def submit_captcha(self, ratio: float) -> Dict[str, Any]:
        """手动模式：校验滑块通过后立即登录。"""
        with self._lock:
            captcha = self._captcha
            pending = dict(self._pending)
        if captcha is None or not pending.get("username"):
            return {
                "ok": False,
                "captcha_ok": False,
                "expired": True,
                "message": "验证码已过期，请重新登录",
            }

        ok, message, validate = self._check(captcha, ratio)
        if not ok:
            return {"ok": False, "captcha_ok": False, "message": message}

        try:
            ok, message, profile = self._do_login(captcha, validate)
        except ZhsError as exc:
            return {"ok": False, "captcha_ok": True, "message": str(exc)}
        return {"ok": ok, "captcha_ok": True, "message": message, "profile": profile}

    def auto_login(self, username: str, password: str, remember: bool,
                   max_retry: int = MAX_CAPTCHA_RETRY) -> Dict[str, Any]:
        """自动模式：拉图 -> 识别缺口 -> 提交校验。

        默认只尝试一次：识别不到或校验不通过就立刻返回，
        由调用方换一张图并弹出手动滑块窗口，不让用户在后台干等。
        """
        max_retry = max(1, int(max_retry or 1))
        last_message = "自动验证未通过"

        for attempt in range(1, max_retry + 1):
            self._new_captcha(username, password, remember)
            with self._lock:
                captcha = self._captcha
                background = self._captcha_raw[0]

            if getattr(captcha, "type", 2) != 2:
                self.bus.log("验证码不是滑块类型，转手动处理", "warn")
                return {
                    "ok": False,
                    "captcha_ok": False,
                    "message": "当前验证码类型无法自动识别，请手动完成",
                    "attempts": attempt,
                }

            x, confidence, method, error = _solve_gap(background)
            if x is None:
                last_message = "自动识别失败"
                self.bus.log("滑块缺口识别失败，转手动验证：%s" % (error or "未检测到缺口"), "warn")
                continue

            if confidence < MIN_GAP_CONFIDENCE:
                last_message = "自动识别置信度过低"
                self.bus.log("滑块缺口置信度 %.3f 过低，转手动验证" % confidence, "warn")
                continue

            try:
                width = Image.open(io.BytesIO(background)).size[0] or 1
            except Exception:
                width = 320

            ratio = _percent(x, width)
            self.bus.log(
                "自动识别：缺口 x=%d，比例 %.2f，置信度 %.3f" % (x, ratio, confidence),
                "debug",
            )

            try:
                ok, message, validate = self._check(captcha, ratio)
            except ZhsError as exc:
                last_message = "验证码校验失败：%s" % exc
                self.bus.log(last_message, "warn")
                continue

            if not ok:
                last_message = "滑块位置未通过校验"
                self.bus.log("滑块校验未通过，转手动验证", "warn")
                continue

            self.bus.log("滑块验证通过，正在登录…", "success")
            try:
                ok, message, profile = self._do_login(captcha, validate)
            except ZhsError as exc:
                return {
                    "ok": False,
                    "captcha_ok": True,
                    "message": str(exc),
                    "attempts": attempt,
                    "ratio": round(ratio, 2),
                }
            return {
                "ok": ok,
                "captcha_ok": True,
                "message": message,
                "profile": profile,
                "attempts": attempt,
                "ratio": round(ratio, 2),
            }

        return {
            "ok": False,
            "captcha_ok": False,
            "message": "%s，请手动完成滑块验证" % last_message,
            "attempts": max_retry,
        }

    def login_with_cookie(self, username: Optional[str] = None) -> Optional[Dict[str, str]]:
        credentials = load_credentials()
        if not credentials.get("cookies"):
            return None
        if username and credentials.get("username") and username != credentials["username"]:
            return None

        client = self._prepare_client(ZhsClient())
        client.set_cookies(credentials["cookies"])
        try:
            # 启动阶段恢复登录：单次短超时，失效就尽快回落到登录页
            name = client.get_real_name(retries=1, timeout=10)
        except ZhsError:
            return None
        if not name:
            return None

        self.client = client
        self.profile = {
            "name": name,
            "username": credentials.get("username", ""),
            "avatar": client.avatar,
        }
        return self.profile

    def logout(self) -> None:
        self.client = None
        self.profile = None
        self._captcha = None
        self._captcha_raw = (b"", b"")
        self._pending = {}
        # 退出只清会话（Cookie / 滑块状态），保留上一次成功登录的账号信息，
        # 下次打开登录页可直接填充，用户点一下登录即可，不需要重新输入
        saved = load_credentials()
        # 密码只在“记住密码”开启时保留，否则退出即视为放弃本地密码
        keys = ("username", "password", "updated_at") if self._settings().get("remember_password") \
            else ("username", "updated_at")
        kept: Dict[str, Any] = {key: saved[key] for key in keys if saved.get(key)}
        if kept:
            save_credentials(kept)
        else:
            clear_credentials()
