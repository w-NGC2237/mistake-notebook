"""考公错题本 · 本地服务端。

启动后打开 http://127.0.0.1:8765 ，手机连同一个 WiFi 也能访问。
"""
from __future__ import annotations

import csv
import io
import json
import random
import socket
import sqlite3
import uuid
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel

import classifier
import ocr_engine
import parser as question_parser

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
IMAGE_DIR = DATA_DIR / "images"
DB_PATH = DATA_DIR / "cuotiben.db"
STATIC_DIR = BASE_DIR / "static"

DATA_DIR.mkdir(parents=True, exist_ok=True)
IMAGE_DIR.mkdir(parents=True, exist_ok=True)

# 复习间隔（天），按连对次数递进
INTERVALS = [1, 2, 4, 7, 15, 30, 60]

app = FastAPI(title="考公错题本")


# ---------------------------------------------------------------- 数据库

SCHEMA = """
CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    image TEXT,
    raw_text TEXT DEFAULT '',
    stem TEXT DEFAULT '',
    options TEXT DEFAULT '{}',
    answer TEXT DEFAULT '',
    my_answer TEXT DEFAULT '',
    analysis TEXT DEFAULT '',
    category TEXT DEFAULT '常识',
    subtype TEXT DEFAULT '',
    qtype TEXT DEFAULT '选择题',
    tags TEXT DEFAULT '[]',
    source TEXT DEFAULT '',
    note TEXT DEFAULT '',
    difficulty INTEGER DEFAULT 3,
    status TEXT DEFAULT 'new',
    level INTEGER DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    correct_count INTEGER DEFAULT 0,
    wrong_count INTEGER DEFAULT 0,
    last_review_at TEXT,
    next_review_at TEXT
);
CREATE TABLE IF NOT EXISTS review_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    result TEXT NOT NULL,
    answer TEXT DEFAULT '',
    duration_ms INTEGER DEFAULT 0
);
"""

INDEXES = """
CREATE INDEX IF NOT EXISTS idx_q_category ON questions(category);
CREATE INDEX IF NOT EXISTS idx_q_subtype ON questions(subtype);
CREATE INDEX IF NOT EXISTS idx_q_next ON questions(next_review_at);
"""


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """老版本用的是 subject / topic，这里原地改名，不丢数据。"""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(questions)")}
    if "subject" in cols and "category" not in cols:
        conn.execute("ALTER TABLE questions RENAME COLUMN subject TO category")
    if "topic" in cols and "subtype" not in cols:
        conn.execute("ALTER TABLE questions RENAME COLUMN topic TO subtype")


def init_db() -> None:
    with db() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)
        conn.executescript(INDEXES)


init_db()


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def today() -> datetime:
    return datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)


def row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    for key, default in (("options", {}), ("tags", [])):
        try:
            d[key] = json.loads(d.get(key) or json.dumps(default))
        except (json.JSONDecodeError, TypeError):
            d[key] = default
    d["image_url"] = f"/images/{d['image']}" if d.get("image") else None
    return d


# ---------------------------------------------------------------- 图片

MAX_SIDE = 1800


def save_image(data: bytes) -> str:
    """保存并压缩上传的图片，返回文件名。"""
    name = f"{datetime.now():%Y%m%d}-{uuid.uuid4().hex[:10]}.jpg"
    target = IMAGE_DIR / name
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        w, h = img.size
        if max(w, h) > MAX_SIDE:
            scale = MAX_SIDE / max(w, h)
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        img.save(target, "JPEG", quality=92, optimize=True)
    except Exception:
        target.write_bytes(data)
    return name


# ---------------------------------------------------------------- 数据模型


class QuestionIn(BaseModel):
    stem: str = ""
    options: dict[str, str] = {}
    answer: str = ""
    my_answer: str = ""
    analysis: str = ""
    category: str = "常识"
    subtype: str = ""
    qtype: str = "选择题"
    tags: list[str] = []
    source: str = ""
    note: str = ""
    difficulty: int = 3
    image: str | None = None
    raw_text: str = ""
    auto_classify: bool = False


