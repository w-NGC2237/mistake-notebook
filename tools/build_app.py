"""把 static/ 组装成 Capacitor 用的 www/ 目录。

只做两件事：拷贝文件、把 OCR 引擎里对 onnxruntime 的裸模块引用改成相对路径。
改完 static/ 里任何东西，重新跑一次本脚本再打包即可。
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP = {"ocrtest.html", "ocrtest2.html", "ocrtest.png"}

# 浏览器不认识裸模块名，改成相对路径后就不需要 import map 了
ORT_REWRITE = [
    ('from "onnxruntime-web"', 'from "../ort/ort.wasm.min.mjs"'),
]


def main() -> int:
    src = ROOT / "static"
    dst = ROOT / "app" / "www"
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)

    count = 0
    for path in sorted(src.rglob("*")):
        rel = path.relative_to(src)
        if any(part in SKIP for part in rel.parts):
            continue
        target = dst / rel
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix == ".js":
            text = path.read_text(encoding="utf-8")
            for old, new in ORT_REWRITE:
                text = text.replace(old, new)
            target.write_text(text, encoding="utf-8")
        else:
            shutil.copy2(path, target)
        count += 1

    total = sum(p.stat().st_size for p in dst.rglob("*") if p.is_file())
    print(f"已生成 {dst}")
    print(f"  {count} 个文件，共 {total / 1024 / 1024:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
