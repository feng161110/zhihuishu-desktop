"""生成 Tauri 所需的图标文件（基于 frontend/public/frog.png）。

用法：python scripts/gen_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "public" / "frog.png"
OUT_DIR = ROOT / "frontend" / "src-tauri" / "icons"
SIZE = 512
RADIUS_RATIO = 0.22


def build_base() -> Image.Image:
    frog = Image.open(SRC).convert("RGBA")
    # 居中裁成正方形，再缩放到目标尺寸
    w, h = frog.size
    side = min(w, h)
    left, top = (w - side) // 2, (h - side) // 2
    frog = frog.crop((left, top, left + side, top + side)).resize((SIZE, SIZE), Image.LANCZOS)

    # 圆角方形蒙版，与旧版蓝色印章图标的形状保持一致
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, SIZE - 1, SIZE - 1), radius=int(SIZE * RADIUS_RATIO), fill=255
    )
    base = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    base.paste(frog, (0, 0), mask)
    return base


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    base = build_base()

    targets = {
        "32x32.png": 32,
        "64x64.png": 64,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
        "Square150x150Logo.png": 150,
        "Square44x44Logo.png": 44,
        "StoreLogo.png": 50,
    }
    for name, size in targets.items():
        base.resize((size, size), Image.LANCZOS).save(OUT_DIR / name)

    base.save(
        OUT_DIR / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("icons generated ->", OUT_DIR)


if __name__ == "__main__":
    main()