class ReviewIn(BaseModel):
    result: str  # correct | wrong
    answer: str = ""
    duration_ms: int = 0
    self_note: str = ""
    tags: list[str] = []


# ---------------------------------------------------------------- 导入识别


def _draft_item(item: dict) -> dict:
    """补上自动分类结果。"""
    guess = classifier.classify(item.get("stem", ""), item.get("options"))
    item["category"] = guess["category"]
    item["subtype"] = guess["subtype"]
    item["confidence"] = guess["confidence"]
    item["reason"] = guess["reason"]
    return item


@app.post("/api/import")
async def api_import(files: list[UploadFile] = File(...)):
    """上传图片 → OCR → 拆题 → 自动分类，返回待确认的草稿。"""
    if not files:
        raise HTTPException(400, "没有收到图片")
    if not ocr_engine.available():
        raise HTTPException(
            503,
            "OCR 引擎未安装。请在项目目录执行：.venv\\Scripts\\pip install rapidocr-onnxruntime",
        )

    drafts: list[dict] = []
    for upload in files:
        raw_bytes = await upload.read()
        if not raw_bytes:
            continue
        name = save_image(raw_bytes)
        path = IMAGE_DIR / name
        try:
            result = ocr_engine.recognize(path)
        except Exception as exc:
            drafts.append({
                "image": name, "image_url": f"/images/{name}",
                "error": f"识别失败：{exc}", "raw_text": "", "items": [],
            })
            continue

        text = result["text"]
        image_only = classifier.is_image_only(text)
        items = question_parser.parse(text)

        if image_only:
            # 图形推理、统计图表这类题只有图没有字，交给用户手动选题型
            items = [{
                "number": None, "stem": "", "options": {}, "answer": None,
                "analysis": None, "type": "图片题",
            }]
        elif not items:
            items = [{
                "number": None, "stem": text, "options": {}, "answer": None,
                "analysis": None, "type": "选择题",
            }]

        for item in items:
            if image_only:
                item.update(category="判断推理", subtype="图形推理", confidence=0.0,
                            reason="图片题，请手动确认题型")
            else:
                _draft_item(item)

        drafts.append({
            "image": name,
            "image_url": f"/images/{name}",
            "raw_text": text,
            "avg_score": result["avg_score"],
            "image_only": image_only,
            "items": items,
        })

    if not drafts:
        raise HTTPException(400, "图片内容为空")
    return {"drafts": drafts}


@app.post("/api/parse-text")
def api_parse_text(payload: dict):
    """粘贴文字导入：只做拆题和分类。"""
    text = (payload or {}).get("text", "")
    if not text.strip():
        raise HTTPException(400, "内容为空")
    items = question_parser.parse(text) or [{
        "number": None, "stem": text.strip(), "options": {}, "answer": None,
        "analysis": None, "type": "选择题",
    }]
    return {"items": [_draft_item(it) for it in items]}


@app.post("/api/classify")
def api_classify(payload: dict):
    return classifier.classify(
        (payload or {}).get("text", ""), (payload or {}).get("options")
    )


# ---------------------------------------------------------------- 错题读写


