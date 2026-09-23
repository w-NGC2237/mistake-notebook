"""生成用于自测的合成题图（倾斜、带手写笔迹）。

用法： .venv\Scripts\python.exe tools\make_test_images.py
输出到 .testimg/ 目录，供 tools/parity_image.py 等脚本使用。
"""
from __future__ import annotations

import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".testimg"
FONT = r"C:\Windows\Fonts\msyh.ttc"

LINES = [
    "1. 甲、乙两个工程队合作完成一项工程需要12天，甲队单独完成需要20天。",
    "A.25天          B.30天          C.28天          D.32天",
    "2. 科学传播不能只停留在知识搬运上，而应帮助公众建立思维框架。",
    "A.建立          B.树立          C.构筑          D.搭建",
    "3. 以下哪项如果为真，最能削弱上述论证？",
    "A.样本量过小          B.存在其他变量",
]


def render(path: Path, angle: float = 0.0, pen: bool = False) -> tuple[int, int]:
    font = ImageFont.truetype(FONT, 30)
    w, h = 1300, 90 + 74 * len(LINES)
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)
    for i, t in enumerate(LINES):
        d.text((40, 40 + i * 74), t, font=font, fill=(20, 20, 20))
    if pen:
        d.ellipse([30, 96, 300, 158], outline=(210, 30, 40), width=6)     # 红笔圈选
        d.line([(320, 130), (345, 155), (395, 95)], fill=(210, 30, 40), width=7)  # 红笔打勾
        d.line([(40, 238), (620, 244)], fill=(30, 60, 200), width=5)      # 蓝笔划线
        for i in range(120):                                              # 铅笔涂抹
            d.line([(1100 + random.randint(-14, 14), 30 + i * 5),
                    (1180 + random.randint(-14, 14), 34 + i * 5)],
                   fill=(150, 150, 150), width=4)
    if angle:
        img = img.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=(255, 255, 255))
    img.save(path, quality=92)
    return img.size


def main() -> None:
    OUT.mkdir(exist_ok=True)
    random.seed(7)
    for name, angle, pen in [("clean.jpg", 0, False), ("tilt.jpg", -4.0, False),
                             ("pen.jpg", 0, True), ("tilt_pen.jpg", -4.0, True)]:
        print(f"  {name:<14} {render(OUT / name, angle, pen)}")
    print("已生成到", OUT)


if __name__ == "__main__":
    main()
