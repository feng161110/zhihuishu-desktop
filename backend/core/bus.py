"""线程安全的事件总线，通过 SSE 推送到前端。"""

from __future__ import annotations

import queue
import threading
import time
from collections import deque
from typing import Any, Deque, Dict, List, Set


class EventBus:
    def __init__(self, history: int = 600) -> None:
        self._subscribers: Set[queue.Queue] = set()
        self._lock = threading.Lock()
        self._history: Deque[Dict[str, Any]] = deque(maxlen=history)

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=3000)
        with self._lock:
            self._subscribers.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._subscribers.discard(q)

    def publish(self, event: Dict[str, Any]) -> None:
        event.setdefault("ts", time.time())
        with self._lock:
            self._history.append(event)
            subscribers = list(self._subscribers)
        for q in subscribers:
            try:
                q.put_nowait(event)
            except queue.Full:
                # 队列满说明该订阅者消费不过来。直接丢事件会让「验证码弹出」这类
                # 关键通知静默消失（前端只能等 4s 轮询兜底），
                # 所以丢掉最旧的一条，把最新的放进去。
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except (queue.Empty, queue.Full):
                    pass

    def log(self, message: str, level: str = "info") -> None:
        self.publish(
            {
                "type": "log",
                "level": level,
                "message": message,
                "time": time.strftime("%H:%M:%S", time.localtime()),
            }
        )

    def logs(self, limit: int = 300) -> List[Dict[str, Any]]:
        with self._lock:
            items = [e for e in self._history if e.get("type") == "log"]
        return items[-limit:]
