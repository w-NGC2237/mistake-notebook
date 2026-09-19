"""比对 Python 端和 JS 端的分类 / 拆题结果是否一致。

用法：
    .venv\\Scripts\\python.exe tools\\parity_py.py > tools\\out_py.json
    node tools\\parity.mjs > tools\\out_js.json
    .venv\\Scripts\\python.exe tools\\check_parity.py

置信度允许 0.02 的误差（两边浮点取整方式不同），其余字段必须完全一致。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOLERANCE = 0.02


def diff(a, b, path=""):
    """返回不一致的字段列表。"""
    if isinstance(a, dict) and isinstance(b, dict):
        bad = []
        for k in sorted(set(a) | set(b)):
            bad += diff(a.get(k), b.get(k), f"{path}.{k}" if path else k)
        return bad
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return [f"{path}: 长度 {len(a)} vs {len(b)}"]
        bad = []
        for i, (x, y) in enumerate(zip(a, b)):
            bad += diff(x, y, f"{path}[{i}]")
        return bad
    if isinstance(a, float) and isinstance(b, float) and path.endswith("confidence"):
        return [] if abs(a - b) <= TOLERANCE else [f"{path}: {a} vs {b}"]
    return [] if a == b else [f"{path}: {a!r} vs {b!r}"]


def main() -> int:
    py = json.loads((ROOT / "tools" / "out_py.json").read_text(encoding="utf-8"))
    js = json.loads((ROOT / "tools" / "out_js.json").read_text(encoding="utf-8"))
    total, bad = 0, 0
    for key in ("classify", "parse"):
        for i, (a, b) in enumerate(zip(py[key], js[key])):
            total += 1
            problems = diff(a, b)
            if problems:
                bad += 1
                print(f"!! {key}[{i}]")
                for p in problems:
                    print("     ", p)
    print(f"\n比对完成：{total - bad}/{total} 条一致")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