@app.get("/api/questions")
def list_questions(
    category: str = "",
    subtype: str = "",
    status: str = "",
    q: str = "",
    due: int = 0,
    random_order: int = 0,
    limit: int = 500,
    offset: int = 0,
):
    where, args = [], []
    if category and category != "全部":
        where.append("category = ?")
        args.append(category)
    if subtype:
        where.append("subtype = ?")
        args.append(subtype)
    if status and status != "全部":
        where.append("status = ?")
        args.append(status)
    if q:
        where.append("(stem LIKE ? OR answer LIKE ? OR subtype LIKE ? OR note LIKE ?)")
        args += [f"%{q}%"] * 4
    if due:
        where.append("(next_review_at IS NULL OR next_review_at <= ?)")
        args.append(now())
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    order = "RANDOM()" if random_order else "id DESC"

    # 打乱时先取全部符合条件的 id 再抽样，避免每次都一样
    if random_order and limit:
        with db() as conn:
            ids = [r["id"] for r in conn.execute(
                f"SELECT id FROM questions {clause}", args
            ).fetchall()]
        random.shuffle(ids)
        picked = ids[:limit]
        if not picked:
            return {"total": 0, "items": []}
        marks = ",".join("?" * len(picked))
        with db() as conn:
            rows = conn.execute(
                f"SELECT * FROM questions WHERE id IN ({marks})", picked
            ).fetchall()
        by_id = {r["id"]: r for r in rows}
        return {"total": len(ids), "items": [row_to_dict(by_id[i]) for i in picked if i in by_id]}

    with db() as conn:
        rows = conn.execute(
            f"SELECT * FROM questions {clause} ORDER BY {order} LIMIT ? OFFSET ?",
            (*args, limit, offset),
        ).fetchall()
        total = conn.execute(f"SELECT COUNT(*) FROM questions {clause}", args).fetchone()[0]
    return {"total": total, "items": [row_to_dict(r) for r in rows]}


@app.get("/api/questions/{qid}")
def get_question(qid: int):
    with db() as conn:
        row = conn.execute("SELECT * FROM questions WHERE id = ?", (qid,)).fetchone()
    if not row:
        raise HTTPException(404, "错题不存在")
    return row_to_dict(row)


@app.post("/api/questions")
def create_question(payload: QuestionIn):
    category, subtype = payload.category, payload.subtype
    if payload.auto_classify or not category or category == "常识" and not subtype:
        guess = classifier.classify(payload.stem, payload.options)
        if payload.auto_classify or category in ("", "常识"):
            category = guess["category"]
        if not subtype:
            subtype = guess["subtype"]
    stamp = now()
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO questions (created_at, updated_at, image, raw_text, stem, options,"
            " answer, my_answer, analysis, category, subtype, qtype, tags, source, note,"
            " difficulty, status, level, review_count, correct_count, wrong_count, next_review_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                stamp, stamp, payload.image, payload.raw_text, payload.stem,
                json.dumps(payload.options, ensure_ascii=False), payload.answer,
                payload.my_answer, payload.analysis, category, subtype, payload.qtype,
                json.dumps(payload.tags, ensure_ascii=False), payload.source, payload.note,
                payload.difficulty, "new", 0, 0, 0, 0, stamp,
            ),
        )
        qid = cur.lastrowid
        row = conn.execute("SELECT * FROM questions WHERE id = ?", (qid,)).fetchone()
    return row_to_dict(row)


@app.put("/api/questions/{qid}")
def update_question(qid: int, payload: QuestionIn):
    with db() as conn:
        exists = conn.execute("SELECT id FROM questions WHERE id = ?", (qid,)).fetchone()
        if not exists:
            raise HTTPException(404, "错题不存在")
        conn.execute(
            "UPDATE questions SET updated_at=?, stem=?, options=?, answer=?, my_answer=?,"
            " analysis=?, category=?, subtype=?, qtype=?, tags=?, source=?, note=?, difficulty=?"
            " WHERE id=?",
            (
                now(), payload.stem, json.dumps(payload.options, ensure_ascii=False),
                payload.answer, payload.my_answer, payload.analysis, payload.category,
                payload.subtype, payload.qtype, json.dumps(payload.tags, ensure_ascii=False),
                payload.source, payload.note, payload.difficulty, qid,
            ),
        )
        row = conn.execute("SELECT * FROM questions WHERE id = ?", (qid,)).fetchone()
    return row_to_dict(row)


@app.delete("/api/questions/{qid}")
def delete_question(qid: int):
    with db() as conn:
        row = conn.execute("SELECT image FROM questions WHERE id = ?", (qid,)).fetchone()
        if not row:
            raise HTTPException(404, "错题不存在")
        conn.execute("DELETE FROM questions WHERE id = ?", (qid,))
        conn.execute("DELETE FROM review_logs WHERE question_id = ?", (qid,))
        if row["image"]:
            still = conn.execute(
                "SELECT COUNT(*) FROM questions WHERE image = ?", (row["image"],)
            ).fetchone()[0]
            if not still:
                try:
                    (IMAGE_DIR / row["image"]).unlink(missing_ok=True)
                except OSError:
                    pass
    return {"ok": True}


