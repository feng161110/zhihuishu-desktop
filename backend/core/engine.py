"""可视化播放引擎：支持单集播放、批量排队、暂停 / 继续 / 停止。"""

from __future__ import annotations

import random
import threading
import time
from typing import Any, Dict, List, Optional, Set, TYPE_CHECKING

from .bus import EventBus
from .client import ZhsClient, ZhsError, build_ev, hms_to_seconds, seconds_to_hms

if TYPE_CHECKING:
    from .study_captcha import StudyCaptcha


# 平台正常返回的文案，不需要逐条写进界面日志
NORMAL_MESSAGES = ("", "请求成功", "success")

# 同一道弹窗题最多尝试几轮。封顶是因为 _handle_popups 每秒被调一次，
# 不封顶就会一直重打接口。用完这几轮还拿不到答案，就在最后一轮随机选一个：
# 「答错」只是丢分，「未作答」在平台那边是异常记录，后者代价大得多。
# 上报重试次数的硬上限（用户可配，但不能无边）。
# 它会与 _request 的网络重试相乘，给多大就等于允许成倍放大请求量。
MAX_RETRY_LIMIT = 10

POPUP_MAX_TRIES = 6

# 失败之后隔多久再试（秒），按已试轮次取。
# 之前是每个心跳（1 秒）都重打一遍，6 轮全挤在 5 秒内，比不重试更像刷接口。
POPUP_RETRY_BACKOFF = (8, 16, 30, 60)

# 每隔多少个进度块（每块 10 秒）重新拉一次弹窗清单。
# 每块都拉等于把请求量翻倍，6 块（约 1 分钟视频）一次足够捕捉平台中途加的题。
POPUP_REFRESH_EVERY = 6

# 进度上报的节奏：每 BLOCK_SECONDS 秒上报一次，每次带 BLOCK_HEARTBEATS 个心跳。
# 这两个数必须自洽——心跳数就是这一块推进的秒数，否则上报的学习时长会和视频时长对不上。
BLOCK_SECONDS = 10
BLOCK_HEARTBEATS = 10


class _Stopped(Exception):
    """内部信号：用户主动停止。"""


class _Skipped(Exception):
    """内部信号：严格模式下已看满 100%，本条无需再播。"""


def _watched_enough(task: Dict[str, Any]) -> bool:
    """课程列表数据是否已显示看满。只作快判，实时进度仍会在 _play_task 里复核。"""
    total = int(task.get("video_sec") or 0)
    return total > 0 and int(task.get("studied") or 0) >= total


