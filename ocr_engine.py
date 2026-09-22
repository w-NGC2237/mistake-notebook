"""OCR 引擎封装（电脑端）。

识别前会先做一次图片预处理：
  1. 去彩色手写笔迹（红笔、蓝笔批注）—— 印刷黑字几乎没有饱和度，按饱和度剔除
  2. 去浅色铅笔痕 —— 铅笔是浅灰细线，周围没有很黑的像素，据此和印刷字区分
  3. 自动扶正 —— 投影法估计文字行倾角并转正，解决拍照不水平导致的错行

算法和 App 端的 static/lib/imageproc.js 保持一致。
"""
from __future__ import annotations

import re
import threading
from pathlib import Path

import numpy as np
from PIL import Image

_engine = None
_lock = threading.Lock()
_load_error: str | None = None

DEFAULT_OPS = {"ink": True, "pencil": True, "deskew": True}


def available() -> bool:
    try:
        import rapidocr_onnxruntime  # noqa: F401

        return True
    except Exception:
        return False


def load_error() -> str | None:
    return _load_error


def _get_engine():
    global _engine, _load_error
    if _engine is not None:
        return _engine
    with _lock:
        if _engine is None:
            try:
                from rapidocr_onnxruntime import RapidOCR

                _engine = RapidOCR()
                _load_error = None
            except Exception as exc:  # pragma: no cover - 环境问题
                _load_error = f"{type(exc).__name__}: {exc}"
                raise
    return _engine


# ---------------------------------------------------------------- 预处理


def _otsu(lum: np.ndarray) -> int:
    hist = np.bincount(lum.ravel(), minlength=256).astype(np.float64)
    total = hist.sum()
    if total <= 0:
        return 128
    idx = np.arange(256)
    sum_all = float((hist * idx).sum())
    w_b = np.cumsum(hist)
    sum_b = np.cumsum(hist * idx)
    w_f = total - w_b
    valid = (w_b > 0) & (w_f > 0)
    if not valid.any():
        return 128
    m_b = np.divide(sum_b, w_b, out=np.zeros_like(sum_b), where=w_b > 0)
    m_f = np.divide(sum_all - sum_b, w_f, out=np.zeros_like(sum_b), where=w_f > 0)
    between = np.where(valid, w_b * w_f * (m_b - m_f) ** 2, -1.0)
    return int(between.argmax())


def _dilate3(mask: np.ndarray) -> np.ndarray:
    """3x3 八邻域膨胀，不需要 scipy。"""
    out = mask.copy()
    out[1:, :] |= mask[:-1, :]
    out[:-1, :] |= mask[1:, :]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    out[1:, 1:] |= mask[:-1, :-1]
    out[:-1, :-1] |= mask[1:, 1:]
    out[1:, :-1] |= mask[:-1, 1:]
    out[:-1, 1:] |= mask[1:, :-1]
    return out


def _luminance(arr: np.ndarray) -> np.ndarray:
    return (arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114).astype(np.uint8)


def erase_handwriting(arr: np.ndarray, ink: bool = True, pencil: bool = True) -> dict:
    """就地擦除手写笔迹（改成白色），arr 为 HxWx3 的 RGB。"""
    lum = _luminance(arr)
    thr = _otsu(lum)
    mx = arr.max(axis=2).astype(np.int16)
    mn = arr.min(axis=2).astype(np.int16)
    sat = np.divide(mx - mn, np.maximum(mx, 1), out=np.zeros_like(mx, dtype=np.float64), where=mx > 0)

    # 色差 delta 用来排除 JPEG 在文字边缘的彩色噪点，只留真正的笔迹
    colored = (sat > 0.26) & ((mx - mn) > 50) & (mx > 40)
    # 向外膨胀一圈，把笔迹边缘的抗锯齿光晕一起擦掉，
    # 否则残留的"小尾巴"会被 OCR 读成逗号之类的标点
    grown = _dilate3(colored) if colored.any() else colored
    ink_count = 0
    if ink:
        ink_count = int(grown.sum())
        if ink_count:
            arr[grown] = 255

    pencil_count = 0
    if pencil:
        core_thr = max(40, int(thr * 0.6))
        core = lum <= core_thr
        if core.sum() > lum.size * 0.0005:
            guard = _dilate3(core)
            lo = max(70, int(thr * 0.72))
            hi = 218
            gray = (lum >= lo) & (lum <= hi)
            cand = gray & (~guard) & (~grown)
            pencil_count = int(cand.sum())
            if pencil_count:
                arr[cand] = 255

    return {"inkRemoved": ink_count, "pencilRemoved": pencil_count}


