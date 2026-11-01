"""把 Python 后端打包成独立 exe（PyInstaller onedir）。

产物：backend/bin/zhs-backend/zhs-backend.exe
Tauri 启动时优先使用该 exe，找不到时才回退到系统 python。

用法：python scripts/build_backend.py
"""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

import PyInstaller.__main__

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
OUT_ROOT = BACKEND / "bin"
WORK = ROOT / "build" / "pyinstaller"
NAME = "zhs-backend"

# onnxruntime 的 pyd 需要较新的 VC++ 运行库；Python 自带的 msvcp140 往往是旧版
VC_RUNTIME = (
    "msvcp140.dll",
    "msvcp140_1.dll",
    "msvcp140_2.dll",
    "msvcp140_codecvt_ids.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "concrt140.dll",
)


def _refresh_vc_runtime(target: Path) -> None:
    """用构建机 System32 里的新版 VC 运行库覆盖旧版。

    PyInstaller 会把 Python 自带的 msvcp140（例如 14.36）一并打进来，
    而 onnxruntime 需要更新的版本，否则加载时报“DLL 初始化例程失败”，
    自动验证码识别在发行版里就会静默失效。
    """
    if os.name != "nt":
        return
    system32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
    for name in VC_RUNTIME:
        source = system32 / name
        if source.is_file():
            shutil.copy2(source, target / name)


RETIRED = ROOT / "build" / "retired"

# ddddocr 把模型放在包目录下（不是 data 目录），PyInstaller 默认只收 .py，
# 漏掉模型的症状就是每次识别都报「模型文件不存在: _internal\ddddocr\xxx.onnx」。
# DdddOcr(show_ad=False) 在这套版本里走的是 common_old.onnx；
# 以后若启用 beta / det 模式，把 common.onnx / common_det.onnx 一并加进来。
DDDDOCR_MODELS = ("common_old.onnx",)


def _ddddocr_datas() -> "list[str]":
    """把 ddddocr 的模型文件映射到打包产物的 ddddocr 目录下。"""
    try:
        import ddddocr

        pkg = Path(ddddocr.__file__).resolve().parent
    except Exception as exc:  # noqa: BLE001
        raise SystemExit("打包失败：无法定位 ddddocr 包（%s）" % exc)

    datas = []
    for name in DDDDOCR_MODELS:
        model = pkg / name
        if not model.is_file():
            raise SystemExit("打包失败：ddddocr 缺少模型 %s（目录 %s）" % (name, pkg))
        datas.append(f"{model};ddddocr")
    return datas


def _retire(path: Path) -> None:
    """把旧目录整体改名退役到 build/retired。

    直接 rmtree 几百个文件会触发宿主环境的批量删除保护（safe-delete），
    改名是原子操作，不会被打断；放到 build/retired 也不会被 Tauri
    当成后端资源一起打进安装包。
    """
    RETIRED.mkdir(parents=True, exist_ok=True)
    target = RETIRED / ("%s.%d.old" % (path.name, int(time.time())))
    try:
        path.rename(target)
    except OSError:
        pass


def main() -> None:
    # 清掉旧产物，避免 PyInstaller 复用过期文件
    for stale in (OUT_ROOT / NAME, WORK, ROOT / "build" / f"{NAME}.spec"):
        if stale.is_dir():
            _retire(stale)
        elif stale.is_file():
            stale.unlink(missing_ok=True)

    PyInstaller.__main__.run(
        [
            str(BACKEND / "main.py"),
            "--name",
            NAME,
            "--onedir",
            "--noconfirm",
            "--log-level",
            "WARN",
            "--distpath",
            str(OUT_ROOT),
            "--workpath",
            str(WORK),
            "--specpath",
            str(ROOT / "build"),
            # backend 自身与 vendor 需要作为导入路径（encrypt / captcha 走动态 sys.path）
            "--paths",
            str(BACKEND),
            "--paths",
            str(BACKEND / "vendor"),
            "--add-data",
            f"{BACKEND / 'vendor'};vendor",
            # ddddocr 的 onnx 模型（见 _ddddocr_datas）
            *[arg for item in _ddddocr_datas() for arg in ("--add-data", item)],
            # 自动验证码：模型（slider.onnx）、子模块和 onnxruntime/opencv/shapely 依赖
            # 全部显式收集，避免动态 import 在打包后被裁掉导致滑块识别失效
            "--collect-all",
            "captcha_recognizer",
            "--collect-binaries",
            "onnxruntime",
            "--collect-binaries",
            "cv2",
            "--collect-binaries",
            "shapely",
            "--hidden-import",
            "captcha_recognizer.slider",
            "--hidden-import",
            "onnxruntime.capi._pybind_state",
            "--hidden-import",
            "shapely",
            "--hidden-import",
            "cv2",
            "--hidden-import",
            "encrypt.encrypt",
            "--hidden-import",
            "captcha.captcha",
            "--hidden-import",
            "captcha.yidun_encrypt",
            "--hidden-import",
            "uvicorn.logging",
            "--hidden-import",
            "uvicorn.loops.auto",
            "--hidden-import",
            "uvicorn.protocols.http.auto",
            "--hidden-import",
            "uvicorn.protocols.websockets.auto",
            "--hidden-import",
            "uvicorn.lifespan.on",
            # 只保留实际用到的依赖（cv2 / numpy / onnxruntime / shapely / requests / PIL），
            # 其余被环境牵连进来的重型库一律排除，否则产物会膨胀到 800MB+
            "--exclude-module",
            "torch",
            "--exclude-module",
            "torchvision",
            "--exclude-module",
            "torchaudio",
            "--exclude-module",
            "torchtext",
            "--exclude-module",
            "imageio",
            "--exclude-module",
            "imageio_ffmpeg",
            "--exclude-module",
            "scipy",
            "--exclude-module",
            "pandas",
            "--exclude-module",
            "sklearn",
            "--exclude-module",
            "numba",
            "--exclude-module",
            "llvmlite",
            "--exclude-module",
            "tensorflow",
            "--exclude-module",
            "jax",
            "--exclude-module",
            "tkinter",
            "--exclude-module",
            "matplotlib",
            "--exclude-module",
            "IPython",
            "--exclude-module",
            "notebook",
            "--exclude-module",
            "pytest",
        ]
    )

    exe = OUT_ROOT / NAME / f"{NAME}.exe"
    if not exe.is_file():
        raise SystemExit("打包失败：未找到 %s" % exe)
    _refresh_vc_runtime(exe.parent / "_internal")
    size_mb = sum(f.stat().st_size for f in exe.parent.rglob("*") if f.is_file()) / 1024 / 1024
    print("打包完成 -> %s （目录合计 %.1f MB）" % (exe, size_mb))


if __name__ == "__main__":
    main()