class PlayEngine:
    def __init__(self, bus: EventBus, captcha: Optional["StudyCaptcha"] = None) -> None:
        self.bus = bus
        # 学习页人机验证（-12）：由外部注入，未注入时遇到 -12 直接报错
        self._captcha = captcha
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._gate = threading.Event()
        self._gate.set()
        self._thread: Optional[threading.Thread] = None

        self._client: Optional[ZhsClient] = None
        # 本次运行已作答的弹窗题（去重 + 收尾补答用）
        self._popup_done: Set[str] = set()
        # 每道题已经试过几轮，封顶见 POPUP_MAX_TRIES
        self._popup_tries: Dict[str, int] = {}
        # 每道题下一次允许尝试的时间戳，间隔见 POPUP_RETRY_BACKOFF
        self._popup_next_try: Dict[str, float] = {}
        # 距离上次刷新弹窗清单过了多少块
        self._popup_refresh_tick = 0
        self._max_retry = 5
        # 单集“播放本节”等场景强制重播，不受“已完成 / 已看满”过滤
        self._replay_completed = False
        # 是否严格按“实际看满 100%”判定（勾选后跳过与收手用同一把尺子）
        self._strict_full = False

        self.status = "idle"
        self.speed = 1.0
        self.current_id: Optional[str] = None
        self.current: Dict[str, Any] = {
            "task_id": None,
            "name": "",
            "watched": 0,
            "total": 0,
            "block": 0,
            "blocks": 0,
        }
        self.queue: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------ 对外
    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            finished = sum(1 for q in self.queue if q["status"] in ("done", "skipped", "failed", "stopped"))
            return {
                "status": self.status,
                "speed": self.speed,
                "current": dict(self.current),
                "queue": [dict(item) for item in self.queue],
                "total": len(self.queue),
                "finished": finished,
            }

    def start(
        self,
        client: ZhsClient,
        tasks: List[Dict[str, Any]],
        task_ids: List[str],
        speed: float = 1.0,
        replay_completed: bool = False,
        max_retry: int = 5,
        strict_full: bool = False,
    ) -> Dict[str, Any]:
        with self._lock:
            if self.status in ("running", "paused", "stopping"):
                raise ZhsError("已有任务正在运行，请先停止")

            index = {str(task["id"]): task for task in tasks}
            # 去重且保序：重复的 id 会在队列里留下第二条永远 pending 的记录，
            # finished/total 永远对不上，同一视频还会被播两遍。
            seen: Set[str] = set()
            picked: List[Dict[str, Any]] = []
            for tid in task_ids:
                key = str(tid)
                if key in seen or key not in index:
                    continue
                seen.add(key)
                picked.append(index[key])
            if not picked:
                raise ZhsError("请先选择要学习的视频")

            self._client = client
            # 让请求层感知停止信号：断网时点停止不必等重试跑完（见 ZhsClient._request）
            client.cancel_event = self._stop
            self.speed = max(1.0, min(3.0, float(speed or 1.0)))
            self._replay_completed = bool(replay_completed)
            self._strict_full = bool(strict_full)
            # 重试次数必须有上界：它会和 _request 的网络重试相乘，
            # 一个 1000 就能把单块上报放大成几千个请求。
            self._max_retry = max(1, min(MAX_RETRY_LIMIT, int(max_retry or 5)))
            self._stop.clear()
            self._gate.set()
            self.status = "running"
            self.current_id = None
            self.current = {"task_id": None, "name": "", "watched": 0, "total": 0, "block": 0, "blocks": 0}
            # 本次运行已作答的弹窗题，用来去重和收尾补答
            self._popup_done = set()
            self._popup_tries = {}
            self._popup_next_try = {}
            self.queue = [
                {
                    "task_id": str(task["id"]),
                    "name": task["name"],
                    "status": "pending",
                    "watched": int(task.get("studied") or 0),
                    "total": int(task.get("video_sec") or 0),
                }
                for task in picked
            ]

        self._emit_state()
        self._thread = threading.Thread(target=self._run, args=(picked,), daemon=True)
        self._thread.start()
        return self.snapshot()

    def pause(self) -> Dict[str, Any]:
        """挂起播放线程：进度不再推进，也不会再向服务端上报。"""
        task_id: Optional[str] = None
        with self._lock:
            if self.status != "running":
                return self.snapshot()
            self._gate.clear()
            self.status = "paused"
            current_id = self.current_id
            # 只有真正在播的那一项才改成 paused，避免覆盖刚完成的 done 状态
            if current_id and any(
                item["task_id"] == current_id and item["status"] == "playing" for item in self.queue
            ):
                task_id = current_id
        self.bus.log("已暂停", "warn")
        if task_id:
            self._set_queue(task_id, "paused")
        else:
            self._emit_state()
        return self.snapshot()

    def resume(self) -> Dict[str, Any]:
        task_id: Optional[str] = None
        with self._lock:
            if self.status != "paused":
                return self.snapshot()
            self._gate.set()
            self.status = "running"
            current_id = self.current_id
            if current_id and any(
                item["task_id"] == current_id and item["status"] == "paused" for item in self.queue
            ):
                task_id = current_id
        self.bus.log("继续播放", "info")
        if task_id:
            self._set_queue(task_id, "playing")
        else:
            self._emit_state()
        return self.snapshot()

    def stop(self) -> Dict[str, Any]:
        with self._lock:
            if self.status not in ("running", "paused"):
                return self.snapshot()
            self.status = "stopping"
            self._stop.set()
            self._gate.set()
        self.bus.log("正在停止…", "warn")
        self._emit_state()
        return self.snapshot()

    def wait_idle(self, timeout: float = 5.0) -> bool:
        """等待播放线程真正退出（关闭 / 退出进程前调用，避免任务在后台继续跑）。"""
        thread = self._thread
        if thread is None:
            return True
        thread.join(timeout)
        return not thread.is_alive()

    # ------------------------------------------------------------------ 线程体
    def _run(self, picked: List[Dict[str, Any]]) -> None:
        try:
            for task in picked:
                if self._stop.is_set():
                    break
                task_id = str(task["id"])

                # 非严格模式：以平台判定为准，已完成的任务直接跳过，不再拉进度。
                # 判定放在“标记播放中”之前，避免被跳过的任务在界面上闪现一下播放状态。
                if not self._replay_completed and not self._strict_full and task.get("completed"):
                    self.bus.log("平台判定已完成，跳过：%s" % task["name"], "warn")
                    self._set_queue(task_id, "skipped")
                    continue
                # 严格模式：列表里已显示看满的同样先跳过，省掉一次进度的网络请求
                if not self._replay_completed and self._strict_full and _watched_enough(task):
                    self.bus.log("已看满 100%%，跳过：%s" % task["name"], "warn")
                    self._set_queue(task_id, "skipped")
                    continue

                try:
                    played = self._play_task(task)
                    self._set_queue(task_id, "done", played)
                    self.bus.log("已完成：%s" % task["name"], "success")
                except _Skipped:
                    self._set_queue(task_id, "skipped")
                    continue
                except _Stopped:
                    self._set_queue(task_id, "stopped")
                    break
                except Exception as exc:
                    self._set_queue(task_id, "failed")
                    self.bus.log("%s 学习失败：%s" % (task["name"], exc), "error")

                if self._stop.is_set():
                    break
                if not self._sleep(random.uniform(1.2, 2.8)):
                    break
        finally:
            # 必须摘掉停止信号：_stop 在 stop() 后会一直保持置位，
            # 若 client 还挂着它，任务结束后所有正常请求（刷新课程、切课程）都会被判「已停止」。
            if self._client is not None:
                self._client.cancel_event = None
            with self._lock:
                self.status = "idle"
                self.current_id = None
                self.current = {"task_id": None, "name": "", "watched": 0, "total": 0, "block": 0, "blocks": 0}
            self._emit_state()
            self.bus.log("队列已结束", "info")

    def _begin_task(self, task: Dict[str, Any]) -> None:
        """确认要播之后才点亮“播放中”；跳过检查期间队列保持 pending，避免界面闪烁。"""
        task_id = str(task["id"])
        with self._lock:
            self.current_id = task_id
            self.current = {
                "task_id": task_id,
                "name": task["name"],
                "watched": int(task.get("studied") or 0),
                "total": int(task.get("video_sec") or 0),
                "block": 0,
                "blocks": 0,
            }
        # _set_queue 内部已经推送状态，这里不必再 emit 一次
        self._set_queue(task_id, "playing")

    def _play_task(self, task: Dict[str, Any]) -> int:
        client = self._client
        if client is None:
            raise ZhsError("登录状态已失效，请重新登录")

        self._check_stop()
        if not self._wait_if_paused():
            raise _Stopped()
        total = int(task.get("video_sec") or 0)
        if total <= 0:
            raise ZhsError("视频时长异常，已跳过")

        progress = client.pre_learning_note(task)
        # 网络请求期间用户可能已经点了暂停：返回后立刻挂起，不再继续推进
        if not self._wait_if_paused():
            raise _Stopped()
        start_at = int(progress.get("studyTotalTime") or 0)
        if start_at <= 0:
            start_at = hms_to_seconds(progress.get("learnTime"))
        if start_at <= 0:
            start_at = int(task.get("studied") or 0)
        start_at = min(start_at, total)

        # 严格模式：跳过与收手都用同一把尺子——实际看满时长才算完成。
        # 平台常提前判完成，所以这里不能信 task["completed"]，要看实时进度。
        if not self._replay_completed and self._strict_full and start_at >= total:
            self.bus.log("已看满 100%%，跳过：%s" % task["name"], "warn")
            raise _Skipped()

        self._begin_task(task)
        self.bus.log("开始学习：%s（%s）" % (task["name"], seconds_to_hms(total)))

        popups = client.get_pop_up_exam_list(task.get("big_id"), task.get("small_id"))
        # 这一集已经推进了多少块，用来控制清单刷新频率（见 POPUP_REFRESH_EVERY）
        self._popup_refresh_tick = 0
        if not self._wait_if_paused():
            raise _Stopped()
        context: List[Any] = [
            client.recruit_id,
            task.get("big_id"),
            task.get("small_id"),
            task.get("video_id"),
            task.get("chapter_id"),
            "0",
            0,
            start_at,
            str(progress.get("learnTime") or "00:00:00"),
            (client.uuid or "") + "zhs",
        ]

        # 必须向上取整：round 会把 105 秒算成 10 块，只播到 100 秒，
        # 严格模式下永远差最后几秒，平台仍判未完成。
        total_blocks = max(1, (total + BLOCK_SECONDS - 1) // BLOCK_SECONDS)
        start_block = min(int(start_at // BLOCK_SECONDS), total_blocks - 1)
        watched = start_at
        # 日志节奏：每 60 秒视频时间写一条，避免每 10 秒刷一行“请求成功”
        last_logged = watched
        self.current["blocks"] = total_blocks
        self.current["watched"] = watched
        self.current["total"] = total

        for block in range(start_block, total_blocks):
            self._check_stop()
            if not self._wait_if_paused():
                raise _Stopped()
            self.current["block"] = block
            context[6] = 0
            context[7] = watched
            watch_points = ["0", "1"]

            # 块内心跳次数必须和「每块 10 秒」对齐。
            # 原来这里是 <= 10（11 次），watched 每块多走 1 秒，
            # 于是上报的学习时长比视频本身长约 10%（100 秒的视频报成 1:50），
            # 平台一眼就能看出「观看时长超过视频时长」，判成异常。
            # 最后一块可能不满 10 秒：按视频总长收尾，别走满 10 拍虚增时长
            while int(context[6]) < BLOCK_HEARTBEATS and watched < total:
                if not self._tick(1.0 / self.speed):
                    raise _Stopped()
                context[6] = int(context[6]) + 1
                context[7] = int(context[7]) + 1
                watched = int(context[7])
                context[8] = seconds_to_hms(context[7])
                watch_points.append(str(round(watched / 5) + 2))

                self.current["watched"] = min(watched, total)
                self._emit_progress(task["id"], min(watched, total), total)
                self._handle_popups(popups, task, watched)

            # 定期刷新弹窗清单：平台可能在播放过程中才给这一节挂上弹窗题，
            # 只在开头拉一次的话后面新增的题就永远看不到。
            # 但不能每块都拉——那是每 10 视频秒多一次请求，等于把请求量翻倍，
            # 反而更容易招风控。这里按 POPUP_REFRESH_EVERY 块拉一次。
            self._popup_refresh_tick += 1
            if self._popup_refresh_tick >= POPUP_REFRESH_EVERY:
                self._popup_refresh_tick = 0
                try:
                    fresh = client.get_pop_up_exam_list(task.get("big_id"), task.get("small_id"))
                except Exception as exc:  # noqa: BLE001  刷新失败不影响正在播的视频
                    self.bus.log("刷新弹窗清单失败：%s" % exc, "warn")
                    fresh = None
                if fresh:
                    known = {self._popup_key(p) for p in popups}
                    added = [p for p in fresh if self._popup_key(p) not in known]
                    if added:
                        popups.extend(added)
                        self.bus.log("补到 %d 道新弹窗题" % len(added), "info")

            # 兜底：上报的学习时长不允许超过视频本身长度。
            # 平台会比对 learnTime 和视频时长，超了就是很典型的「异常观看」特征。
            if int(context[7]) > total:
                context[7] = total
                context[8] = seconds_to_hms(total)
            post_data = {
                "ewssw": ",".join(watch_points),
                "sdsew": ZhsClient.playing_encrypt(context),
                "zwsds": self._encode_note_id(progress.get("id")),
                "courseId": client.course_id,
            }
            payload = self._save_interval(post_data)
            if payload.get("code") == -12:
                # 平台要求人机验证：拉图交给前端，用户点完再重试这一轮上报
                payload = self._solve_captcha(post_data, task)
            message = str(payload.get("message") or "")
            watched_now = min(watched, total)
            if message and message not in NORMAL_MESSAGES:
                # 平台给出了具体提示（限流、时长已结束等）才值得当场说
                self.bus.log(
                    "进度 %s / %s · %s" % (seconds_to_hms(watched_now), seconds_to_hms(total), message),
                    "warn",
                )
                last_logged = watched_now
            elif watched_now - last_logged >= 60 or watched_now >= total:
                self.bus.log("进度 %s / %s" % (seconds_to_hms(watched_now), seconds_to_hms(total)), "info")
                last_logged = watched_now

            # 平台常在进度接近但不到 100% 时就判完成：
            # 未开启“严格 100%”时及时收手进下一条，开启时继续播到时长末尾。
            if not self._strict_full and ZhsClient.platform_completed(payload):
                self.bus.log("平台已判定完成，直接进入下一条（需要看满 100% 请勾选“严格 100%”）", "info")
                break

        # 收尾兜底：把「本该出现但没答上」的弹窗题补齐。
        # 平台按弹窗题的完成情况判定学习是否正常，漏一道就可能被记成「异常」。
        try:
            self._sweep_popups(popups, task, watched)
        except Exception as exc:  # noqa: BLE001  补答失败不能把整条视频判成失败
            self.bus.log("收尾补答弹窗题出错：%s" % exc, "warn")

        watched = min(watched, total)
        task["completed"] = True
        task["watch_state"] = 1
        task["studied"] = watched
        self.bus.publish(
            {
                "type": "task",
                "task": {
                    "id": task["id"],
                    "completed": True,
                    "watch_state": 1,
                    "studied": watched,
                },
            }
        )
        return watched

    @staticmethod
    def _encode_note_id(note_id: Any) -> str:
        import base64

        raw = base64.b64encode(str(note_id).encode("utf-8")).decode("ascii")
        return raw

    def _solve_captcha(self, post_data: Dict[str, Any], task: Dict[str, Any]) -> Dict[str, Any]:
        """平台返回 -12 时：拉验证码 -> 等前端用户点击 -> 重试本轮上报。"""
        captcha = self._captcha
        if captcha is None:
            self.bus.log("平台要求完成人机验证，但验证模块未启用", "error")
            raise ZhsError("需要完成人机验证，请更新客户端后重试")

        self.bus.log("平台要求人机验证，正在自动识别（可在弹窗里改手动）", "warn")
        for attempt in range(3):
            self._check_stop()
            try:
                captcha.begin({"id": task.get("id"), "name": task.get("name")})
            except ZhsError as exc:
                self.bus.log("获取验证码失败：%s" % exc, "error")
                raise ZhsError("验证码获取失败，学习已暂停") from exc

            solved = captcha.wait(stop_check=lambda: self._stop.is_set())
            if solved:
                # 先认通过：验证都过了，即便用户这时候点了停止，也把这次有效验证用掉
                pass
            elif self._stop.is_set():
                # 用户点了停止：顺手把弹窗收起，别让验证窗一直挂在界面上
                captcha.cancel()
                raise _Stopped()
            else:
                captcha.cancel()
                raise ZhsError("等待人机验证超时，学习已暂停")

            # 平台只认 validateSlideToken 登记过的凭证，不登记会被一直打回 -12。
            # 登记用的是 CN31_ 开头的 token，不是易盾返回的那串 validate 原文。
            slide_token = captcha.slide_token()
            client = self._client
            if slide_token and client is not None:
                # ev 是平台必填项：一组用 ";" 连起来的 id，服务端会解码，乱填回 -1
                ev = build_ev(
                    [
                        client.recruit_id,
                        task.get("big_id"),
                        task.get("small_id") or 0,
                        task.get("video_id"),
                        task.get("chapter_id"),
                    ]
                )
                try:
                    client.validate_slide_token(slide_token, ev=ev)
                except ZhsError as exc:
                    self.bus.log("登记验证结果失败（将继续尝试上报）：%s" % exc, "warn")
            elif not slide_token:
                self.bus.log("按用户确认跳过登记，直接重试上报", "warn")

            payload = self._save_interval(post_data)
            if payload.get("code") != -12:
                self.bus.log("人机验证通过，继续学习", "success")
                return payload
            if attempt < 2:
                self.bus.log("验证未通过，重新获取验证码（第 %s 次）" % (attempt + 1), "warn")

        captcha.cancel()
        raise ZhsError("人机验证未通过，学习已暂停")

    def _save_interval(self, post_data: Dict[str, Any]) -> Dict[str, Any]:
        client = self._client
        assert client is not None
        last_error: Optional[Exception] = None
        for attempt in range(self._max_retry):
            self._check_stop()
            if not self._wait_if_paused():
                raise _Stopped()
            try:
                return client.save_interval(post_data)
            except ZhsError as exc:
                last_error = exc
                if attempt < self._max_retry - 1:
                    # 只有真要再试一次时才提“重试”，最后一次失败交给上层汇总
                    self.bus.log("上报失败，第 %s 次重试：%s" % (attempt + 1, exc), "warn")
                    if not self._sleep(1.0 + attempt * 0.8):
                        raise _Stopped() from None
        raise ZhsError("进度上报失败：%s" % last_error)

    def _handle_popups(self, popups: List[Dict[str, Any]], task: Dict[str, Any], seconds: int) -> None:
        """到点了就答弹窗题。

        原来只在 ``timeSec`` 严格等于当前秒数时才触发，等于「一次不中就永久漏掉」：
        续播时起点在弹窗之后，这道题就再也不会出现；取题失败一次同样永久漏掉。
        现在改成「到点未答就补答」，并记录已答过的题避免重复提交。
        """
        client = self._client
        if client is None or not popups:
            return
        # 每秒只处理一道题。续播到 700 秒时，前面所有没答过的弹窗题都会在同一刻
        # 满足 timeSec <= seconds，若一次全处理就是几十个请求的瞬时突发；
        # 一次一道、靠每秒调用来摊开，节奏自然也更像人在看。
        now = time.time()
        for question in popups:
            try:
                key = self._popup_key(question)
                if key in self._popup_done:
                    continue
                time_sec = self._popup_time_sec(question)
                if time_sec is None:
                    continue
                # 到点了（>=）而不是刚好等于：续播、进度错位都能补上
                if time_sec > seconds:
                    continue
                # 失败必须记账并封顶，否则 time_sec <= seconds 一直成立，
                # 会每秒把取题+提交重打一遍直到视频结束——那不是重试，是刷接口。
                tries = self._popup_tries.get(key, 0)
                if tries >= POPUP_MAX_TRIES:
                    continue
                # 退避：失败后别在下一个心跳（1 秒后）就重来
                if now < self._popup_next_try.get(key, 0.0):
                    continue
                last_chance = tries + 1 >= POPUP_MAX_TRIES
                if tries == 0:
                    suffix = ""
                elif last_chance:
                    suffix = "（最后一次，拿不到答案就随机选）"
                else:
                    suffix = "（第 %d 次尝试）" % (tries + 1)
                self.bus.log("触发弹窗题目（第 %s 秒出现），正在自动作答%s"
                             % (time_sec, suffix), "info")
                if self._answer_popup(question, task, last_chance=last_chance):
                    self._popup_done.add(key)
                    self._popup_tries.pop(key, None)
                    self._popup_next_try.pop(key, None)
                    return
                self._popup_tries[key] = tries + 1
                self._popup_next_try[key] = now + POPUP_RETRY_BACKOFF[
                    min(tries, len(POPUP_RETRY_BACKOFF) - 1)]
                if last_chance:
                    self.bus.log(
                        "弹窗题（第 %s 秒）用尽 %d 次机会，随机答案也没能提交成功，"
                        "这道题在平台上会显示未作答。" % (time_sec, POPUP_MAX_TRIES), "error")
                return
            except Exception as exc:  # noqa: BLE001
                # 继续看下一题：一道题结构异常，不该让这一秒里其他题也失去机会
                self.bus.log("弹窗题目处理异常：%s" % exc, "warn")
                continue

    @staticmethod
    def _popup_key(question: Dict[str, Any]) -> str:
        """弹窗题的身份。

        用规范化后的 questionIds，而不是 ``str(questionIds)``：平台可能把它
        给成列表、字符串或数字，同一道题换了表示就各算一次，导致「已答过」
        认不出来而重复提交。
        """
        ids = question.get("questionIds")
        if isinstance(ids, (list, tuple, set)):
            parts = sorted({str(item).strip() for item in ids if str(item).strip()})
            if parts:
                return ",".join(parts)
        else:
            text = str(ids or "").strip()
            if text:
                return text
        return "t:%s" % question.get("timeSec")

    @staticmethod
    def _popup_time_sec(question: Dict[str, Any]) -> Optional[int]:
        """弹窗出现时间；字段缺失返回 None。

        不能用 ``question.get("timeSec") or -1``：第 0 秒就是合法时间，
        ``0 or -1`` 会把它当成「没有时间」而永久跳过这道题。
        """
        try:
            return int(question.get("timeSec"))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _popup_lesson_video_id(task: Dict[str, Any]) -> Any:
        """弹窗接口里的 lessonVideoId 是 smallLessonId（video.id）。

        ``task["id"]`` 本身就是它（``small_id`` 只在 lesson 即 video 时是 0），
        所以这里用 ``or`` 兜底，别把 0 发出去。
        """
        return task.get("small_id") or task.get("id")

    def _answer_popup(self, question: Dict[str, Any], task: Dict[str, Any],
                      last_chance: bool = False) -> bool:
        """取题 + 提交，返回是否真的答上去了。

        只取一次题：外层 ``_handle_popups`` 已经给了最多 POPUP_MAX_TRIES 轮，
        这里再叠一层重试就变成短时间内反复打接口了。
        ``last_chance`` 为真时，拿不到正确答案就随机挑一个选项提交——
        答错只丢分，未作答会被平台记成异常，后者代价大得多。
        """
        client = self._client
        if client is None:
            return False
        try:
            detail = client.get_pop_up_exam_detail(
                task.get("big_id"), self._popup_lesson_video_id(task),
                question.get("questionIds"))
        except Exception as exc:  # noqa: BLE001
            self.bus.log("取弹窗题目失败：%s" % exc, "warn")
            return False
        result = client.submit_pop_up_exam(
            task.get("big_id"), self._popup_lesson_video_id(task),
            detail, fallback=last_chance, question_ids=question.get("questionIds"))
        # 判断依据是「这道题有没有答上」，不是「本轮一共提交了几道」：
        # 详情里若混着别的题，后者会把没答上的这道也当成成功。
        if result.get("answered"):
            return True
        if not result.get("submitted") and not result.get("skipped"):
            # 既没提交也没被跳过，说明详情里压根没有可处理的题目。
            # 必须留一条日志，否则日志里只有「正在自动作答」，看不出断在哪。
            self.bus.log("弹窗题目详情里没有可作答的题目", "warn")
        return False

    def _sweep_popups(self, popups: List[Dict[str, Any]], task: Dict[str, Any],
                      upto: int) -> None:
        """视频结束前的兜底：把「本该出现但没答上」的弹窗题补齐。

        平台会按弹窗题的完成情况判定学习是否正常，漏一道就可能被记成异常。
        但只补 ``timeSec <= upto`` 的：平台有可能在进度不到 100% 时就判完成，
        这时候去答还没播到的题（比如才看到 400 秒却提交 700 秒那道），
        在平台眼里比「没答」更像异常。
        """
        if not popups:
            return
        pending = []
        for question in popups:
            key = self._popup_key(question)
            if key in self._popup_done:
                continue
            # 已经试到上限的题不再纠缠，否则收尾又是新一轮打接口
            if self._popup_tries.get(key, 0) >= POPUP_MAX_TRIES:
                continue
            time_sec = self._popup_time_sec(question)
            if time_sec is None or time_sec > upto:
                continue
            pending.append(question)
        if not pending:
            return
        self.bus.log("还有 %d 道弹窗题没答，补答" % len(pending), "warn")
        for question in pending:
            key = self._popup_key(question)
            # 收尾是最后的机会了，拿不到正确答案就随机，别留空
            if self._answer_popup(question, task, last_chance=True):
                self._popup_done.add(key)
                self._popup_tries.pop(key, None)
                self._popup_next_try.pop(key, None)
                continue
            # 也要记账：收尾一旦被复用，不至于对同一题反复随机提交
            self._popup_tries[key] = self._popup_tries.get(key, 0) + 1
            self._popup_next_try[key] = time.time() + POPUP_RETRY_BACKOFF[-1]
            self.bus.log("补答仍未成功：第 %s 秒的弹窗题，请手动处理"
                         % question.get("timeSec"), "error")

    # ------------------------------------------------------------------ 工具
    def _tick(self, seconds: float) -> bool:
        remaining = seconds
        while remaining > 0:
            if self._stop.is_set():
                return False
            if not self._wait_if_paused():
                return False
            step = min(0.15, remaining)
            time.sleep(step)
            remaining -= step
        return True

    def _wait_if_paused(self) -> bool:
        """暂停期间原地挂起（不推进剩余时长、不上报）；返回 False 表示已收到停止信号。"""
        while not self._gate.is_set():
            if self._stop.is_set():
                return False
            if self.status == "running":
                with self._lock:
                    self.status = "paused"
                self._emit_state()
            time.sleep(0.1)
        return not self._stop.is_set()

    def _sleep(self, seconds: float) -> bool:
        return self._tick(seconds)

    def _check_stop(self) -> None:
        if self._stop.is_set():
            raise _Stopped()

    def _set_queue(self, task_id: str, status: str, watched: Optional[int] = None) -> None:
        with self._lock:
            for item in self.queue:
                if item["task_id"] == task_id:
                    item["status"] = status
                    if watched is not None:
                        item["watched"] = watched
                    break
        self.bus.publish(
            {
                "type": "task",
                "task_id": task_id,
                "status": status,
                "watched": watched if watched is not None else None,
            }
        )
        self._emit_state()

    def _emit_progress(self, task_id: str, watched: int, total: int) -> None:
        with self._lock:
            for item in self.queue:
                if item["task_id"] == task_id:
                    item["watched"] = watched
                    break
            self.current["watched"] = min(watched, total)
            self.current["total"] = total
        self.bus.publish(
            {
                "type": "task",
                "task_id": task_id,
                "status": "playing",
                "watched": watched,
                "total": total,
            }
        )
        # 每秒同步一次引擎快照，前端的“当前任务”进度条与时间码才能实时走动
        self._emit_state()

    def _emit_state(self) -> None:
        self.bus.publish({"type": "engine", "engine": self.snapshot()})
