"""智慧树接口客户端。

在原项目 Zhihuishu.py 的接口逻辑基础上重写：
- 运行日志走回调上报，不打印到终端、不落日志文件；
- 支持任务级进度回调；
- 统一异常类型，便于界面展示。
"""

from __future__ import annotations

import json
import random
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import requests

from .legacy import ensure_legacy_path

ensure_legacy_path()

from encrypt.encrypt import encrypt_aes_cbc_pkcs7  # noqa: E402


class ZhsError(RuntimeError):
    """接口、登录或网络异常。"""


COMMON_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Content-Type": "application/x-www-form-urlencoded",
    "Pragma": "no-cache",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0"
    ),
    "sec-ch-ua": "Not",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "Windows",
}

# 通用 cookie：所有智慧树子域都能接受
LEGACY_COOKIE_KEYS = ("acw_tc", "SERVERID", "CASTGC", "CASLOGC", "jt-cas")
# gologin 下发的会话 cookie：onlineservice-api 必须要，但带到 studyservice-api
# 会被服务端当成异常请求直接返回 500，所以只在必要时附加。
SESSION_COOKIE = "SESSION"
ONLINE_HOST = "onlineservice-api.zhihuishu.com"

HMS_BASE = 3600


def hms_to_seconds(value: Any) -> int:
    text = str(value or "").strip()
    if not text:
        return 0
    parts = text.split(":")
    try:
        numbers = [int(float(p)) for p in parts]
    except ValueError:
        return 0
    seconds = 0
    for number in numbers:
        seconds = seconds * 60 + number
    return seconds


