"""本地设置与凭据存储。

所有持久化文件写入用户数据目录，绝不触碰原项目的 cookies.json / log.txt。
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Dict

# 必须与 frontend/src-tauri/tauri.conf.json 的 identifier 一致：
# Tauri 在 Windows 用 identifier 作为 %APPDATA% 下的应用目录名，改名等于让老用户配置全部失效
APP_NAME = "com.zhihuishu.desk"

# 历史上曾用过该目录名，升级时把目标目录缺失的文件搬回来
LEGACY_APP_NAMES = ("ZhihuishuDesk",)
DEFAULT_PORT = int(os.environ.get("ZHS_PORT", "8765"))

DEFAULT_SETTINGS: Dict[str, Any] = {
    "speed": 1.0,
    "auto_solve": True,
    # 严格 100%：跳过与收手都以“实际看满时长”为准；默认关闭，一律按平台判定
    "strict_full": False,
    "remember_password": False,
    "max_retry": 5,
    "log_api": False,
}


def data_dir() -> Path:
    override = os.environ.get("ZHS_DATA_DIR")
    if override:
        path = Path(override)
        legacy_base = None
    else:
        base = os.environ.get("APPDATA") or str(Path.home() / ".config")
        path = Path(base) / APP_NAME
        legacy_base = path.parent
    path.mkdir(parents=True, exist_ok=True)
    if legacy_base is not None:
        _migrate_legacy(path, legacy_base)
    return path


_MIGRATED = False
_MIGRATE_LOCK = threading.Lock()


def _migrate_legacy(target: Path, base: Path) -> None:
    """把旧目录名下的持久化文件补到当前目录（只补缺失项，不覆盖已有文件）。

    data_dir() 调用频繁，用模块级标志确保整个进程只扫一次。
    """
    global _MIGRATED
    with _MIGRATE_LOCK:
        if _MIGRATED:
            return
        _MIGRATED = True
    for name in ("settings.json", "credentials.json", "engine_session.json"):
        if (target / name).exists():
            continue
        for legacy_name in LEGACY_APP_NAMES:
            source = base / legacy_name / name
            if not source.is_file():
                continue
            try:
                shutil.copy2(source, target / name)
            except OSError:
                pass
            break


def _read_json(name: str) -> Dict[str, Any]:
    file = data_dir() / name
    try:
        # utf-8-sig：兼容记事本等编辑器保存时写入的 BOM，避免整个配置被判为损坏
        with file.open("r", encoding="utf-8-sig") as fp:
            data = json.load(fp)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


_WRITE_LOCK = threading.RLock()


def _write_json(name: str, data: Dict[str, Any]) -> None:
    """原子写入 + 串行化。

    前端可能同时发多个 /api/settings（例如速度与跳过已完成各一个），
    共用同一个 .tmp 文件在 Windows 上会相互抢占并抛 PermissionError。
    """
    file = data_dir() / name
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    with _WRITE_LOCK:
        last_error: OSError = OSError("写入 %s 失败" % name)
        for attempt in range(5):
            tmp = file.with_name("%s.%d.%d.tmp" % (name, os.getpid(), threading.get_ident()))
            try:
                with tmp.open("w", encoding="utf-8") as fp:
                    fp.write(payload)
                os.replace(tmp, file)
                return
            except OSError as exc:
                last_error = exc
                try:
                    tmp.unlink()
                except OSError:
                    pass
                time.sleep(0.05 * (attempt + 1))
        raise last_error


def load_settings() -> Dict[str, Any]:
    settings = dict(DEFAULT_SETTINGS)
    settings.update({k: v for k, v in _read_json("settings.json").items() if k in DEFAULT_SETTINGS})
    return settings


def save_settings(patch: Dict[str, Any]) -> Dict[str, Any]:
    with _WRITE_LOCK:
        settings = load_settings()
        for key, value in patch.items():
            if key in DEFAULT_SETTINGS and value is not None:
                settings[key] = value
        _write_json("settings.json", settings)
        return settings


def load_credentials() -> Dict[str, Any]:
    return _read_json("credentials.json")


def save_credentials(data: Dict[str, Any]) -> None:
    _write_json("credentials.json", data)


def clear_credentials() -> None:
    try:
        (data_dir() / "credentials.json").unlink()
    except OSError:
        pass


# ------------------------------------------------------------------ 播放会话
# 记录“开始学习”时的队列。关掉前端时任务会被停止，下次打开时据此自动续播。
def load_session() -> Dict[str, Any]:
    data = _read_json("engine_session.json")
    if not isinstance(data.get("task_ids"), list):
        return {}
    return data


def save_session(data: Dict[str, Any]) -> None:
    try:
        _write_json("engine_session.json", data)
    except OSError:
        pass


def clear_session() -> None:
    try:
        (data_dir() / "engine_session.json").unlink()
    except OSError:
        pass
