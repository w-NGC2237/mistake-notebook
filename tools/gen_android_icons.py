"""生成安卓启动图标和启动图。

输出到 app/android/app/src/main/res/ 下的各密度目录。
改完图标重新跑一次即可：.venv\\Scripts\\python.exe tools\\gen_android_icons.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "app" / "android" / "app" / "src" / "main" / "res"

TOP = (99, 91, 255)
BOTTOM = (72, 60, 200)
FLAT = (88, 84, 232)
FONT_PATH = r"C:\Windows\Fonts\msyhbd.ttc"

DENSITIES = {
    "mdpi": 1.0,
    "hdpi": 1.5,
    "xhdpi": 2.0,
    "xxhdpi": 3.0,
    "xxxhdpi": 4.0,
}

SPLASH_SIZES = {
    "drawable-land-mdpi": (480, 320),
    "drawable-land-hdpi": (800, 480),
    "drawable-land-xhdpi": (1280, 720),
    "drawable-land-xxhdpi": (1600, 960),
    "drawable-land-xxxhdpi": (1920, 1280),
    "drawable-port-mdpi": (320, 480),
    "drawable-port-hdpi": (480, 800),
    "drawable-port-xhdpi": (720, 1280),
    "drawable-port-xxhdpi": (960, 1600),
    "drawable-port-xxxhdpi": (1280, 1920),
    "drawable": (480, 320),
}


def gradient(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(size - 1, 1)
        d.line([(0, y), (size, y)],
               fill=tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)) + (255,))
    return img


def draw_glyph(img: Image.Image, ratio: float = 0.54, dy: float = -0.02) -> None:
    size = img.size[0]
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT_PATH, int(size * ratio))
    box = d.textbbox((0, 0), "错", font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1] + size * dy),
           "错", font=font, fill=(255, 255, 255, 255))


def rounded_mask(size: int, radius_ratio: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255)
    return mask


def circle_mask(size: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
    return mask


def main() -> None:
    for name, scale in DENSITIES.items():
        folder = RES / f"mipmap-{name}"
        folder.mkdir(parents=True, exist_ok=True)

        # 传统方形图标
        legacy = int(48 * scale)
        square = gradient(legacy)
        square.putalpha(rounded_mask(legacy, 0.20))
        draw_glyph(square, 0.56)
        square.convert("RGBA").save(folder / "ic_launcher.png")

        # 圆形图标
        round_img = gradient(legacy)
        round_img.putalpha(circle_mask(legacy))
        draw_glyph(round_img, 0.50)
        round_img.save(folder / "ic_launcher_round.png")

        # 自适应图标的前景层：108dp 画布，内容只占中间安全区
        fg = int(108 * scale)
        foreground = Image.new("RGBA", (fg, fg), (0, 0, 0, 0))
        inner = gradient(int(fg * 0.60))
        inner.putalpha(rounded_mask(inner.size[0], 0.24))
        draw_glyph(inner, 0.56)
        foreground.alpha_composite(inner, (int(fg * 0.20), int(fg * 0.20)))
        foreground.save(folder / "ic_launcher_foreground.png")

    # 启动图：纯色底 + 居中图标
    for folder, (w, h) in SPLASH_SIZES.items():
        target = RES / folder
        target.mkdir(parents=True, exist_ok=True)
        canvas = Image.new("RGB", (w, h), FLAT)
        badge = int(min(w, h) * 0.30)
        icon = gradient(badge)
        icon.putalpha(rounded_mask(badge, 0.22))
        draw_glyph(icon, 0.56)
        canvas.paste(icon, ((w - badge) // 2, (h - badge) // 2), icon)
        canvas.save(target / "splash.png")

    (RES / "values").mkdir(parents=True, exist_ok=True)
    (RES / "values" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        '    <color name="ic_launcher_background">#5854E8</color>\n'
        "</resources>\n",
        encoding="utf-8",
    )
    print("图标和启动图已生成")


if __name__ == "__main__":
    main()
