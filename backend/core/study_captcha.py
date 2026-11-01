"""学习页人机验证（网易易盾空间推理，type=11）。

学习过程中的进度上报会被平台打回 ``{"code": -12, "message": "需要弹出滑块验证"}``，
此时必须有人完成一次验证码。这里负责：

    拉图（getconf -> /v3/get） -> 交给前端显示 -> 用户点击坐标 -> 提交 /v3/check

提交格式照 2.28.5 SDK 的 ``shouldVerifyCaptcha`` 分支：

    data = {
        "d":   "",
        "p":   Q(每个点击点 I(token, "x,y,t") 再 join(":")),
        "m":   Q(每个轨迹点 I(token, "x,y,t,flag") 再 join(":")),
        "ext": Q(I(token, "clickCounts,traceLen")),
    }

Q 是易盾自己的 base64 变体，I 是带 token 的异或编码，二者都在
vendor/captcha/yidun_encrypt.py 里。

通过之后还要拼平台登记用的 token（不是易盾原文）：

    CN31_ + Q(validate + "::" + fp) + _v_i_1    （再把 \\ / + 换成 - _ *）

fp 必须是拉这张图时用的那一个，交给 client.validate_slide_token 登记。
"""

from __future__ import annotations

import base64
import io
import json
import math
import random
import re
import string
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import requests
from PIL import Image

from .bus import EventBus
from .client import ZhsError
from .legacy import ensure_legacy_path

CAPTCHA_ID = "4da3050565514a35a50541b0e1f54538"
REFERER = "https://wisdom-mooc.zhihuishu.com/study/index"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0"
)

# 版本号照浏览器 2.28.5 抓包对齐：getconf / get / check 都用 iv=4、loadVersion=2.5.0
IV_CONF, LOAD_CONF = "4", "2.5.0"
IV_GET, LOAD_GET = "4", "2.5.0"
VERSION_GET = "2.28.5"
CHECK_VERSION = "2.28.5"

# 用户多久没完成就判定放弃
WAIT_TIMEOUT = 300.0
# 自动识别最多连试多少张：单张命中率有限，多给机会；
# 但连打太久易盾会开始刁难（param check error），到点就交回给用户手动。
AUTO_MAX_ROUNDS = 20
# 轮与轮之间留一点间隔，避免连续打 get 接口把风控逼得更紧。
AUTO_ROUND_DELAY = 1.2
# 识别出点位后先亮出来给用户看一眼再提交，这段时间里点图即可接手手动。
AUTO_POINT_PREVIEW = 0.6


def _short(exc: Exception, limit: int = 40) -> str:
    """把异常压成一句能塞进状态栏的短文本。"""
    text = str(exc).strip().splitlines()[0] if str(exc).strip() else exc.__class__.__name__
    return text if len(text) <= limit else text[:limit] + "…"


def _jsonp(text: str) -> Dict[str, Any]:
    found = re.findall(r"\((.*)\)", text, re.S)
    if not found:
        raise ZhsError("验证码服务返回格式异常")
    try:
        return json.loads(found[0])
    except ValueError as exc:
        raise ZhsError("验证码服务返回解析失败：%s" % exc) from exc


def _rand(n: int = 7) -> str:
    return "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(n))


