"""把 classifier.py 里的分类词表导出成 JS，保证 App 端和电脑端规则完全一致。

改了 classifier.py 之后重新跑一次：
    .venv\\Scripts\\python.exe tools\\gen_classifier_data.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import classifier  # noqa: E402

OUT = ROOT / "static" / "lib" / "classifier_data.js"


def main() -> None:
    payload = {
        "categories": classifier.CATEGORIES,
        "defaultCategory": classifier.DEFAULT_CATEGORY,
        "subtypes": classifier.SUBTYPES,
        "sources": classifier.SOURCES,
        "errorTags": classifier.ERROR_TAGS,
        "timeBudget": classifier.TIME_BUDGET,
        "categoryKeywords": classifier.CATEGORY_KEYWORDS,
        "subtypeKeywords": classifier.SUBTYPE_KEYWORDS,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    OUT.write_text(
        "// 由 tools/gen_classifier_data.py 自动生成，请不要手改。\n"
        "// 数据源：classifier.py\n"
        f"export const DATA = {body};\n",
        encoding="utf-8",
    )
    total = sum(len(v) for v in classifier.CATEGORY_KEYWORDS.values())
    print(f"写入 {OUT.relative_to(ROOT)}：{len(classifier.CATEGORIES)} 个模块，"
          f"{total} 条模块关键词")


if __name__ == "__main__":
    main()
