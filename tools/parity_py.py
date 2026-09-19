"""跑一遍 parity_cases.json，输出 Python 端结果，用来和 JS 端比对。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import classifier  # noqa: E402
import parser as qp  # noqa: E402


def main() -> None:
    cases = json.loads((ROOT / "tools" / "parity_cases.json").read_text(encoding="utf-8"))
    out = {"classify": [], "parse": []}
    for text, options in cases["classify"]:
        out["classify"].append(classifier.classify(text, options))
    for text in cases["parse"]:
        out["parse"].append(qp.parse(text))
    print(json.dumps(out, ensure_ascii=False, sort_keys=True, indent=1))


if __name__ == "__main__":
    main()