def estimate_skew(gray: np.ndarray, max_side: int = 640, angle_range: float = 10.0) -> tuple[float, float]:
    """投影法估计文字行倾角，返回 (倾角, 置信增益)。

    倾角是「文字行的斜率角」：正数表示文字向右下倾斜。
    把它交给 PIL 的 rotate() 就能转正。
    """
    h, w = gray.shape[:2]
    scale = max_side / max(h, w)
    if scale < 1:
        small = np.asarray(
            Image.fromarray(gray).resize((max(16, int(w * scale)), max(16, int(h * scale)))),
            dtype=np.uint8,
        )
    else:
        small = gray
    thr = _otsu(small)
    ys, xs = np.nonzero(small < thr)
    if xs.size < 60:
        return 0.0, 0.0
    stride = max(1, xs.size // 40000)
    xs = xs[::stride].astype(np.float64)
    ys = ys[::stride].astype(np.float64)

    bin_h = 2.0
    span = int((small.shape[0] + small.shape[1] * np.tan(np.radians(angle_range))) / bin_h) + 4
    edges = np.arange(span + 1) * bin_h - (span * bin_h) / 2

    def score(deg: float) -> float:
        m = np.tan(np.radians(deg))
        t = ys - m * xs
        hist, _ = np.histogram(t, bins=span, range=(edges[0], edges[-1]))
        return float((hist.astype(np.float64) ** 2).sum() / hist.size / max(xs.size, 1))

    coarse = [d * 1.0 for d in range(-10, 11)]
    best_deg = max(coarse, key=score)
    fine_best = best_deg
    fine_score = score(best_deg)
    d = best_deg - 1.0
    while d <= best_deg + 1.0 + 1e-9:
        s = score(d)
        if s > fine_score:
            fine_score = s
            fine_best = d
        d += 0.2
    zero = score(0.0)
    gain = (fine_score - zero) / zero if zero > 0 else 0.0
    if gain <= 0.02:
        return 0.0, round(gain, 3)
    return round(fine_best, 2), round(gain, 3)


def preprocess(img: Image.Image, ops: dict | None = None) -> tuple[Image.Image, dict]:
    """返回 (处理后的图片, 处理信息)。"""
    o = {**DEFAULT_OPS, **(ops or {})}
    meta = {"inkRemoved": 0, "pencilRemoved": 0, "angle": 0, "deskewGain": 0}

    if img.mode != "RGB":
        img = img.convert("RGB")

    if o["ink"] or o["pencil"]:
        arr = np.asarray(img, dtype=np.uint8).copy()
        stat = erase_handwriting(arr, ink=o["ink"], pencil=o["pencil"])
        meta.update(stat)
        img = Image.fromarray(arr, "RGB")

    if o["deskew"]:
        gray = np.asarray(img.convert("L"), dtype=np.uint8)
        angle, gain = estimate_skew(gray)
        meta["deskewGain"] = gain
        if abs(angle) >= 0.25:
            img = img.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=(255, 255, 255))
            meta["angle"] = angle

    return img, meta


# ---------------------------------------------------------------- 分行


def _group_lines(items: list[tuple[float, float, float, float, str]]) -> list[str]:
    """把识别框按行分组。容差取所有框高的中位数，避免行高差异大时串行。

    items: (cx, cy, height, width, text)
    """
    items = sorted(items, key=lambda it: it[1])
    if not items:
        return []
    heights = sorted(it[2] for it in items)
    med_h = heights[len(heights) // 2] or 20
    tol = max(6.0, med_h * 0.5)

    rows: list[dict] = []
    for cx, cy, height, _width, text in items:
        best = None
        best_dist = float("inf")
        for row in rows:
            dist = abs(row["cy"] - cy)
            if dist <= tol and dist < best_dist:
                best, best_dist = row, dist
        if best is not None:
            best["items"].append((cx, text))
            best["cy"] = (best["cy"] * best["n"] + cy) / (best["n"] + 1)
            best["n"] += 1
        else:
            rows.append({"cy": cy, "n": 1, "items": [(cx, text)]})

    rows.sort(key=lambda r: r["cy"])
    return [
        "  ".join(t for _, t in sorted(row["items"], key=lambda p: p[0]))
        for row in rows
    ]


_CJK = r"\u4e00-\u9fff\u3000-\u303f\uff00-\uffef"


def clean_text(text: str) -> str:
    if not text:
        return ""
    text = text.replace("\u00a0", " ")
    text = re.sub(rf"(?<=[{_CJK}])\s+(?=[{_CJK}])", "", text)
    text = re.sub(r"[\u200b-\u200f\ufeff]", "", text)
    text = re.sub(r"[ \t]{2,}", "  ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"(?<=[\u4e00-\u9fff])[，,]\s*", "，", text)
    return text.strip()


def _dedupe(texts: list[str]) -> list[str]:
    out: list[str] = []
    for t in texts:
        key = re.sub(r"\s+", "", t)
        if not key:
            continue
        if out and re.sub(r"\s+", "", out[-1]) == key:
            continue
        out.append(t)
    return out


def recognize(image: str | Path | Image.Image, ops: dict | None = None) -> dict:
    """识别一张图片，返回 {text, lines, engine, avg_score, proc}。"""
    engine = _get_engine()
    img = image if isinstance(image, Image.Image) else Image.open(image)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    prepared, meta = preprocess(img, ops)

    result, _elapse = engine(np.asarray(prepared))
    items: list[tuple[float, float, float, float, str]] = []
    scores: list[float] = []
    for entry in result or []:
        box, text, score = entry[0], entry[1], entry[2]
        if not text or not str(text).strip():
            continue
        ys = [float(p[1]) for p in box]
        xs = [float(p[0]) for p in box]
        cy = sum(ys) / len(ys)
        cx = sum(xs) / len(xs)
        items.append((cx, cy, max(ys) - min(ys), max(xs) - min(xs), str(text).strip()))
        try:
            scores.append(float(score))
        except (TypeError, ValueError):
            pass
    lines = _dedupe(_group_lines(items))
    return {
        "text": clean_text("\n".join(lines)),
        "lines": lines,
        "engine": "rapidocr",
        "avg_score": round(sum(scores) / len(scores), 4) if scores else None,
        "proc": meta,
    }