def seconds_to_hms(seconds: int) -> str:
    seconds = max(0, int(seconds))
    return "%02d:%02d:%02d" % (seconds // 3600, seconds % 3600 // 60, seconds % 60)


_EV_KEY = b"zzpttjd"


def build_ev(values: List[Any]) -> str:
    """平台登记接口要的 ev 字段。

    浏览器实现（学习页 chunk 里的 D.Z）：把一组整数用 ";" 连成字符串，
    每个字符与 "zzpttjd" 循环异或，再转成两位十六进制。

    抓包解密出来是：[recruitId, lessonId, lessonVideoId, resourcesFileId, chapterId]。
    服务端会把它解码回数字，格式不对就回 -1「参数解码发生错误」。
    """
    text = ";".join(str(int(value or 0)) for value in values)
    return "".join(
        "%02x" % (byte ^ _EV_KEY[index % len(_EV_KEY)])
        for index, byte in enumerate(text.encode("utf-8"))
    )


class ZhsClient:
    KEY = "azp53h0kft7qi78q"
    IV = "31673371716468346a7662736b623978"

    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers.update(COMMON_HEADERS)
        self.cookies: Dict[str, str] = {}
        # log_api 开关控制的接口流水（调试用，默认关）
        self.log_hook: Optional[Callable[[str], None]] = None
        # 用户可见的提示（答题结果、取题失败等），不受 log_api 影响，始终送界面
        self.notice_hook: Optional[Callable[[str, str], None]] = None

        self.uuid: str = ""
        self.avatar: str = ""
        self.recruit_id: Optional[int] = None
        self.course_id: Optional[int] = None
        self.class_data: Dict[str, Any] = {}

        self.video_chapters: List[Dict[str, Any]] = []
        self.tasks: List[Dict[str, Any]] = []
        self.chapters: List[Dict[str, Any]] = []

        # validateSlideToken 试通过的那种明文字段写法（见 _slide_token_shapes）
        self._slide_token_shape = ""

        # 由播放线程注入（见 PlayEngine.start）：用户点「停止」时置位，
        # 请求重试与退避立刻放弃。否则一次断网能把 stop() 拖到几分钟，
        # 引擎卡在 stopping，切课程/重新开始都会被 409/400 拒绝。
        self.cancel_event: Optional[threading.Event] = None

    # ------------------------------------------------------------------ 基础
    def set_cookies(self, cookies: Optional[Dict[str, str]]) -> None:
        for key, value in (cookies or {}).items():
            if not value:
                continue
            self.cookies[key] = value
            if key in LEGACY_COOKIE_KEYS:
                self.session.cookies.set(key, value)

    def _sync_cookies(self) -> None:
        """收集全部 cookie 用于持久化，但 session jar 只保留通用 5 个。

        SESSION 只在访问 onlineservice-api 时单独附加（见 _request），
        否则 studyservice-api 会 500。
        """
        current = {c.name: c.value for c in self.session.cookies if c.value}
        self.cookies = {**self.cookies, **current}
        self.session.cookies.clear()
        for key in LEGACY_COOKIE_KEYS:
            value = self.cookies.get(key)
            if value:
                self.session.cookies.set(key, value)

    def cookie_dict(self) -> Dict[str, str]:
        return dict(self.cookies)

    def _log(self, text: str) -> None:
        if self.log_hook:
            self.log_hook(text)

    def _notice(self, text: str, level: str = "info") -> None:
        """送界面的提示，不受 log_api 开关影响。

        原来弹窗答题的结果都走 _log，而 _log 要 log_api=True 才有输出
        （默认是 False），于是界面上只剩「正在自动作答」、看不到结果，
        看着像「什么都没做」。答题这种事必须始终可见。
        """
        if self.notice_hook:
            self.notice_hook(text, level)
        else:
            self._log(text)

    def _request(
        self,
        method: str,
        url: str,
        *,
        data: Any = None,
        params: Any = None,
        headers: Optional[Dict[str, str]] = None,
        allow_redirects: bool = True,
        retries: int = 3,
        timeout: int = 12,
    ) -> requests.Response:
        # onlineservice-api 需要 SESSION；其余域名带上它会被判为异常请求
        extra_cookies = None
        if urlparse(url).hostname == ONLINE_HOST:
            session_cookie = self.cookies.get(SESSION_COOKIE)
            if session_cookie:
                extra_cookies = {SESSION_COOKIE: session_cookie}

        last_error: Any = None
        for attempt in range(retries):
            # 已经被要求停止就不要再发请求，也不要把退避睡完
            if self.cancel_event is not None and self.cancel_event.is_set():
                raise ZhsError("已停止：放弃本次请求")
            try:
                response = self.session.request(
                    method,
                    url,
                    data=data,
                    params=params,
                    headers=headers,
                    cookies=extra_cookies,
                    allow_redirects=allow_redirects,
                    timeout=timeout,
                )
                if response.status_code >= 500:
                    snippet = (response.text or "").strip()[:160]
                    last_error = ZhsError("服务端错误 %s%s" % (response.status_code, "：" + snippet if snippet else ""))
                else:
                    return response
            except requests.RequestException as exc:
                last_error = exc
            if attempt < retries - 1:
                delay = 0.6 * (attempt + 1)
                if self.cancel_event is not None:
                    # wait 可以被打断：停止信号一置位就立刻结束这次退避
                    if self.cancel_event.wait(delay):
                        raise ZhsError("已停止：放弃重试")
                else:
                    time.sleep(delay)
        raise ZhsError("网络请求失败：%s" % last_error)

    def _json(self, response: requests.Response, action: str) -> Dict[str, Any]:
        self._log("%s <- %s" % (action, response.text[:2000]))
        try:
            payload = response.json()
        except ValueError as exc:
            raise ZhsError("%s失败：返回内容不是 JSON（登录可能已失效）" % action) from exc
        if not isinstance(payload, dict):
            raise ZhsError("%s失败：返回格式异常" % action)
        return payload

    def _encrypt(self, payload: Any) -> str:
        # 浏览器侧是 JSON.stringify 后加密，这里必须出标准 JSON：
        # str(dict) 会把 True/None 写成 True/None（非法 JSON），服务端解密后解析失败。
        if isinstance(payload, (dict, list)):
            text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        else:
            text = str(payload)
        return encrypt_aes_cbc_pkcs7(text, self.KEY, self.IV)

    # ------------------------------------------------------------------ 登录
    def login(self, secret_str: str) -> Tuple[int, int]:
        # 新一轮登录不要复用上一轮的会话 cookie，否则 gologin 会去认旧会话
        self.cookies.pop(SESSION_COOKIE, None)
        headers = {
            "Origin": "https://passport.zhihuishu.com",
            "Referer": "https://passport.zhihuishu.com/login?service=https://onlineservice-api.zhihuishu.com/login/gologin",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
        }
        response = self._request(
            "POST",
            "https://passport.zhihuishu.com/user/validateAccountAndPassword",
            data={"secretStr": secret_str},
            headers=headers,
        )
        payload = self._json(response, "登录")

        status = payload.get("status")
        if status == -2:
            return -2, int(payload.get("pwdErrorCount") or 0)
        if status == -6:
            return -6, 0
        if status != 1:
            return int(status or -1), 0

        pwd = payload.get("pwd")
        self.uuid = str(payload.get("uuid") or "")
        self._sync_cookies()

        redirect_headers = {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": (
                "https://passport.zhihuishu.com/login?service=https%3A%2F%2F"
                "onlineservice-api.zhihuishu.com%2Fgateway%2Ff%2Fv1%2Flogin%2Fgologin"
            ),
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Upgrade-Insecure-Requests": "1",
        }
        params = {
            "pwd": pwd,
            "service": (
                "https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/gologin"
                "?fromurl=https%3A%2F%2Fonlineweb.zhihuishu.com%2F"
            ),
        }
        hop = self._request(
            "GET",
            "https://passport.zhihuishu.com/login",
            params=params,
            headers=redirect_headers,
            allow_redirects=False,
        )
        location = hop.headers.get("location")
        if not location:
            raise ZhsError("登录失败：未获取到跳转地址")
        self._request("GET", location, headers=redirect_headers, allow_redirects=False)

        self._sync_cookies()
        return 0, 0

    def get_real_name(self, retries: int = 3, timeout: int = 12) -> Optional[str]:
        headers = {
            "Origin": "https://onlineweb.zhihuishu.com",
            "Referer": "https://onlineweb.zhihuishu.com",
        }
        response = self._request(
            "GET",
            "https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo",
            params={"time": str(time.time() * 1000)},
            headers=headers,
            retries=retries,
            timeout=timeout,
        )
        try:
            payload = response.json()
        except ValueError:
            self._log("获取用户信息失败：%s" % response.text[:300])
            return None
        result = payload.get("result") if isinstance(payload, dict) else None
        if not isinstance(result, dict):
            self._log("获取用户信息失败：%s" % response.text[:300])
            return None
        self.uuid = str(result.get("uuid") or self.uuid)
        self.avatar = str(result.get("headPicUrl") or result.get("headPic") or self.avatar)
        name = result.get("realName") or result.get("name") or ""
        return str(name) or None

    # ------------------------------------------------------------------ 课程
    def get_courses(self) -> List[Dict[str, Any]]:
        headers = {
            "Origin": "https://onlineweb.zhihuishu.com",
            "Referer": "https://onlineweb.zhihuishu.com/",
        }
        response = self._request(
            "POST",
            "https://onlineservice-api.zhihuishu.com/gateway/t/v1/student/course/share/queryShareCourseInfo",
            data={
                "secretStr": "NEuH3llD9woD4DQgu0k6Uvp5yyo8WT84Dq5lU2iPwvgKNatePzJ+vu/4PRaNYy+K",
                "date": "1704217471129",
            },
            headers=headers,
        )
        payload = self._json(response, "获取课程列表")
        try:
            items = payload["result"]["courseOpenDtos"]
        except (KeyError, TypeError):
            raise ZhsError("获取课程列表失败，登录状态可能已失效") from None

        courses: List[Dict[str, Any]] = []
        for item in items or []:
            secret = item.get("secret")
            if not secret:
                continue
            courses.append(
                {
                    "id": str(item.get("courseId") or secret),
                    "name": str(item.get("courseName") or "未命名课程"),
                    "secret": str(secret),
                    "school": str(item.get("schoolName") or ""),
                    "term": str(item.get("yearTerm") or ""),
                    "cover": str(item.get("courseCover") or ""),
                }
            )
        return courses

    def select_course(self, secret: str, name: str = "") -> Dict[str, Any]:
        self.class_data = {
            "recruitAndCourseId": secret,
            "dateFormate": int(time.time() * 1000),
        }
        self.query_course()
        self.get_videolist()
        self.get_study_info()
        return {
            "name": name,
            "course_id": self.course_id,
            "recruit_id": self.recruit_id,
            "chapters": self.chapters,
            "tasks": self.tasks,
        }

    def query_course(self) -> None:
        headers = {
            "Origin": "https://wisdom-mooc.zhihuishu.com",
            "Referer": "https://wisdom-mooc.zhihuishu.com/",
        }
        response = self._request(
            "POST",
            "https://studyservice-api.zhihuishu.com/gateway/t/v1/learning/queryCourse",
            data={
                "secretStr": self._encrypt(self.class_data),
                "dateFormate": str(int(time.time() * 1000)),
            },
            headers=headers,
        )
        payload = self._json(response, "获取课程信息")
        try:
            self.recruit_id = int(payload["data"]["recruitId"])
            self.course_id = int(payload["data"]["courseInfo"]["courseId"])
        except (KeyError, TypeError, ValueError):
            raise ZhsError("获取课程信息失败，可能是课程不可学习") from None

    def get_videolist(self) -> Dict[str, Any]:
        headers = {
            "Origin": "https://wisdom-mooc.zhihuishu.com",
            "Referer": "https://wisdom-mooc.zhihuishu.com/",
        }
        response = self._request(
            "POST",
            "https://studyservice-api.zhihuishu.com/gateway/t/v1/learning/videolist",
            data={
                "secretStr": self._encrypt(self.class_data),
                "dateFormate": str(int(time.time() * 1000)),
            },
            headers=headers,
        )
        payload = self._json(response, "获取章节列表")
        try:
            data = payload["data"]
            self.recruit_id = int(data["recruitId"])
            self.course_id = int(data["courseId"])
            self.video_chapters = data.get("videoChapterDtos") or []
        except (KeyError, TypeError, ValueError):
            raise ZhsError("获取章节列表失败，登录状态可能已失效") from None
        return payload

    def get_study_info(self) -> List[Dict[str, Any]]:
        lesson_ids: List[int] = []
        lesson_video_ids: List[int] = []
        for chapter in self.video_chapters:
            for lesson in chapter.get("videoLessons") or []:
                if lesson.get("id") is not None:
                    lesson_ids.append(lesson["id"])
                if lesson.get("ishaveChildrenLesson"):
                    for small in lesson.get("videoSmallLessons") or []:
                        if small.get("id") is not None:
                            lesson_video_ids.append(small["id"])

        payload_in = {
            "recruitId": self.recruit_id,
            "lessonIds": lesson_ids,
            "lessonVideoIds": lesson_video_ids,
        }
        headers = {
            "Accept": "*/*",
            "Origin": "https://wisdom-mooc.zhihuishu.com",
            "Referer": "https://wisdom-mooc.zhihuishu.com/",
        }
        response = self._request(
            "POST",
            "https://studyservice-api.zhihuishu.com/gateway/t/v1/learning/queryStuyInfo",
            data={
                "secretStr": self._encrypt(payload_in),
                "dateFormate": str(int(time.time() * 1000)),
            },
            headers=headers,
        )
        payload = self._json(response, "获取学习进度")
        study = payload.get("data") or {}
        self._build_tasks(study)
        return self.tasks

    def _build_tasks(self, study: Dict[str, Any]) -> None:
        level_videos = {str(k): v for k, v in (study.get("lv") or {}).items()}
        lessons = {str(k): v for k, v in (study.get("lesson") or {}).items()}

        tasks: List[Dict[str, Any]] = []
        chapters: List[Dict[str, Any]] = []

        for chapter in self.video_chapters:
            chapter_name = str(
                chapter.get("name") or chapter.get("chapterName") or chapter.get("title") or "未命名章节"
            )
            task_ids: List[str] = []
            for lesson in chapter.get("videoLessons") or []:
                if lesson.get("ishaveChildrenLesson"):
                    for small in lesson.get("videoSmallLessons") or []:
                        task = self._make_task(lesson, small, chapter_name, lessons, level_videos)
                        if task:
                            tasks.append(task)
                            task_ids.append(task["id"])
                else:
                    task = self._make_task(lesson, lesson, chapter_name, lessons, level_videos)
                    if task:
                        tasks.append(task)
                        task_ids.append(task["id"])
            if task_ids:
                chapters.append({"name": chapter_name, "task_ids": task_ids})

        self.tasks = tasks
        self.chapters = chapters

    def _make_task(
        self,
        lesson: Dict[str, Any],
        video: Dict[str, Any],
        chapter_name: str,
        lessons: Dict[str, Any],
        level_videos: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        video_id = video.get("id")
        if video_id is None:
            return None
        task_id = str(video_id)
        info: Dict[str, Any] = {}
        info.update(lessons.get(task_id) or {})
        info.update(level_videos.get(task_id) or {})

        video_sec = int(video.get("videoSec") or info.get("videoSec") or 0)
        studied = int(info.get("studyTotalTime") or 0)
        if studied <= 0:
            studied = hms_to_seconds(info.get("learnTime"))
        watch_state = int(info.get("watchState") or 0)

        return {
            "id": task_id,
            "name": str(video.get("name") or "未命名视频"),
            "chapter": chapter_name,
            "video_sec": video_sec,
            "studied": min(studied, video_sec) if video_sec else studied,
            "watch_state": watch_state,
            "completed": watch_state == 1 or (video_sec > 0 and studied >= video_sec),
            "big_id": lesson.get("id"),
            "small_id": video.get("id") if lesson is not video else 0,
            "video_id": video.get("videoId"),
            "chapter_id": lesson.get("chapterId") or video.get("chapterId"),
        }

    # ------------------------------------------------------------------ 学习
    def pre_learning_note(self, task: Dict[str, Any]) -> Dict[str, Any]:
        headers = {
            "Origin": "https://wisdom-mooc.zhihuishu.com",
            "Referer": "https://wisdom-mooc.zhihuishu.com/",
        }
        payload_in = {
            "ccCourseId": self.course_id,
            "chapterId": task.get("chapter_id"),
            "isApply": 1,
            "lessonId": task.get("big_id"),
            "lessonVideoId": task.get("small_id"),
            "recruitId": self.recruit_id,
            "videoId": task.get("video_id"),
        }
        response = self._request(
            "POST",
            "https://studyservice-api.zhihuishu.com/gateway/t/v1/learning/prelearningNote",
            data={
                "secretStr": self._encrypt(payload_in),
                "dateFormate": str(int(time.time() * 1000)),
            },
            headers=headers,
        )
        payload = self._json(response, "获取播放进度")
        try:
            return payload["data"]["studiedLessonDto"]
        except (KeyError, TypeError):
            raise ZhsError("获取播放进度失败，请稍后重试") from None

    def get_pop_up_exam_list(self, lesson_id: Any, lesson_video_id: Any) -> List[Dict[str, Any]]:
        headers = {
            "Origin": "https://wisdom-mooc.zhihuishu.com",
            "Referer": "https://wisdom-mooc.zhihuishu.com/",
        }
        # 明文和暗文里的 dateFormate 必须是同一个值：参考实现都是一次取时间、
        # 两处共用。这里原来是各调一次 time.time()，跨毫秒就会对不上。
        date_formate = int(time.time() * 1000)
        payload_in = {
            "lessonId": lesson_id,
            "recruitId": self.recruit_id,
            "courseId": self.course_id,
            "dateFormate": date_formate,
            "lessonVideoId": lesson_video_id,
        }
        try:
            response = self._request(
                "POST",
                "https://studyservice-api.zhihuishu.com/gateway/t/v1/popupAnswer/loadVideoPointerInfo",
                data={
                    "secretStr": self._encrypt(payload_in),
                    "dateFormate": str(date_formate),
                },
                headers=headers,
                # 网络层不再重试：上层有带退避的业务重试，两层相乘会把
                # 一次失败放大成 3~18 个连发请求。
                retries=1,
            )
            payload = response.json()
        except (ZhsError, ValueError) as exc:
            self._notice("弹窗题目列表获取失败，本次忽略弹窗：%s" % exc, "warn")
            return []

        if payload.get("code") != 0:
            self._notice("弹窗题目列表获取失败（code=%s）：%s"
                      % (payload.get("code"), payload.get("message")))
            return []
        data = payload.get("data")
        points = data.get("questionPoint") if isinstance(data, dict) else []
        if not isinstance(points, list):
            # 结构不对就当本节没有弹窗题。直接抛出去会中断整条视频，
            # 而「少答一道弹窗」的代价远小于「这节不学了」。
            self._notice("弹窗题目列表结构异常（questionPoint 类型：%s），本次忽略弹窗"
                      % type(points).__name__, "warn")
            return []
        points = [point for point in points if isinstance(point, dict)]
        # 清单会被定期刷新（POPUP_REFRESH_EVERY），内容不变时再打只是噪音：
        # 一节 11 分钟的课会刷出十几行同样的话。以任务（lessonVideoId）为键，
        # 每节视频只说一次；换下一节会重新说，同一节里平台中途加题也会说。
        signature = ",".join(str(point.get("questionIds")) for point in points)
        seen = getattr(self, "_popup_list_seen", None)
        if seen is None:
            seen = self._popup_list_seen = {}
        task_key = str(lesson_video_id) if lesson_video_id is not None else "unknown"
        if points and seen.get(task_key) != signature:
            seen[task_key] = signature
            self._notice("本节有 %d 道弹窗题目，出现时间：%s"
                      % (len(points), "、".join(str(p.get("timeSec")) for p in points)))
        return points

    def get_pop_up_exam_detail(self, lesson_id: Any, lesson_video_id: Any,
                              question_ids: Any) -> Optional[Dict[str, Any]]:
        headers = {
            "Origin": "https://wisdom-mooc.zhihuishu.com",
            "Referer": "https://wisdom-mooc.zhihuishu.com/",
        }
        date_formate = int(time.time() * 1000)
        payload_in = {
            "courseId": self.course_id,
            "recruitId": self.recruit_id,
            "lessonId": lesson_id,
            "lessonVideoId": lesson_video_id,
            "questionIds": question_ids,
            "dateFormate": date_formate,
        }
        try:
            response = self._request(
                "POST",
                "https://studyservice-api.zhihuishu.com/gateway/t/v1/popupAnswer/lessonPopupExam",
                data={
                    "secretStr": self._encrypt(payload_in),
                    "dateFormate": str(date_formate),
                },
                headers=headers,
                retries=1,
            )
            payload = response.json()
        except (ZhsError, ValueError) as exc:
            raise ZhsError("取弹窗题目失败（questionIds=%r）：%s"
                           % (question_ids, exc)) from None
        if payload.get("code") != 0:
            # 这里以前是 return None，引擎那边 if detail 为假就什么都不做，
            # 结果就是「平台说有异常、后台查不到答题记录、日志里也什么都没有」。
            # 改成抛出去，让上层看得见失败原因并重试。
            # 错误里带上 questionIds：它是不是列表、格式对不对，一眼就能看出来。
            raise ZhsError("取弹窗题目失败（code=%s，questionIds=%r）：%s"
                           % (payload.get("code"), question_ids,
                              payload.get("message")))
        detail = payload.get("data")
        if not detail:
            raise ZhsError("取弹窗题目返回空数据")
        if not isinstance(detail, dict):
            # 有些版本会把 data 直接给成列表。包一层，后面统一按 dict 处理，
            # 别让 .get() 抛 AttributeError 把整条链路的日志吞掉。
            if isinstance(detail, list):
                detail = {"lessonTestQuestionUseInterfaceDtos": detail}
            else:
                raise ZhsError("取弹窗题目返回的数据结构异常：%s" % type(detail).__name__)
        return detail

    # 正确项标记的字段名。参考实现（Bao-qing/zhihuishu、fuckZHS）都只认
    # ``result == "1"``；其余几个是同一语义的别名，一并认。
    _CORRECT_KEYS = ("result", "isCorrect", "correct", "isRight")
    # answer/right 在本平台的部分版本里不是「是否正确」，可能是选项内容或学生
    # 已选答案。只有整批选项都没有明确字段时才退到这一组，否则会把错项当正解。
    _CORRECT_FALLBACK_KEYS = ("right", "isAnswer", "answer")

    @staticmethod
    def _normalize_ids(value: Any) -> set:
        """把 questionIds 规范成 id 字符串集合：列表、数字、逗号串都能吃。"""
        if value is None:
            return set()
        items = value if isinstance(value, (list, tuple, set)) else str(value).split(",")
        return {str(item).strip() for item in items if str(item).strip()}

    @staticmethod
    def _flag_is_true(value: Any) -> bool:
        if isinstance(value, bool):
            return value
        return str(value) in ("1", "true", "True", "Y", "yes")

    @classmethod
    def _pick_correct_options(cls, options: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """挑出正确项：先试明确字段，整批都没有才回退到模糊字段。"""
        for keys in (cls._CORRECT_KEYS, cls._CORRECT_FALLBACK_KEYS):
            if not any(key in option for option in options for key in keys):
                continue
            # 这一组字段只要存在就以它为准：一个真值都没有说明数据异常，
            # 再往模糊字段上猜只会把错项当正解提交。
            return [option for option in options
                    if any(cls._flag_is_true(option.get(key)) for key in keys)]
        return []

    def submit_pop_up_exam(self, lesson_id: Any, lesson_video_id: Any, detail: Dict[str, Any],
                           fallback: bool = False, question_ids: Any = None) -> Dict[str, Any]:
        questions = detail.get("lessonTestQuestionUseInterfaceDtos") or []
        if not questions:
            # 走到这里说明「取题成功但里面没有题目列表」——要么字段名不对，
            # 要么平台这次只回了空壳。不吭声的话日志里就只剩「正在自动作答」，
            # 后面什么都没有，根本没法定位。把 data 的字段名打出来。
            keys = sorted(detail.keys()) if isinstance(detail, dict) else []
            self._notice("弹窗题目详情里没有题目列表（data 字段：%s）"
                      % ("、".join(keys) if keys else "空"))
            if not getattr(self, "_popup_detail_dumped", False):
                self._popup_detail_dumped = True
                try:
                    text = json.dumps(detail, ensure_ascii=False)
                except (TypeError, ValueError):
                    text = str(detail)
                self._notice("弹窗题目详情原始结构样例：%s" % text[:600], "warn")
            return {"submitted": 0, "skipped": 0, "answered": False}
        # 只提交本次触发的那道题：平台可能把本节全部题一起回给详情，
        # 照单全收就会弹一次把整节题重提一遍，还会覆盖已经答对的答案。
        wanted = self._normalize_ids(question_ids)
        if wanted:
            matched = [q for q in questions
                       if str((q.get("testQuestion") or {}).get("questionId")) in wanted]
            if matched:
                questions = matched
            else:
                # ID 对不上（questionIds 可能是别的含义），退回全部题：
                # 不提交等于直接留一道未作答，比重复提交更糟。
                self._notice("详情里没有 questionIds=%r 对应的题，改为提交全部题目"
                          % (question_ids,), "warn")
        submitted = 0
        skipped = 0
        answered_any = False
        answered_map = getattr(self, "_popup_answers", None)
        if answered_map is None:
            answered_map = self._popup_answers = {}
        for question in questions:
            test_question = question.get("testQuestion") or {}
            question_id = test_question.get("questionId")
            if question_id is None:
                # 发一个 testQuestionId=None 出去只会被服务端判非法
                self._notice("弹窗题目缺少 questionId，已跳过", "warn")
                skipped += 1
                continue
            options = test_question.get("questionOptions") or []
            answers = [
                str(option.get("id"))
                for option in self._pick_correct_options(options)
                if option.get("id") is not None
            ]
            if not answers and fallback:
                # 兜底：实在拿不到正确项就随机挑一个提交。
                # 平台对「未作答」是按异常处理的，对「答错」只是判错，后者代价小得多。
                # 只从有 id 的选项里挑，否则会submit一个 "None" 出去，直接被判非法。
                pickable = [o for o in options if o.get("id") is not None]
                if pickable:
                    picked = random.choice(pickable)
                    answers = [str(picked.get("id"))]
                    self._notice("弹窗题目拿不到正确项，随机选了一个答案提交：%s" % answers[0], "warn")
            if not answers:
                # 没有标记正确项时不要提交空答案，否则服务端可能判错并影响整卷。
                # 这里把选项的字段名打出来，是排查「平台说异常但没有记录」的关键线索。
                fields = sorted({k for o in options for k in o.keys()})
                self._notice("弹窗题目缺少可用答案，已跳过该题（选项字段：%s）"
                          % ("、".join(fields) if fields else "无"))
                if not getattr(self, "_popup_schema_dumped", False):
                    # 只打一次：把选项原始结构留下来，用来核对正确项到底存在哪个字段
                    self._popup_schema_dumped = True
                    sample = options[0] if options else {}
                    try:
                        text = json.dumps(sample, ensure_ascii=False)
                    except (TypeError, ValueError):
                        text = str(sample)
                    self._notice("弹窗题目选项原始结构样例：%s" % text[:500], "warn")
                skipped += 1
                continue
            answer_text = ",".join(answers)
            done_answer = answered_map.get(str(question_id))
            if done_answer is not None:
                # 同一题只提交一次：保存接口是覆盖写，随机兜底一旦盖到
                # 已经答对的答案就是净损失。
                if done_answer != answer_text:
                    self._notice("题 %s 已提交过答案 %s，本次的 %s 不再提交"
                              % (question_id, done_answer, answer_text), "warn")
                submitted += 1
                answered_any = True
                continue
            date_formate = int(time.time() * 1000)
            payload_in = {
                "courseId": self.course_id,
                "recruitId": self.recruit_id,
                "testQuestionId": question_id,
                "isCurrent": "1",
                "lessonId": lesson_id,
                "lessonVideoId": lesson_video_id,
                "answer": answer_text,
                "testType": 0,
                "dateFormate": date_formate,
            }
            headers = {
                "Origin": "https://wisdom-mooc.zhihuishu.com",
                "Referer": "https://wisdom-mooc.zhihuishu.com/",
            }
            try:
                response = self._request(
                    "POST",
                    "https://studyservice-api.zhihuishu.com/gateway/t/v1/popupAnswer/saveLessonPopupExamSaveAnswer",
                    data={
                        "secretStr": self._encrypt(payload_in),
                        "dateFormate": str(date_formate),
                    },
                    headers=headers,
                    retries=1,
                )
                payload = response.json()
                if payload.get("code") == 0:
                    submitted += 1
                    answered_any = True
                    answered_map[str(question_id)] = answer_text
                    # 带上平台回的话：code 0 只代表「存下了」，平台有没有算对、
                    # 会不会判重复，都写在这句 message 里，不打出来就查不到。
                    message = str(payload.get("message") or "")
                    self._notice("弹窗题目已自动作答（题 %s，答案 %s）%s"
                              % (question_id, answer_text,
                                 "：%s" % message if message else ""))
                else:
                    self._notice("弹窗题目提交失败：%s" % payload.get("message"), "warn")
                    skipped += 1
            except (ZhsError, ValueError) as exc:
                self._notice("弹窗题目提交异常：%s" % exc, "warn")
                skipped += 1
        return {"submitted": submitted, "skipped": skipped, "answered": answered_any}

    def validate_slide_token(
        self, token: str, ev: str = "", check_type: int = 1
    ) -> Dict[str, Any]:
        """易盾验证通过后把平台 token 交给平台登记。

        token 是 "CN31_..._v_i_1"（见 StudyCaptcha._platform_token），
        不是易盾返回的 validate 原文——传原文会被判「提交参数错误」。

        平台在 saveDatabaseIntervalTimeV2 里返回 -12 时，只认这里登记过的凭证；
        不调用它，即使易盾那边已经 result=true，上报仍会被一直打回。
        """
        if not token:
            raise ZhsError("登记人机验证失败：验证凭证为空")

        url = "https://studyservice-api.zhihuishu.com/gateway/t/v1/learning/validateSlideToken"
        headers = {
            "Accept": "*/*",
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://wisdom-mooc.zhihuishu.com",
            "Referer": "https://wisdom-mooc.zhihuishu.com/",
        }
        # 浏览器实测明文：{"token": "CN31_..._v_i_1", "ev": "<hex>", "checkType": 1}
        # 内层没有 dateFormate，只有 form 里带，且内外不共用时间戳。
        payload_in: Dict[str, Any] = {"token": token, "checkType": check_type}
        if ev:
            payload_in["ev"] = ev
        body = {
            "secretStr": self._encrypt(payload_in),
            "dateFormate": str(int(time.time() * 1000)),
        }
        response = self._request("POST", url, data=body, headers=headers)
        payload = self._json(response, "登记人机验证")
        code = payload.get("code")
        data = payload.get("data")
        if code in (0, "0") and not (isinstance(data, dict) and data.get("pass") is False):
            self._notice("人机验证登记成功（token 前 12 位 %s…）" % token[:12])
            return payload

        message = str(
            (isinstance(data, dict) and data.get("msg")) or payload.get("message") or code
        )
        raise ZhsError("登记人机验证失败：%s" % message)

    def save_interval(self, post_data: Dict[str, Any]) -> Dict[str, Any]:
        headers = {
            "Accept": "*/*",
            "Origin": "https://wisdom-mooc.zhihuishu.com",
            "Referer": "https://wisdom-mooc.zhihuishu.com/",
        }
        url = "https://studyservice-api.zhihuishu.com/gateway/t/v1/learning/saveDatabaseIntervalTimeV2"
        body = {"secretStr": self._encrypt(post_data)}
        # 网络层不重试：调用方 _save_interval 已有 max_retry 轮业务重试，
        # 两层相乘等于把一次失败放大 3 倍，而上报接口正是风控最敏感的那个。
        response = self._request("POST", url, data=body, headers=headers, retries=1)
        return self._json(response, "上报学习进度")

    @staticmethod
    def platform_completed(payload: Dict[str, Any]) -> bool:
        """平台是否已把当前视频判定为完成。

        平台往往在进度接近但不到 100% 时就置 watchState=1，
        上报进度的返回里可能是 watchState 字段，也可能只是文案，这里两种都兼容。
        """
        if not isinstance(payload, dict):
            return False
        message = str(payload.get("message") or "")
        if any(token in message for token in ("已完成", "学习完成", "完成学习")):
            return True

        data = payload.get("data")
        candidates: List[Any] = [payload, data]
        if isinstance(data, dict):
            candidates.append(data.get("studiedLessonDto"))
        # 只要任一节点说 watchState==1 就算完成：顶层可能是 0 而 data 里才是真实进度，
        # 原来“取到第一个就 return”会把已完成的判成未完成。
        for node in candidates:
            if not isinstance(node, dict):
                continue
            value = node.get("watchState")
            if value is None:
                continue
            try:
                if int(value) == 1:
                    return True
            except (TypeError, ValueError):
                continue
        return False

    @staticmethod
    def playing_encrypt(values: List[Any]) -> str:
        text = ";".join(str(v) for v in values)
        key = "zzpttjd"
        encoded = ""
        for index, char in enumerate(text):
            value = ord(char) ^ ord(key[index % 7])
            chunk = hex(value)[2:]
            if len(chunk) < 2:
                chunk = "0" + chunk
            encoded += chunk[-4:]
        return encoded