@app.post("/api/questions/{qid}/review")
def review_question(qid: int, payload: ReviewIn):
    """做题模式提交一次作答，更新掌握度和下次复习时间。"""
    with db() as conn:
        row = conn.execute("SELECT * FROM questions WHERE id = ?", (qid,)).fetchone()
        if not row:
            raise HTTPException(404, "错题不存在")
        correct = payload.result == "correct"
        level = row["level"] or 0
        level = min(level + 1, len(INTERVALS) - 1) if correct else 0
        days = INTERVALS[level] if correct else 0
        next_at = (today() + timedelta(days=days)).isoformat(timespec="seconds")
        status = "mastered" if level >= 5 else "reviewing"
        conn.execute(
            "UPDATE questions SET review_count = review_count + 1,"
            " correct_count = correct_count + ?, wrong_count = wrong_count + ?, level = ?,"
            " status = ?, last_review_at = ?, next_review_at = ?, updated_at = ? WHERE id = ?",
            (1 if correct else 0, 0 if correct else 1, level, status, now(), next_at, now(), qid),
        )
        conn.execute(
            "INSERT INTO review_logs (question_id, created_at, result, answer, duration_ms)"
            " VALUES (?,?,?,?,?)",
            (qid, now(), payload.result, payload.answer, payload.duration_ms),
        )
        if payload.self_note:
            conn.execute("UPDATE questions SET note = ? WHERE id = ?", (payload.self_note, qid))
        if payload.tags:
            conn.execute(
                "UPDATE questions SET tags = ? WHERE id = ?",
                (json.dumps(payload.tags, ensure_ascii=False), qid),
            )
        conn.execute(
            "DELETE FROM review_logs WHERE question_id = ? AND id NOT IN"
            " (SELECT id FROM review_logs WHERE question_id = ? ORDER BY id DESC LIMIT 50)",
            (qid, qid),
        )
        row = conn.execute("SELECT * FROM questions WHERE id = ?", (qid,)).fetchone()
    return row_to_dict(row)


@app.get("/api/questions/{qid}/logs")
def question_logs(qid: int):
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM review_logs WHERE question_id = ? ORDER BY id DESC LIMIT 50", (qid,)
        ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- 统计


@app.get("/api/stats")
def stats():
    cutoff = (today() - timedelta(days=13)).isoformat(timespec="seconds")
    with db() as conn:
        total = conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0]
        by_category = [
            {"category": r["category"], "count": r["c"]}
            for r in conn.execute(
                "SELECT category, COUNT(*) c FROM questions GROUP BY category ORDER BY c DESC"
            )
        ]
        by_subtype = [
            {"category": r["category"],
             "subtype": r["subtype"] or "未标注",
             "count": r["c"]}
            for r in conn.execute(
                "SELECT category, subtype, COUNT(*) c FROM questions"
                " GROUP BY category, subtype ORDER BY c DESC LIMIT 24"
            )
        ]
        by_status = {
            r["status"]: r["c"]
            for r in conn.execute("SELECT status, COUNT(*) c FROM questions GROUP BY status")
        }
        by_source = [
            {"source": r["source"] or "未标注", "count": r["c"]}
            for r in conn.execute(
                "SELECT source, COUNT(*) c FROM questions GROUP BY source ORDER BY c DESC"
            )
        ]
        by_tag = [
            {"tag": r["tag"], "count": r["c"]}
            for r in conn.execute(
                "SELECT j.value tag, COUNT(*) c FROM questions q, json_each(q.tags) j"
                " GROUP BY j.value ORDER BY c DESC LIMIT 12"
            )
        ]
        due = conn.execute(
            "SELECT COUNT(*) FROM questions WHERE next_review_at IS NULL OR next_review_at <= ?",
            (now(),),
        ).fetchone()[0]
        reviews = conn.execute("SELECT COUNT(*) FROM review_logs").fetchone()[0]
        recent = [
            {"date": r["d"], "count": r["c"]}
            for r in conn.execute(
                "SELECT substr(created_at,1,10) d, COUNT(*) c FROM questions"
                " WHERE created_at >= ? GROUP BY d ORDER BY d",
                (cutoff,),
            )
        ]
        accuracy = conn.execute(
            "SELECT SUM(correct_count) a, SUM(wrong_count) b FROM questions"
        ).fetchone()
        cat_accuracy = [
            {"category": r["category"],
             "correct": r["a"] or 0, "wrong": r["b"] or 0}
            for r in conn.execute(
                "SELECT category, SUM(correct_count) a, SUM(wrong_count) b FROM questions"
                " GROUP BY category HAVING (a + b) > 0 ORDER BY category"
            )
        ]
    cor, wro = (accuracy["a"] or 0), (accuracy["b"] or 0)
    return {
        "total": total,
        "due": due,
        "review_count_total": reviews,
        "by_category": by_category,
        "by_subtype": by_subtype,
        "by_status": by_status,
        "by_source": by_source,
        "by_tag": by_tag,
        "recent": recent,
        "mastery": round(cor / (cor + wro), 3) if (cor + wro) else None,
        "correct_count": cor,
        "wrong_count": wro,
        "cat_accuracy": cat_accuracy,
    }


