"""定位验证码 / 加密模块。

优先使用本项目自带的 vendor 目录（打包后也能运行），
找不到时回退到原项目根目录（只读导入，不修改原文件）。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional

_cached_root: Optional[Path] = None


def _is_module_root(path: Path) -> bool:
    try:
        return (path / "captcha" / "captcha.py").is_file() and (path / "encrypt" / "encrypt.py").is_file()
    except OSError:
        return False


def find_legacy_root() -> Optional[Path]:
    global _cached_root
    if _cached_root is not None:
        return _cached_root

    candidates = []
    override = os.environ.get("ZHS_LEGACY_ROOT")
    if override:
        candidates.append(Path(override))

    candidates.append(Path(__file__).resolve().parents[1] / "vendor")
    candidates.extend(Path(__file__).resolve().parents)

    for path in candidates:
        if _is_module_root(path):
            _cached_root = path
            return path
    return None


def ensure_legacy_path() -> Path:
    root = find_legacy_root()
    if root is None:
        raise RuntimeError(
            "未找到 captcha / encrypt 模块，请确认 backend/vendor 目录存在，"
            "或设置环境变量 ZHS_LEGACY_ROOT 指向原项目根目录"
        )
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    return root
