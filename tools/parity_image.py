"""导出图片像素，供 JS 版做逐像素比对。

注意：浏览器里的 ImageData 是 RGBA 四通道，所以这里也按 RGBA 导出，
否则两边索引方式不一致，比对结果没有意义。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import ocr_engine as oe  # noqa: E402

TMP = ROOT / ".testimg" / "parity"
TMP.mkdir(parents=True, exist_ok=True)


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / ".testimg" / "tilt_pen.jpg"
    img = Image.open(src).convert("RGB")
    rgb = np.asarray(img, dtype=np.uint8)
    h, w = rgb.shape[:2]

    rgba = np.dstack([rgb, np.full((h, w), 255, np.uint8)]).astype(np.uint8)
    (TMP / "meta.json").write_text(json.dumps({"w": w, "h": h}), encoding="utf-8")
    (TMP / "rgba.bin").write_bytes(rgba.tobytes())

    work = rgba[:, :, :3].copy()
    stat = oe.erase_handwriting(work, ink=True, pencil=True)
    (TMP / "py.bin").write_bytes(work.tobytes())

    scale = 640 / max(w, h)
    small = img.resize((max(16, int(w * scale)), max(16, int(h * scale))), Image.LANCZOS) if scale < 1 else img
    gray = np.asarray(small.convert("L"), dtype=np.uint8)
    (TMP / "gray.bin").write_bytes(gray.tobytes())
    (TMP / "gray.json").write_text(json.dumps({"w": gray.shape[1], "h": gray.shape[0]}), encoding="utf-8")

    angle, gain = oe.estimate_skew(gray)
    print(json.dumps({"pyAngle": angle, "pyGain": gain, "inkRemoved": stat["inkRemoved"],
                      "pencilRemoved": stat["pencilRemoved"], "w": w, "h": h}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