@app.get("/api/export.csv")
def export_csv():
    with db() as conn:
        rows = conn.execute("SELECT * FROM questions ORDER BY id").fetchall()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["编号", "录入时间", "模块", "二级题型", "题型", "题目", "选项", "答案", "我的错答",
         "解析", "错因标签", "备注", "来源", "难度", "复习次数", "做对次数", "做错次数", "状态"]
    )
    for r in rows:
        d = row_to_dict(r)
        opts = " ".join(f"{k}. {v}" for k, v in sorted(d["options"].items()))
        writer.writerow(
            [d["id"], d["created_at"], d["category"], d["subtype"], d["qtype"], d["stem"],
             opts, d["answer"], d["my_answer"], d["analysis"], "/".join(d["tags"]), d["note"],
             d["source"], d["difficulty"], d["review_count"], d["correct_count"],
             d["wrong_count"], d["status"]]
        )
    data = "\ufeff" + buf.getvalue()
    return StreamingResponse(
        io.BytesIO(data.encode("utf-8")),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="kaogong-cuotiben.csv"'},
    )


@app.get("/api/meta")
def meta():
    with db() as conn:
        existing = [
            {"category": r["category"], "subtype": r["subtype"], "count": r["c"]}
            for r in conn.execute(
                "SELECT category, subtype, COUNT(*) c FROM questions WHERE subtype != ''"
                " GROUP BY category, subtype ORDER BY category, c DESC"
            )
        ]
    return {
        "categories": classifier.CATEGORIES,
        "subtypes": classifier.SUBTYPES,
        "sources": classifier.SOURCES,
        "error_tags": classifier.ERROR_TAGS,
        "time_budget": classifier.TIME_BUDGET,
        "existing": existing,
        "ocr_ready": ocr_engine.available(),
        "ocr_error": ocr_engine.load_error(),
    }


@app.get("/api/health")
def health():
    return {"ok": True, "ocr_ready": ocr_engine.available(), "ocr_error": ocr_engine.load_error()}


# ---------------------------------------------------------------- 静态资源


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/images", StaticFiles(directory=IMAGE_DIR), name="images")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


if __name__ == "__main__":
    import uvicorn

    port = 8765
    print("=" * 56)
    print("  考公错题本已启动")
    print(f"  本机访问：http://127.0.0.1:{port}")
    print(f"  手机访问（同一 WiFi）：http://{lan_ip()}:{port}")
    if not ocr_engine.available():
        print("  [!] OCR 引擎未安装，图片导入会失败。")
    print("  按 Ctrl+C 退出")
    print("=" * 56)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