class StudyCaptcha:
    """一次验证的完整生命周期：begin -> (用户) submit -> wait 到 solved。"""

    def __init__(self, bus: EventBus, auto_getter: Optional[Callable[[], bool]] = None) -> None:
        self.bus = bus
        # 是否默认自动识别（读取设置里的 auto_solve，关掉就纯手动）
        self._auto_getter = auto_getter or (lambda: True)
        self._lock = threading.RLock()
        self._session: Optional[requests.Session] = None
        self._ctx: Any = None
        self._conf: Dict[str, Any] = {}
        self._token = ""
        self._size: Tuple[int, int] = (0, 0)
        self._type = 0
        self._started = 0.0
        self._active = False
        self._solved = threading.Event()
        self._validate = ""
        # 拉这张图时用的 fp，拼平台 slideToken 必须用它
        self._fp = ""
        # getconf 下发的 dt（设备令牌），后续请求带上可少踩 param check error
        self._dt = ""
        # 平台登记用的 token：CN31_ + Q(validate::fp) + _v_i_1
        self._slide_token = ""
        # 用户声明“已在浏览器里完成验证”，让引擎直接重试上报
        self._confirmed = False
        self._task: Dict[str, Any] = {}
        # 最近一次下发的验证码内容：前端刷新页面后据此恢复弹窗
        self._payload: Dict[str, Any] = {}
        # 当前这张图的提示语和原始字节，自动识别要用
        self._notice = ""
        self._bg = b""
        # 取图串行化：begin 的网络段和状态赋值必须整段原子，否则 token/fp 会配错图
        self._begin_lock = threading.Lock()
        # 自动识别线程 / 停止信号 / 进度
        self._auto_thread: Optional[threading.Thread] = None
        self._auto_stop = threading.Event()
        self._auto_round = 0
        # 每张新图递增：前端靠它判断「自动标的点」是不是当前这张图的
        self._img_seq = 0
        self._ocr: Any = None
        # 本地模型加载失败的原因；非空说明这次运行别指望自动识别了
        self._ocr_error = ""

    # ------------------------------------------------------------ 内部
    def _ctx_obj(self) -> Any:
        if self._ctx is None:
            ensure_legacy_path()
            from captcha.yidun_encrypt import yidun_encrypt

            self._ctx = yidun_encrypt()
        return self._ctx

    def _http(self) -> requests.Session:
        with self._lock:
            if self._session is None:
                s = requests.Session()
                s.headers.update(
                    {
                        "Accept": "*/*",
                        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                        "Cache-Control": "no-cache",
                        "Pragma": "no-cache",
                        "User-Agent": UA,
                        "Referer": "https://wisdom-mooc.zhihuishu.com/",
                    }
                )
                self._session = s
            return self._session

    def _get_conf(self, s: requests.Session) -> Dict[str, Any]:
        params = {
            "referer": REFERER,
            "zoneId": "",
            "id": CAPTCHA_ID,
            "ipv6": "false",
            "runEnv": "10",
            "iv": IV_CONF,
            "loadVersion": LOAD_CONF,
            "lang": "zh-CN",
            "callback": "__JSONP_%s_0" % _rand(),
        }
        # 浏览器第二次起会带上上一次 getconf 下发的 dt，不带给会偶发 param check error
        if self._dt:
            params["dt"] = self._dt
        ref = s.headers.get("Referer")
        try:
            s.headers.pop("Referer", None)
            r = s.get("https://c.dun.163.com/api/v2/getconf", params=params, timeout=12)
        finally:
            if ref:
                s.headers["Referer"] = ref
        payload = _jsonp(r.text)
        if payload.get("error"):
            raise ZhsError("获取验证配置失败：%s" % payload.get("msg"))
        conf = payload["data"]
        if conf.get("dt"):
            self._dt = str(conf["dt"])
        return conf

    def _get_image(self, s: requests.Session, conf: Dict[str, Any], token: str = "") -> Dict[str, Any]:
        # fp 必须和后面拼 slideToken 用同一个，否则平台侧的 validate 对不上
        fp = self._ctx_obj().call("fp")
        self._fp = fp
        params = {
            "referer": REFERER,
            "zoneId": conf.get("zoneId") or "",
            "dt": conf.get("dt") or "",
            "acToken": (conf.get("ac") or {}).get("token", ""),
            "id": CAPTCHA_ID,
            "fp": fp,
            "https": "true",
            "type": "",
            "version": VERSION_GET,
            "dpr": "1.5",
            "dev": "1",
            # cb 必须是 SDK 里 n2() 生成的长串，随机短串会 param check error
            "cb": self._ctx_obj().call("n2"),
            "ipv6": "false",
            "runEnv": "10",
            "group": "",
            "scene": "",
            "lang": "zh-CN",
            "sdkVersion": "",
            "iv": IV_GET,
            "loadVersion": LOAD_GET,
            "width": "320",
            "user": "",
            "audio": "false",
            "sizeType": "10",
            "smsVersion": "v3",
            "token": token,
            "callback": "__JSONP_%s_0" % _rand(),
        }
        r = s.get("https://c.dun.163.com/api/v3/get", params=params, timeout=12)
        payload = _jsonp(r.text)
        if payload.get("error"):
            raise ZhsError("获取验证码失败：%s" % payload.get("msg"))
        return payload["data"]

    # ------------------------------------------------------------ 对外
    def begin(
        self,
        task: Optional[Dict[str, Any]] = None,
        auto: bool = True,
        notify: bool = True,
    ) -> Dict[str, Any]:
        """拉一张新图并推给前端。失败抛 ZhsError，由调用方决定是否终止学习。

        整段（取图 + 状态赋值）用 _begin_lock 串行化：自动循环的换图和用户点
        “换一张”可能同时进来，交叉执行会让 _token/_fp/_bg 张冠李戴，之后提交必失败。

        auto=False 时不启动自动识别：用户在弹窗里点了「换一张」或接手自己点，
        这时换图要留在手动模式，不能又把自动识别拉起来跟用户抢同一张图。
        notify=False 时不推 required 事件（调用方自己渲染，不惊动学习弹窗）。
        """
        with self._begin_lock:
            payload = self._begin_locked(task, notify)
            if auto and notify and payload.get("type") == 11 and self._auto_getter():
                self._start_auto()
            return payload

    def _begin_locked(self, task: Optional[Dict[str, Any]], notify: bool = True) -> Dict[str, Any]:
        s = self._http()
        # 短时间内重复取图会被风控打回 param check error，退避重试几次
        last_error = ""
        for attempt in range(3):
            try:
                conf = self._get_conf(s)
                data = self._get_image(s, conf)
                break
            except (ZhsError, requests.RequestException) as exc:
                # 前两次静默重试，三次都失败才上报
                last_error = str(exc)
                time.sleep(1.5 * (attempt + 1))
        else:
            raise ZhsError(last_error or "验证码获取失败")

        ctype = int(data.get("type") or 0)
        bg_url = (data.get("bg") or [""])[0]
        if not bg_url:
            raise ZhsError("验证码图片为空")
        bg = requests.get(bg_url, headers={"User-Agent": UA}, timeout=15).content
        size = Image.open(io.BytesIO(bg)).size

        notice = data.get("front")
        if isinstance(notice, list):
            notice = notice[0] if notice else ""

        with self._lock:
            self._img_seq += 1
            img_seq = self._img_seq

        payload = {
            "background": "data:image/jpeg;base64," + base64.b64encode(bg).decode("ascii"),
            "notice": str(notice or ""),
            "width": size[0],
            "height": size[1],
            "type": ctype,
            "img": img_seq,
        }

        with self._lock:
            self._conf = conf
            self._token = str(data.get("token") or "")
            self._size = size
            self._type = ctype
            self._started = time.time()
            self._active = True
            self._solved.clear()
            self._validate = ""
            self._slide_token = ""
            self._confirmed = False
            self._task = dict(task or {})
            self._payload = payload
            self._notice = str(notice or "")
            self._bg = bg

        if ctype != 11:
            # 学习页只会下发 11（空间推理）；真遇到别的类型说明风控策略变了
            self.bus.log("验证码类型为 %s，暂不支持自动提交，请稍后重试" % ctype, "warn")

        if notify:
            self.bus.publish(
                {
                    "type": "captcha",
                    "action": "required",
                    "captcha": payload,
                    "task": self._task,
                }
            )
        return payload

    # ------------------------------------------------------------ 自动识别
    def _ocr_model(self) -> Any:
        """ddddocr 首次加载要 1~2 秒，缓存起来，同一张图的多轮识别复用。"""
        with self._lock:
            if self._ocr is None:
                try:
                    import ddddocr

                    self._ocr = ddddocr.DdddOcr(show_ad=False)
                except Exception as exc:  # noqa: BLE001
                    # 发行版最常踩的坑：打包时漏了 ddddocr 包目录里的 .onnx，
                    # 初始化直接抛「模型文件不存在」，换多少张图都好不了。
                    # 记下原因，交给自动循环判断是收手还是继续换图。
                    self._ocr_error = str(exc)
                    raise
            return self._ocr

    def _publish_auto(self, status: str, running: bool = True,
                      point: Optional[List[int]] = None) -> None:
        """把自动识别的进度推给前端弹窗。

        ``point`` 是这一轮选中的坐标，会在弹窗图片上标出来——自动识别复用
        手动验证的那个弹窗，用户能看见它准备点哪、也能随时接手。
        """
        with self._lock:
            img = self._img_seq
        self.bus.publish(
            {
                "type": "captcha",
                "action": "auto",
                "auto": {
                    "status": status,
                    "running": running,
                    "round": self._auto_round,
                    "img": img,
                    "point": point,
                },
            }
        )

    def _start_auto(self) -> None:
        """拉图后自动开一轮本地识别；设置里关掉自动识别时什么都不做。"""
        with self._lock:
            if self._auto_thread and self._auto_thread.is_alive():
                return
            self._auto_stop.clear()
            self._auto_round = 0
            thread = threading.Thread(target=self._auto_loop, name="captcha-auto", daemon=True)
            self._auto_thread = thread
        thread.start()

    def _refresh(self, task: Dict[str, Any]) -> bool:
        """自动循环里换一张新图；失败（被限流等）就结束自动，转手动。"""
        try:
            self.begin(task)
            return True
        except (ZhsError, requests.RequestException) as exc:
            self.bus.log("自动识别换图失败：%s，请手动点选" % exc, "warn")
            self._publish_auto("换图失败，请手动点选", running=False)
            return False

    def _auto_loop(self) -> None:
        """本地识别 -> 提交 -> 没中就换一张，直到通过、用户接手或达到轮数上限。

        轮数上限（AUTO_MAX_ROUNDS）是防风控的：连打 get 接口太久易盾会开始
        刁难。撞上限后不停掉整条链路，只停自动循环并把当前这张图留给用户，
        用户点「换一张」还能继续，只是这时要自己点选了。
        """
        try:
            from captcha.space_reasoning import solve
        except ImportError as exc:
            self.bus.log("自动识别模块不可用（%s），请手动点选" % exc, "warn")
            self._publish_auto("自动识别不可用，请手动点选", running=False)
            return

        ocr = None
        while not self._auto_stop.is_set():
            with self._lock:
                if not self._active:
                    return
                self._auto_round += 1
                round_no = self._auto_round
                notice, bg, task = self._notice, self._bg, dict(self._task)
                # 这张图是什么时候下发的：自动提交时用它算点击时间偏移
                shown_at = self._started
                size = self._size
                img_seq = self._img_seq
            if round_no > AUTO_MAX_ROUNDS:
                self.bus.log("自动识别 %d 张仍未通过，停下等你手动点选" % AUTO_MAX_ROUNDS, "warn")
                self._publish_auto(
                    "已连试 %d 张仍未通过，改用手动吧（点「换一张」还能继续试）" % AUTO_MAX_ROUNDS,
                    running=False)
                return

            self._publish_auto("正在识别第 %d 张…" % round_no)
            self.bus.log("正在自动识别人机验证（第 %d 次）…" % round_no, "info")
            try:
                if ocr is None:
                    ocr = self._ocr_model()
                points = solve(notice, bg, ocr=ocr)
            except Exception as exc:  # noqa: BLE001  识别失败就换图，别卡住
                if self._ocr_error:
                    # 模型没装起来：换图也没用，直接交回手动，并在日志服务留档
                    # 上报用完整信息（含模型路径），便于在日志服务里直接定位
                    self.bus.log("自动识别不可用：%s，请手动点选" % self._ocr_error, "warn")
                    self._publish_auto("本地识别模型不可用，请手动点选", running=False)
                    self._auto_stop.set()
                    return
                self._publish_auto("这张没认出来（%s），换一张继续" % _short(exc))
                self.bus.log("第 %d 张没认出来：%s，换一张继续" % (round_no, exc), "info")
                if self._auto_stop.wait(AUTO_ROUND_DELAY):
                    return
                if not self._refresh(task):
                    return
                continue

            if not points:
                self._publish_auto("这张没认出来，换一张继续")
                if self._auto_stop.wait(AUTO_ROUND_DELAY):
                    return
                if not self._refresh(task):
                    return
                continue

            # 先把点位亮在弹窗上再提交：用户能看见它准备点哪，
            # 这段时间里点图或点「停止自动」即可接手改用自己的点。
            head = points[0]
            self._publish_auto("识别为 %d,%d，提交中…" % (head[0], head[1]),
                               point=[int(head[0]), int(head[1])])
            if self._auto_stop.wait(AUTO_POINT_PREVIEW):
                return
            with self._lock:
                # 等待期间用户可能已经手动提交/换图，别拿旧点位去覆盖
                if not self._active or self._img_seq != img_seq:
                    return

            try:
                # 自动识别没有真实鼠标，但时间戳和轨迹必须像浏览器：
                # 从拉图到现在的时间差就是一次“人工点击”的合理量级，
                # 多个目标点之间也留出人的反应间隔（~140ms），
                # 轨迹用一条带弧度的贝塞尔路径补上，只发一个点太像脚本。
                stamp = int((time.time() - shown_at) * 1000)
                clicks = [(int(x), int(y), stamp + i * 140) for i, (x, y) in enumerate(points)]
                trace = self._synthetic_trace(size, clicks)
                result = self.submit([[x, y, t] for x, y, t in clicks], trace)
            except Exception as exc:  # noqa: BLE001  提交阶段的意外异常不能杀死守护线程
                self.bus.log("自动提交异常：%s，请手动点选" % exc, "warn")
                self._publish_auto("自动提交出错，请手动点选", running=False)
                self._auto_stop.set()
                return
            if result.get("ok"):
                return
            if self._auto_stop.is_set():
                return
            self._publish_auto("没点中，换一张继续（第 %d 次）" % (round_no + 1), point=None)
            self.bus.log("第 %d 次没点中，换一张继续" % round_no, "warn")
            if self._auto_stop.wait(AUTO_ROUND_DELAY):
                return
            if not self._refresh(task):
                return

    def stop_auto(self) -> Dict[str, Any]:
        """用户要自己点：停掉自动循环，保留当前这张图等人点。"""
        self._auto_stop.set()
        thread = self._auto_thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            # 最多等 8 秒：识别+提交一轮通常几秒，超时也不阻塞请求
            thread.join(timeout=8.0)
        self._publish_auto("已切换为手动点选", running=False)
        return {"ok": True, "message": "已切换为手动点选"}

    def auto_running(self) -> bool:
        thread = self._auto_thread
        return bool(thread and thread.is_alive() and not self._auto_stop.is_set())

    def submit(
        self,
        points: List[List[float]],
        trace: Optional[List[List[float]]] = None,
    ) -> Dict[str, Any]:
        """points: [[x, y, 点击毫秒?], ...]；trace: 真实鼠标轨迹 [[x, y, ms], ...]。

        点击时刻和轨迹都按浏览器的语义发：t=0（图一出现就点中）在风控眼里
        非常可疑，实测是“点位看着对却被判没点中”的主要原因之一。
        """
        if threading.current_thread() is not self._auto_thread:
            # 用户自己点了：立刻停掉自动循环，别和用户抢同一张图
            self._auto_stop.set()
        elif self._auto_stop.is_set():
            # 用户点了“停止自动”但自动线程还没退出：不再提交，让位给手动
            return {"ok": False, "expired": True, "message": "已切换为手动点选"}
        with self._lock:
            if self._slide_token and not self._active:
                # 连点两下提交时，第二次直接返回已通过的结果，不再报“已过期”
                return {"ok": True, "validate": self._validate, "message": "验证通过"}
            if not self._active or not self._token:
                return {"ok": False, "expired": True, "message": "验证码已过期，请重新发起"}
            token = self._token
            conf = self._conf
            size = self._size
            started = self._started

        clean: List[Tuple[int, int, int]] = []
        for item in points or []:
            try:
                x, y = int(round(float(item[0]))), int(round(float(item[1])))
                # 第三项是前端传来的点击时刻（相对图片显示的毫秒数）；缺省用后端经过的时间
                stamp = int(round(float(item[2]))) if len(item) > 2 and item[2] is not None else -1
            except (TypeError, ValueError, IndexError):
                continue
            if size[0] and size[1]:
                x = max(0, min(size[0] - 1, x))
                y = max(0, min(size[1] - 1, y))
            if stamp < 0:
                stamp = max(0, int((time.time() - started) * 1000))
            clean.append((x, y, stamp))
        if not clean:
            return {"ok": False, "message": "请先在图片上点击目标字符"}
        # 空间推理只校验一个目标点，多传反而会判错，只取最后一个（用户的最终选择）
        clean = clean[-1:]
        if not trace:
            # 调用方没有真实鼠标（测试面板 / test-submit / 旧版前端）时合成一条像人的轨迹。
            # 浏览器的 m 字段是一整串 mousemove，只发孤零零一个点，风控一眼就看出是脚本；
            # 「点位肉眼正确却被判没点中」基本都出在这里，所以放在后端兜底，
            # 保证任何调用路径发出去的 payload 都和浏览器一致。
            trace = self._synthetic_trace(size, clean)

        data = self._build_payload(token, clean, size, started, trace)
        params = {
            "referer": REFERER,
            "zoneId": conf.get("zoneId") or "CN31",
            "dt": conf.get("dt") or "",
            "id": CAPTCHA_ID,
            "token": token,
            "acToken": (conf.get("ac") or {}).get("token", ""),
            "data": json.dumps(data),
            "width": "320",
            "type": "11",
            "version": CHECK_VERSION,
            "cb": self._ctx_obj().call("n2"),
            "user": "",
            "extraData": "",
            "bf": "0",
            "runEnv": "10",
            "sdkVersion": "",
            "loadVersion": LOAD_GET,
            "iv": IV_GET,
            "callback": "__JSONP_%s_0" % _rand(),
        }
        try:
            r = self._http().get("https://c.dun.163.com/api/v3/check", params=params, timeout=12)
            result = _jsonp(r.text)
        except (requests.RequestException, ZhsError) as exc:
            return {"ok": False, "message": "验证码校验请求失败：%s" % exc}

        if result.get("error"):
            return {"ok": False, "message": "校验未通过（%s），请重试" % result.get("msg")}

        body = result.get("data") or {}
        if not body.get("result"):
            x, y, _ = clean[0]
            self.bus.log("验证码没点中（点位 %d,%d）" % (x, y), "warn")
            return {
                "ok": False,
                "captcha_failed": True,
                "message": "没点中（上次点位 %d,%d）。红点是刚才点的位置，"
                "照放大镜把字符中心对准再点一次" % (x, y),
            }

        validate = body.get("validate") or ""
        slide_token = self._platform_token(validate)
        with self._lock:
            self._validate = validate
            self._slide_token = slide_token
            self._active = False
        # 通过即收工：置位停止信号，让 auto_running() 立刻反映真实状态
        self._auto_stop.set()
        self._solved.set()
        self.bus.publish({"type": "captcha", "action": "solved"})
        self.bus.log("人机验证已通过（点位 %d,%d）" % (clean[0][0], clean[0][1]), "success")
        return {"ok": True, "validate": validate, "message": "验证通过"}

    def _platform_token(self, validate: str) -> str:
        """平台 validateSlideToken 要的 token，不是易盾那个 validate。

        浏览器实测（解密 secretStr 得到的明文）：
        ``{"token": "CN31_<X>_v_i_1", "ev": "<hex>", "checkType": 1}``，
        其中 ``<X>`` = Q(validate + "::" + fp) 再把 ``\\ / +`` 换成 ``- _ *``。
        fp 必须是拉这张图时用的那一个，换一个就对不上。
        """
        if not validate or not self._fp:
            return ""
        mapped = self._ctx_obj().Q(validate + "::" + self._fp)
        for raw, safe in (("\\", "-"), ("/", "_"), ("+", "*")):
            mapped = mapped.replace(raw, safe)
        token = "CN31_" + mapped + "_v_i_1"
        return token

    @staticmethod
    def _synthetic_trace(
        size: Tuple[int, int],
        points: List[Tuple[int, int, int]],
    ) -> List[List[float]]:
        """自动识别没有真实鼠标，这里合成一条像人的移动轨迹。

        浏览器 SDK 的 ``m`` 是一串 mousemove：起点在画布内，终点正好落在点击点，
        每个点带毫秒时间戳。整条 m 只发一个点（甚至为空）非常像脚本，
        风控会直接提高校验难度，所以按贝塞尔弧线 + 轻微抖动补齐。
        """
        width, height = size if size and size[0] and size[1] else (320, 160)
        if not points:
            return []
        # 起点：画布中下部随机一点，像人刚把鼠标移进来
        cur_x = width / 2.0 + random.uniform(-40, 40)
        cur_y = height * random.uniform(0.45, 0.8)
        cur_t = 0
        path: List[List[float]] = [[int(round(cur_x)), int(round(cur_y)), 0]]
        for tx, ty, stamp in points:
            end_t = max(int(stamp), cur_t + 80)
            steps = max(6, min(20, int((end_t - cur_t) / 40)))
            dx, dy = float(tx) - cur_x, float(ty) - cur_y
            norm = math.hypot(dx, dy) or 1.0
            # 控制点往垂直方向偏一点，走出弧线而不是直线
            ctrl_x = (cur_x + tx) / 2.0 - dy / norm * random.uniform(8, 48)
            ctrl_y = (cur_y + ty) / 2.0 + dx / norm * random.uniform(8, 48)
            for step in range(1, steps + 1):
                k = step / float(steps)
                px = (1 - k) ** 2 * cur_x + 2 * (1 - k) * k * ctrl_x + k * k * tx
                py = (1 - k) ** 2 * cur_y + 2 * (1 - k) * k * ctrl_y + k * k * ty
                path.append([
                    max(0, min(width - 1, int(round(px + random.uniform(-1.8, 1.8))))),
                    max(0, min(height - 1, int(round(py + random.uniform(-1.8, 1.8))))),
                    cur_t + int((end_t - cur_t) * k),
                ])
            cur_x, cur_y, cur_t = float(tx), float(ty), end_t
        return path

    def _build_payload(
        self,
        token: str,
        points: List[Tuple[int, int, int]],
        size: Tuple[int, int],
        started: float,
        trace: Optional[List[List[float]]] = None,
    ) -> Dict[str, str]:
        """按 2.28.5 SDK 的 shouldVerifyCaptcha 分支：

            d   空串
            p   Q(I(token, "x,y,t")...)        每个点击点带时间偏移（毫秒）
            m   Q(I(token, "x,y,t")...)        鼠标轨迹，没有就空
            ext Q(I(token, "点击次数,轨迹长度"))

        t 以前固定发 0（等于图一出现就点中），风控很容易判假；
        现在用真实点击时刻 + 真实轨迹，和浏览器一致。
        """
        ctx = self._ctx_obj()

        path: List[Tuple[int, int, int]] = []
        for item in trace or []:
            try:
                x, y = int(round(float(item[0]))), int(round(float(item[1])))
                stamp = int(round(float(item[2])))
            except (TypeError, ValueError, IndexError):
                continue
            if size[0] and size[1]:
                x = max(0, min(size[0] - 1, x))
                y = max(0, min(size[1] - 1, y))
            path.append((x, y, max(0, stamp)))
        # 轨迹必须包含最后一次点击本身，否则首尾对不上
        if points and (not path or path[-1][:2] != points[-1][:2]):
            path.append(points[-1])

        clicks = [ctx.I(token, "%d,%d,%d" % (x, y, stamp)) for x, y, stamp in points]
        moves = [ctx.I(token, "%d,%d,%d" % (x, y, stamp)) for x, y, stamp in path]
        return {
            "d": "",
            "m": ctx.Q(":".join(moves)),
            "p": ctx.Q(":".join(clicks)),
            "ext": ctx.Q(ctx.I(token, "%d,%d" % (max(len(points), 1), len(path)))),
        }

    def wait(self, timeout: float = WAIT_TIMEOUT, stop_check: Optional[Callable[[], bool]] = None) -> bool:
        """阻塞等待用户完成验证；期间可被 stop_check 打断。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._solved.wait(0.4):
                # cancel() 也会 set，只有拿到 validate 或用户声明已完成才算通过
                with self._lock:
                    return bool(self._validate) or self._confirmed
            if stop_check and stop_check():
                return False
        return False

    def confirm_external(self) -> Dict[str, Any]:
        """用户在浏览器里手工完成了验证，通知引擎直接重试上报。"""
        with self._lock:
            if not self._active:
                return {"ok": False, "message": "当前没有待处理的验证码"}
            self._confirmed = True
            self._active = False
        # 必须先停掉自动识别：否则它这一轮提交会拿到“已过期”，
        # 紧接着按“没点中”换一张新图，把用户刚关掉的验证码又唤回来。
        self._auto_stop.set()
        self._solved.set()
        self.bus.publish({"type": "captcha", "action": "solved"})
        self.bus.log("已按用户确认跳过验证码，重新上报进度", "warn")
        return {"ok": True, "message": "已通知后端重试上报"}

    def cancel(self) -> None:
        self._auto_stop.set()
        with self._lock:
            self._active = False
            self._solved.set()
            self._token = ""
        self.bus.publish({"type": "captcha", "action": "cancelled"})

    def reset(self) -> None:
        self._auto_stop.set()
        with self._lock:
            self._active = False
            self._solved.clear()
            self._token = ""
            self._validate = ""
            self._slide_token = ""
            self._confirmed = False
            self._task = {}

    def validate(self) -> str:
        """易盾返回的 validate；用户走“浏览器已完成”时为空串。"""
        with self._lock:
            return self._validate

    def slide_token(self) -> str:
        """平台登记用的 token（CN31_ 开头）；用户走“浏览器已完成”时为空串。"""
        with self._lock:
            return self._slide_token

    def pending(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "active": self._active,
                "task": self._task,
                "validate": self._validate,
                "auto": {"running": self.auto_running(), "round": self._auto_round,
                        "img": self._img_seq, "point": None},
                "payload": dict(self._payload) if self._active else {},
            }
