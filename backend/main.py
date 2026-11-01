"""智慧树桌面端后端入口（纯 ASGI 应用）。

两种等价的 uvicorn 启动方式：

    cd backend
    python -X utf8 main.py                       # 走文件末尾的 uvicorn.run
    uvicorn main:app --host 127.0.0.1 --port 8765 --timeout-graceful-shutdown 2

Tauri 是用 `python -m uvicorn main:app ...` 拉起后端，退出时整棵进程树一起结束。
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional

import uvicorn

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from core.bus import EventBus
from core.client import ZhsError
from core.engine import MAX_RETRY_LIMIT
from core.config import (
    DEFAULT_PORT,
    clear_session,
    load_credentials,
    load_session,
    save_credentials,
    save_session,
    save_settings,
)
from core.legacy import find_legacy_root
from core.state import AppState

VERSION = "1.3.3"

state = AppState()
bus: EventBus = state.bus

# 自动续播串行化：页面重挂载可能连发两次请求
_restore_lock = threading.Lock()


def _parent_pid() -> int:
    """前端（Tauri）拉起后端时会把自身 PID 传进来，用于进程级看护。"""
    try:
        return int(os.environ.get("ZHS_PARENT_PID", "0") or 0)
    except ValueError:
        return 0


def _process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        SYNCHRONIZE = 0x00100000
        WAIT_TIMEOUT = 0x00000102
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # 必须声明句柄类型：默认 restype 是 c_int，64 位 HANDLE 会被截断，
        # 之后 WaitForSingleObject 返回 WAIT_FAILED，被误判成「父进程已退出」
        # 而把正在学习的后端自杀掉。
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel32.CloseHandle.restype = wintypes.BOOL
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        try:
            # 句柄可打开但进程已退出时，WaitForSingleObject 会立刻返回 0（WAIT_OBJECT_0）
            return kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _shutdown_now() -> None:
    """结束播放线程并立刻退出进程。"""
    try:
        state.engine.stop()
        state.engine.wait_idle(3.0)
    finally:
        os._exit(0)


def _watch_parent(pid: int) -> None:
    """前端被强杀 / 崩溃时（来不及发停止请求），由看护线程结束任务并退出。

    只在前端主动传了 ZHS_PARENT_PID 时启动，手动运行后端不受影响。
    """
    while True:
        time.sleep(2.0)
        if not _process_alive(pid):
            bus.log("前端已退出，正在结束后台学习任务", "warn")
            _shutdown_now()
            return


def _restore_login() -> None:
    """有本地会话就直接恢复登录，打开应用即可看到课程。

    必须放后台线程：uvicorn 在 lifespan 返回前不接受连接，而
    ``login_with_cookie`` 是同步网络请求（连接 10s + 读取 10s），
    冷启动或离线时会把前端的启动探测拖到超时，误报「后端没起来」。
    """
    try:
        profile = state.auth.login_with_cookie()
        if profile:
            bus.log("已用本地会话恢复登录：%s" % profile.get("name", ""), "success")
            _sync_courses_soft(force=True)
    except Exception as exc:
        bus.log("恢复本地会话失败：%s" % exc, "warn")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    threading.Thread(target=_restore_login, name="zhs-restore-login", daemon=True).start()

    parent = _parent_pid()
    if parent > 0:
        threading.Thread(target=_watch_parent, args=(parent,), daemon=True).start()

    bus.log("后端服务已启动", "info")
    try:
        yield
    finally:
        # 关闭时停掉播放线程并断开事件订阅，保证 Ctrl+C / 关窗一次就能退出
        try:
            state.engine.stop()
            state.engine.wait_idle(3.0)
        except Exception:
            pass


app = FastAPI(title="Zhihuishu Desk API", version=VERSION, lifespan=lifespan)

# 只信任桌面端自身的来源：
# - 生产环境是 Tauri 的自定义协议页面（不同平台大小写/协议略有差异）
# - 开发环境是 Vite 的固定端口 5183
# 这样浏览器中任意网页都无法跨域读写本机 8765 端口。
ALLOWED_ORIGINS = [
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
    "http://127.0.0.1:5183",
    "http://localhost:5183",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.exception_handler(ZhsError)
def _zhs_error_handler(_: Request, exc: ZhsError) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(RuntimeError)
def _runtime_error_handler(_: Request, exc: RuntimeError) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(Exception)
def _unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """兜底：没被具体 handler 接住的异常记一条本地日志，同时回一句能看懂的话。

    只回「已记录日志」而不是 str(exc)：未预期异常的信息对用户没用，
    还可能带出内部实现细节。
    """
    bus.log("接口异常：%s %s（%s: %s）" % (request.method, request.url.path,
                                        type(exc).__name__, exc), "error")
    return JSONResponse({"detail": "服务内部错误，已记录日志"}, status_code=500)


# --------------------------------------------------------------------- 模型
class LoginBody(BaseModel):
    username: str = ""
    password: str = ""
    auto_solve: bool = True
    remember: bool = False


class RatioBody(BaseModel):
    ratio: float = Field(ge=0, le=100)


class PointsBody(BaseModel):
    """学习页验证码：背景图原始像素坐标，按点击顺序。

    trace 为鼠标移动轨迹，同样是 [x, y, t]，t 是相对图出现时刻的毫秒数。
    """

    points: List[List[float]] = Field(default_factory=list)
    trace: List[List[float]] = Field(default_factory=list)


class CourseBody(BaseModel):
    course_id: str


class StartBody(BaseModel):
    task_ids: List[str] = Field(default_factory=list)
    speed: float = 1.0
    # 单集“播放本节”：跳过所有过滤，强制重播这一条
    replay_completed: bool = False
    strict_full: bool = False


class SettingsBody(BaseModel):
    # 上下界必须和引擎里的 clamp 一致：网速/重试次数会直接放大请求量，
    # 没有上界时一个 max_retry=1000 就能把单块上报放大成千次请求。
    speed: Optional[float] = Field(default=None, ge=1, le=3)
    auto_solve: Optional[bool] = None
    strict_full: Optional[bool] = None
    remember_password: Optional[bool] = None
    max_retry: Optional[int] = Field(default=None, ge=1, le=MAX_RETRY_LIMIT)
    log_api: Optional[bool] = None


# --------------------------------------------------------------------- 基础
@app.get("/api/health")
def health() -> Dict[str, Any]:
    root = find_legacy_root()
    return {
        "ok": True,
        "version": VERSION,
        "authenticated": bool(state.auth.profile),
        "engine": state.engine.status,
        "legacy_root": str(root) if root else "",
    }


@app.get("/api/state")
def get_state() -> Dict[str, Any]:
    return state.snapshot()


@app.get("/api/events")
async def events(request: Request) -> StreamingResponse:
    """SSE 事件流。

    必须是 async generator：同步 generator 会被丢到线程池里跑 ``while True``，
    uvicorn 关闭时会一直等它结束，表现为进程关不掉。
    """
    async def stream() -> AsyncIterator[str]:
        # 订阅放进生成器里：客户端拿到响应就断开时，生成器可能一次都没被迭代，
        # 订阅若在外面注册，bus 里会永久留下一个没人消费的队列。
        subscriber = bus.subscribe()
        try:
            yield ": connected\n\n"
            while not await request.is_disconnected():
                try:
                    event = await asyncio.to_thread(subscriber.get, True, 1)
                except queue.Empty:
                    yield ": ping\n\n"
                    continue
                yield "data: %s\n\n" % json.dumps(event, ensure_ascii=False)
        except asyncio.CancelledError:
            raise
        finally:
            bus.unsubscribe(subscriber)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# --------------------------------------------------------------------- 登录
_courses_lock = threading.Lock()


def _sync_courses(force: bool = False) -> List[Dict[str, Any]]:
    if not state.auth.client:
        raise HTTPException(status_code=401, detail="请先登录")
    # 串行化：启动时后台同步与前端手动刷新可能同时到达，避免重复请求互相覆盖
    with _courses_lock:
        if force or not state.courses:
            bus.log("正在同步课程列表…")
            state.courses = state.auth.client.get_courses()
            bus.log("已同步 %d 门课程" % len(state.courses), "success")
        return state.courses


def _sync_courses_soft(force: bool = True) -> None:
    """登录后同步课程；失败只记日志，不让登录本身失败。"""
    try:
        _sync_courses(force=force)
    except (ZhsError, HTTPException) as exc:
        detail = getattr(exc, "detail", None) or str(exc)
        bus.log("课程列表同步失败：%s（可稍后在课程页刷新）" % detail, "warn")


def _login_ok(profile: Dict[str, Any]) -> Dict[str, Any]:
    """登录成功的统一出口：同步课程后再返回，避免前端看到空课程列表。"""
    _sync_courses_soft(force=True)
    return {"status": "ok", "profile": profile}


@app.post("/api/auth/login")
def login(body: LoginBody) -> Dict[str, Any]:
    username = body.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="请输入账号")

    state.settings.update(
        {
            "auto_solve": bool(body.auto_solve),
            "remember_password": bool(body.remember),
        }
    )
    save_settings(state.settings)

    if not body.remember:
        # 取消勾选“记住密码”时，同步清掉本地已保存的密码，下次不再自动填充
        saved = load_credentials()
        if saved.get("password"):
            saved.pop("password", None)
            save_credentials(saved)

    if not body.password:
        profile = state.auth.login_with_cookie(username)
        if profile:
            bus.log("已使用本地会话自动登录", "success")
            return _login_ok(profile)
        raise HTTPException(status_code=400, detail="密码不能为空")

    profile = state.auth.login_with_cookie(username)
    if profile:
        bus.log("已使用本地会话自动登录", "success")
        return _login_ok(profile)

    if body.auto_solve:
        # 只让后端拉一张验证码：识别 -> 校验一次，失败立刻换图交给手动窗口
        bus.log("正在自动识别滑块验证码…")
        try:
            result = state.auth.auto_login(username, body.password, body.remember)
        except ZhsError as exc:
            # 拉图 / 校验阶段的网络异常，给出可读提示而不是让请求直接失败
            bus.log("自动验证失败：%s" % exc, "warn")
            return {"status": "error", "message": str(exc)}

        if result.get("ok") and result.get("profile"):
            return _login_ok(result["profile"])
        if result.get("captcha_ok"):
            # 滑块已经通过，失败原因是账号本身，不必再让用户拖一次
            return {"status": "error", "message": result.get("message") or "登录失败"}
        try:
            captcha = state.auth.refresh_captcha()
        except ZhsError as exc:
            bus.log("获取验证码失败：%s" % exc, "warn")
            return {"status": "error", "message": "验证码获取失败，请稍后重试"}
        return {
            "status": "captcha",
            "captcha": captcha,
            "message": result.get("message") or "自动验证未通过，请手动完成滑块验证",
        }

    bus.log("开始登录，正在获取验证码…")
    captcha = state.auth.start_captcha(username, body.password, body.remember)
    return {"status": "captcha", "captcha": captcha, "message": ""}


@app.post("/api/auth/captcha/new")
def new_captcha() -> Dict[str, Any]:
    return state.auth.refresh_captcha()


@app.get("/api/auth/credentials")
def saved_credentials() -> Dict[str, Any]:
    """读取本机保存的账号密码，供登录页自动填充。

    仅当用户勾选过“记住密码”时才返回密码；未勾选或已清除时返回空串。
    """
    saved = load_credentials()
    remember = bool(state.settings.get("remember_password"))
    return {
        "username": saved.get("username", ""),
        # 未开启“记住密码”时即使文件里有残留也不返回，避免登录页自动填充
        "password": saved.get("password", "") if remember else "",
        "remember": remember and bool(saved.get("password")),
    }


@app.post("/api/auth/captcha/solve")
def solve_captcha() -> Dict[str, Any]:
    return state.auth.auto_solve()


@app.post("/api/auth/captcha/submit")
def submit_captcha(body: RatioBody) -> Dict[str, Any]:
    result = state.auth.submit_captcha(body.ratio)
    if result.get("ok") and result.get("profile"):
        _sync_courses_soft(force=True)
        return {"ok": True, "message": result.get("message", "登录成功"), "profile": result["profile"]}
    if result.get("expired"):
        # 后端状态已丢失（例如重启过），此时无法再换图，直接让前端回到登录页重来
        return {"ok": False, "expired": True, "message": result.get("message", "验证码已过期，请重新登录")}
    if result.get("captcha_ok"):
        # 滑块已通过，失败原因是账号或密码本身：不换图，直接回显错误
        return {"ok": False, "message": result.get("message") or "登录失败"}
    # 滑块未通过才换一张，避免复用已失效的 token
    try:
        captcha = state.auth.refresh_captcha()
    except ZhsError as exc:
        bus.log("获取验证码失败：%s" % exc, "warn")
        return {"ok": False, "message": "验证码获取失败，请关闭后重新登录"}
    return {
        "ok": False,
        "message": "验证未通过，已换一张，请重新拖动滑块",
        "captcha": captcha,
    }


# ------------------------------------------------------- 学习页人机验证（空间推理）
@app.post("/api/captcha/study/refresh")
def study_captcha_refresh() -> Dict[str, Any]:
    """换一张学习页验证码（用户在弹窗里点“换一张”）。

    传 ``auto=False, notify=False``：这个按钮只在手动模式下出现，用户既然已经
    接手自己点，换图就不该又把自动识别拉起来，也不该再弹一次「平台要求人机验证」
    的提示——新图直接由返回值带回去渲染即可。
    """
    task = state.captcha.pending().get("task") or {}
    return state.captcha.begin(task, auto=False, notify=False)


@app.post("/api/captcha/study/submit")
def study_captcha_submit(body: PointsBody) -> Dict[str, Any]:
    """提交用户点选的坐标（背景图原始像素）。"""
    result = state.captcha.submit(body.points, body.trace)
    if result.get("expired"):
        # 图上的 token 已失效（比如后端重启过），顺手换一张，别让用户在死图上继续点。
        # 同上：这是手动提交走到的分支，别顺手把自动识别拉起来，也别重复推事件
        # （新图随返回值给前端，少一次 setState 和一次抢前台的提示）。
        task = state.captcha.pending().get("task") or {}
        try:
            result["captcha"] = state.captcha.begin(task, auto=False, notify=False)
            result["message"] = "原图已失效，已换一张，请重新点选"
        except ZhsError as exc:
            result["message"] = "验证码已失效，重新获取失败：%s" % exc
    return result


@app.post("/api/captcha/study/retry")
def study_captcha_retry() -> Dict[str, Any]:
    """用户在浏览器里完成验证后，通知引擎重试本轮上报。"""
    return state.captcha.confirm_external()


@app.post("/api/captcha/study/auto/stop")
def study_captcha_auto_stop() -> Dict[str, Any]:
    """用户想自己点：停掉自动识别，保留当前这张图。"""
    return state.captcha.stop_auto()


@app.get("/api/captcha/study/pending")
def study_captcha_pending() -> Dict[str, Any]:
    return state.captcha.pending()


@app.post("/api/auth/logout")
def logout() -> Dict[str, Any]:
    state.captcha.cancel()
    state.engine.stop()
    # 只等一会儿：线程是 daemon，logout 不应让界面卡住
    state.engine.wait_idle(1.0)
    state.session = {}
    clear_session()
    state.auth.logout()
    state.courses = []
    state.reset_course()
    bus.log("已退出登录", "warn")
    return {"ok": True}


# --------------------------------------------------------------------- 课程
@app.get("/api/courses")
def courses(force: bool = False) -> Dict[str, Any]:
    items = _sync_courses(force=force)
    return {"courses": items}


@app.post("/api/courses/select")
def select_course(body: CourseBody) -> Dict[str, Any]:
    client = state.auth.client
    if client is None:
        raise HTTPException(status_code=401, detail="请先登录")
    # 播放中切换课程会让引擎持有旧任务引用，前后端状态会脱节，直接拒绝
    if state.engine.status != "idle":
        raise HTTPException(status_code=409, detail="请先停止当前播放再切换课程")

    items = state.courses or _sync_courses()
    course = next((c for c in items if str(c["id"]) == str(body.course_id)), None)
    if course is None:
        raise HTTPException(status_code=404, detail="课程不存在，请刷新课程列表")

    bus.log("正在加载《%s》的任务…" % course["name"])
    detail = client.select_course(course["secret"], course["name"])

    state.course = {
        "id": course["id"],
        "name": course["name"],
        "school": course.get("school", ""),
        "term": course.get("term", ""),
        "cover": course.get("cover", ""),
        "recruit_id": detail.get("recruit_id"),
        "course_id": detail.get("course_id"),
    }
    state.tasks = detail["tasks"]
    state.chapters = detail["chapters"]

    done = sum(1 for task in state.tasks if task.get("completed"))
    bus.log(
        "《%s》共 %d 个视频，已完成 %d 个" % (course["name"], len(state.tasks), done),
        "success",
    )
    return {**detail, "course": state.course}


@app.post("/api/courses/refresh")
def refresh_course() -> Dict[str, Any]:
    if not state.course:
        raise HTTPException(status_code=400, detail="请先选择课程")
    return select_course(CourseBody(course_id=str(state.course["id"])))


@app.post("/api/courses/progress")
def refresh_progress() -> Dict[str, Any]:
    """轻量同步：只重查学习进度，不重新拉取课程与章节结构（1 次请求）。"""
    client = state.auth.client
    if client is None:
        raise HTTPException(status_code=401, detail="请先登录")
    if not state.course:
        raise HTTPException(status_code=400, detail="请先选择课程")

    fresh = client.get_study_info()
    state.chapters = client.chapters
    if state.engine.status == "idle":
        state.tasks = fresh
    else:
        # 播放中不能换掉这批 dict：引擎持有的是 state.tasks 里的对象，
        # 一替换就变成「引擎往旧对象写进度，/api/state 永远读到服务端快照」。
        bus.log("播放中刷新进度：界面仍以引擎的实时进度为准", "info")
    return {"course": state.course, "tasks": state.tasks, "chapters": state.chapters}


# --------------------------------------------------------------------- 播放
@app.post("/api/engine/start")
def engine_start(body: StartBody) -> Dict[str, Any]:
    if state.auth.client is None:
        raise HTTPException(status_code=401, detail="请先登录")
    if not state.tasks:
        raise HTTPException(status_code=400, detail="请先选择课程")

    save_settings({"speed": body.speed, "strict_full": body.strict_full})
    state.settings["speed"] = body.speed
    state.settings["strict_full"] = body.strict_full

    snapshot = state.engine.start(
        state.auth.client,
        state.tasks,
        body.task_ids,
        speed=body.speed,
        replay_completed=body.replay_completed,
        max_retry=int(state.settings.get("max_retry") or 5),
        strict_full=body.strict_full,
    )

    # 记住本次队列：关掉前端时任务会被停止，下次打开据此自动续播
    state.session = {
        "course_id": str((state.course or {}).get("id") or ""),
        "course_name": (state.course or {}).get("name", ""),
        "task_ids": [str(tid) for tid in body.task_ids],
        "speed": snapshot.get("speed") or body.speed,
        "strict_full": bool(body.strict_full),
        "updated_at": int(time.time()),
    }
    save_session(state.session)
    return {"ok": True, "engine": snapshot}


@app.post("/api/engine/pause")
def engine_pause() -> Dict[str, Any]:
    return {"ok": True, "engine": state.engine.pause()}


@app.post("/api/engine/resume")
def engine_resume() -> Dict[str, Any]:
    return {"ok": True, "engine": state.engine.resume()}


@app.post("/api/engine/stop")
def engine_stop(keep_session: bool = False) -> Dict[str, Any]:
    """停止播放。前端关窗时用 keep_session=true 保留队列，下次打开自动续播。"""
    snapshot = state.engine.stop()
    if not keep_session:
        state.session = {}
        clear_session()
    return {"ok": True, "engine": snapshot}


def _ensure_session_course(session: Dict[str, Any], client: Any) -> None:
    """续播前确保课程上下文可用（后端重启后内存里的课程会被清空）。"""
    course_id = str(session.get("course_id") or "")
    current = str((state.course or {}).get("id") or "")
    if state.tasks and (not course_id or course_id == current):
        return

    items = state.courses or client.get_courses()
    state.courses = items
    course = next((c for c in items if str(c.get("id")) == course_id), None)
    if course is None:
        raise ZhsError("上次学习的课程已不在课程列表中")

    bus.log("正在恢复《%s》的学习任务…" % course.get("name", ""), "info")
    detail = client.select_course(course["secret"], course["name"])
    state.course = {
        "id": course["id"],
        "name": course["name"],
        "school": course.get("school", ""),
        "term": course.get("term", ""),
        "cover": course.get("cover", ""),
        "recruit_id": detail.get("recruit_id"),
        "course_id": detail.get("course_id"),
    }
    state.tasks = detail["tasks"]
    state.chapters = detail["chapters"]


def _restore_session() -> Dict[str, Any]:
    client = state.auth.client
    session = state.session or load_session()
    if client is None or not session:
        return {"ok": False, "restored": False, "engine": state.engine.snapshot()}
    state.session = session

    try:
        _ensure_session_course(session, client)
        wanted = {str(tid) for tid in session.get("task_ids") or []}
        pending = [task for task in state.tasks if str(task["id"]) in wanted and not task.get("completed")]
        if not pending:
            state.session = {}
            clear_session()
            return {"ok": False, "restored": False, "engine": state.engine.snapshot()}

        snapshot = state.engine.start(
            client,
            state.tasks,
            [str(task["id"]) for task in pending],
            speed=float(session.get("speed") or state.settings.get("speed") or 1.0),
            max_retry=int(state.settings.get("max_retry") or 5),
            strict_full=bool(session.get("strict_full", state.settings.get("strict_full", False))),
        )
    except ZhsError as exc:
        if "正在运行" in str(exc):
            # 用户刚好点了“开始学习”，续播让位即可，不用报一条失败
            return {"ok": True, "restored": False, "engine": state.engine.snapshot()}
        bus.log("自动续播失败：%s" % exc, "warn")
        return {"ok": False, "restored": False, "engine": state.engine.snapshot(), "message": str(exc)}

    session["task_ids"] = [str(task["id"]) for task in pending]
    state.session = session
    save_session(session)
    bus.log("已自动续播上次未完成的任务", "success")
    return {"ok": True, "restored": True, "engine": snapshot}


@app.post("/api/engine/restore")
def engine_restore() -> Dict[str, Any]:
    """前端重新打开时自动续播上次被关闭中断的队列。

    页面重挂载可能连发两次，也可能和用户点“开始学习”撞在一起：
    这里只放一个请求进来，其余的按“已在运行”直接返回，界面不再出现失败提示。
    """
    if not _restore_lock.acquire(blocking=False):
        # 已有一次续播在跑（可能正卡在网络上）：让位，别重复拉起课程列表
        bus.log("已有续播请求在处理，跳过本次自动续播", "info")
        return {"ok": True, "restored": False, "engine": state.engine.snapshot()}
    try:
        if state.engine.status in ("running", "paused", "stopping"):
            return {"ok": True, "restored": False, "engine": state.engine.snapshot()}
        return _restore_session()
    finally:
        _restore_lock.release()


# --------------------------------------------------------------------- 设置
@app.post("/api/settings")
def update_settings(body: SettingsBody) -> Dict[str, Any]:
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if patch.get("remember_password") is False:
        # 关闭“记住密码”时同步清掉本地保存的密码
        saved = load_credentials()
        if saved.get("password"):
            saved.pop("password", None)
            save_credentials(saved)
    state.settings = save_settings(patch)
    return {"settings": state.settings}


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=DEFAULT_PORT,
        timeout_graceful_shutdown=2,
    )
