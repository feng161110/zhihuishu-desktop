"""应用级单例状态。"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .auth import AuthManager
from .bus import EventBus
from .config import data_dir, load_session, load_settings
from .engine import PlayEngine
from .study_captcha import StudyCaptcha


class AppState:
    def __init__(self) -> None:
        self.bus = EventBus()
        self.settings: Dict[str, Any] = load_settings()
        self.auth = AuthManager(self.bus, lambda: self.settings)
        # 学习页人机验证（平台返回 -12 时弹出）；auto_solve 打开时先自动识别
        self.captcha = StudyCaptcha(self.bus, lambda: bool(self.settings.get("auto_solve", True)))
        self.engine = PlayEngine(self.bus, self.captcha)

        self.courses: List[Dict[str, Any]] = []
        self.course: Optional[Dict[str, Any]] = None
        self.tasks: List[Dict[str, Any]] = []
        self.chapters: List[Dict[str, Any]] = []

        # 上次“开始学习”的队列，用于前端重新打开时自动续播
        self.session: Dict[str, Any] = load_session()

    def reset_course(self) -> None:
        self.course = None
        self.tasks = []
        self.chapters = []

    def resumable(self) -> Optional[Dict[str, Any]]:
        """引擎空闲且存在未处理完的会话时，返回可续播的摘要，供前端自动恢复。"""
        if self.engine.status != "idle" or not self.session:
            return None
        task_ids = [str(tid) for tid in self.session.get("task_ids") or []]
        if not task_ids:
            return None
        return {
            "course_id": str(self.session.get("course_id") or ""),
            "task_ids": task_ids,
            "speed": float(self.session.get("speed") or 1.0),
        }

    def snapshot(self) -> Dict[str, Any]:
        return {
            "settings": self.settings,
            "authenticated": bool(self.auth.profile),
            "profile": self.auth.profile,
            "courses": self.courses,
            "course": self.course,
            "tasks": self.tasks,
            "chapters": self.chapters,
            "engine": self.engine.snapshot(),
            # 学习页人机验证状态：前端刷新后据此恢复弹窗
            "captcha": self.captcha.pending(),
            "resumable": self.resumable(),
            "logs": self.bus.logs(),
            "data_dir": str(data_dir()),
        }
