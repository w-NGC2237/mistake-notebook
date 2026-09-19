"""OCR 引擎封装。

默认使用 RapidOCR（基于 ONNX Runtime 的离线中文识别引擎），
首次运行会自动下载约 15MB 的模型文件，之后完全离线可用。
"""
from __future__ import annotations

import re
import threading
from pathlib import Path

_engine = None
_lock = threading.Lock()
_load_error: str | None = None


def available() -> bool:
    """检测 OCR 依赖是否已安装。"""
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


def _group_lines(items: list[tuple[float, float, float, str]]) -> list[str]:
    """把识别框按纵向位置聚成行，再按横向位置排序。"""
    items = sorted(items, key=lambda it: it[1])
    lines: list[dict] = []
    for cx, cy, height, text in items:
        for line in lines:
            tolerance = max(height, line["h"]) * 0.6
            if abs(line["cy"] - cy) <= tolerance:
                line["items"].append((cx, text))
                line["cy"] = (line["cy"] * line["n"] + cy) / (line["n"] + 1)
                line["h"] = max(line["h"], height)
                line["n"] += 1
                break
        else:
            lines.append({"cy": cy, "h": height, "n": 1, "items": [(cx, text)]})
    lines.sort(key=lambda l: l["cy"])
    return [
        "  ".join(t for _, t in sorted(line["items"], key=lambda p: p[0]))
        for line in lines
    ]


_CJK = r"\u4e00-\u9fff\u3000-\u303f\uff00-\uffef"


def clean_text(text: str) -> str:
    """去掉 OCR 常见噪声：汉字间的多余空格、孤立的噪点字符。"""
    if not text:
        return ""
    text = text.replace("\u00a0", " ")
    text = re.sub(rf"(?<=[{_CJK}])\s+(?=[{_CJK}])", "", text)
    text = re.sub(r"[\u200b-\u200f\ufeff]", "", text)
    text = re.sub(r"[ \t]{2,}", "  ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # 修常见的识别错误：中文语境里的英文句点、全角括号混用
    text = re.sub(r"(?<=[\u4e00-\u9fff])[，,]\s*", "，", text)
    return text.strip()


def _dedupe(texts: list[str]) -> list[str]:
    """RapidOCR 偶尔对同一行输出多次，这里去掉连续重复。"""
    out: list[str] = []
    for t in texts:
        key = re.sub(r"\s+", "", t)
        if not key:
            continue
        if out and re.sub(r"\s+", "", out[-1]) == key:
            continue
        out.append(t)
    return out


def recognize(image_path: str | Path) -> dict:
    """识别一张图片，返回 {text, lines, engine, avg_score}。"""
    engine = _get_engine()
    result, _elapse = engine(str(image_path))
    items: list[tuple[float, float, float, str]] = []
    scores: list[float] = []
    for entry in result or []:
        box, text, score = entry[0], entry[1], entry[2]
        if not text or not str(text).strip():
            continue
        ys = [float(p[1]) for p in box]
        xs = [float(p[0]) for p in box]
        cy = sum(ys) / len(ys)
        cx = sum(xs) / len(xs)
        height = max(ys) - min(ys)
        items.append((cx, cy, height, str(text).strip()))
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
    }
