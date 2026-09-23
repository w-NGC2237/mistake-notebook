/* 本地数据层：用 IndexedDB 实现和电脑端后端一致的接口。
 *
 * 这样 app.js 里的界面代码完全不用改：电脑模式下走 HTTP，
 * 手机本地模式下走这里。
 */

import {
  classify, isImageOnly, CATEGORIES, SUBTYPES, SOURCES, ERROR_TAGS, TIME_BUDGET,
} from "./classifier.js";
import { parse } from "./parser.js";
import { recognizeFile } from "./localocr.js";

const DB_NAME = "kaogong-cuotiben";
const DB_VERSION = 1;
const INTERVALS = [1, 2, 4, 7, 15, 30, 60];

let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("questions")) {
          const s = db.createObjectStore("questions", { keyPath: "id", autoIncrement: true });
          s.createIndex("category", "category");
          s.createIndex("subtype", "subtype");
        }
        if (!db.objectStoreNames.contains("logs")) {
          const s = db.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
          s.createIndex("question_id", "question_id");
        }
        if (!db.objectStoreNames.contains("images")) {
          db.createObjectStore("images", { keyPath: "name" });
        }
        if (!db.objectStoreNames.contains("kv")) {
          db.createObjectStore("kv", { keyPath: "k" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function all(store) {
  const db = await openDB();
  return req(db.transaction(store, "readonly").objectStore(store).getAll());
}

async function getOne(store, key) {
  const db = await openDB();
  return req(db.transaction(store, "readonly").objectStore(store).get(key));
}

async function put(store, value) {
  const db = await openDB();
  const t = db.transaction(store, "readwrite");
  return new Promise((resolve, reject) => {
    const r = t.objectStore(store).put(value);
    r.onsuccess = () => resolve(r.result);
    t.onerror = () => reject(t.error);
  });
}

async function del(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readwrite");
    t.objectStore(store).delete(key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/* ---------------------------------------------------------- 图片 */

const imageUrls = new Map();
let imagesLoaded = false;

async function loadImageUrls() {
  if (imagesLoaded) return;
  const rows = await all("images");
  for (const r of rows) {
    if (!imageUrls.has(r.name) && r.blob) imageUrls.set(r.name, URL.createObjectURL(r.blob));
  }
  imagesLoaded = true;
}

export async function saveImage(file) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const name = `${stamp}-${Math.random().toString(36).slice(2, 12)}.jpg`;
  await put("images", { name, blob: file, createdAt: new Date().toISOString() });
  imageUrls.set(name, URL.createObjectURL(file));
  return name;
}

/* ---------------------------------------------------------- 工具 */

const now = () => new Date().toISOString().slice(0, 19);

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function decorate(q) {
  return { ...q, image_url: q.image ? imageUrls.get(q.image) || null : null };
}

function matchQuestion(q, p) {
  const category = p.get("category") || "";
  const subtype = p.get("subtype") || "";
  const status = p.get("status") || "";
  const kw = (p.get("q") || "").trim();
  if (category && category !== "全部" && q.category !== category) return false;
  if (subtype && q.subtype !== subtype) return false;
  if (status && status !== "全部" && q.status !== status) return false;
  if (p.get("due") && q.next_review_at && q.next_review_at > now()) return false;
  if (kw) {
    const hay = `${q.stem || ""} ${q.answer || ""} ${q.subtype || ""} ${q.note || ""}`;
    if (!hay.includes(kw)) return false;
  }
  return true;
}

/* ---------------------------------------------------------- 统计 */

async function buildStats() {
  const qs = await all("questions");
  const logs = await all("logs");

  const group = (list, keyFn) => {
    const m = new Map();
    for (const x of list) {
      const k = keyFn(x) || "未标注";
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const byCategory = group(qs, (q) => q.category).map(([c, n]) => ({ category: c, count: n }));
  const bySubtype = group(qs, (q) => `${q.category}\u0000${q.subtype || "未标注"}`)
    .map(([k, n]) => {
      const [category, subtype] = k.split("\u0000");
      return { category, subtype, count: n };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 24);

  const byStatus = {};
  for (const q of qs) byStatus[q.status] = (byStatus[q.status] || 0) + 1;

  const bySource = group(qs, (q) => q.source).map(([s, n]) => ({ source: s, count: n }));

  const tagMap = new Map();
  for (const q of qs) for (const t of q.tags || []) tagMap.set(t, (tagMap.get(t) || 0) + 1);
  const byTag = [...tagMap.entries()].map(([tag, n]) => ({ tag, count: n }))
    .sort((a, b) => b.count - a.count).slice(0, 12);

  const cur = now();
  const due = qs.filter((q) => !q.next_review_at || q.next_review_at <= cur).length;

  const cutoff = new Date(todayStart().getTime() - 13 * 86400000).toISOString().slice(0, 10);
  const dayMap = new Map();
  for (const q of qs) {
    const d = (q.created_at || "").slice(0, 10);
    if (d >= cutoff) dayMap.set(d, (dayMap.get(d) || 0) + 1);
  }
  const recent = [...dayMap.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const cor = qs.reduce((a, q) => a + (q.correct_count || 0), 0);
  const wro = qs.reduce((a, q) => a + (q.wrong_count || 0), 0);

  const catMap = new Map();
  for (const q of qs) {
    const c = catMap.get(q.category) || { category: q.category, correct: 0, wrong: 0 };
    c.correct += q.correct_count || 0;
    c.wrong += q.wrong_count || 0;
    catMap.set(q.category, c);
  }
  const catAccuracy = [...catMap.values()]
    .filter((c) => c.correct + c.wrong > 0)
    .sort((a, b) => (a.category < b.category ? -1 : 1));

  return {
    total: qs.length,
    due,
    review_count_total: logs.length,
    by_category: byCategory,
    by_subtype: bySubtype,
    by_status: byStatus,
    by_source: bySource,
    by_tag: byTag,
    recent,
    mastery: cor + wro ? Math.round((cor / (cor + wro)) * 1000) / 1000 : null,
    correct_count: cor,
    wrong_count: wro,
    cat_accuracy: catAccuracy,
  };
}

/* ---------------------------------------------------------- 导入 */

async function buildDrafts(files, onProgress, ops) {
  const drafts = [];
  let i = 0;
  for (const file of files) {
    i += 1;
    if (onProgress) onProgress(i, files.length);
    const name = await saveImage(file);
    let result;
    try {
      result = await recognizeFile(file, { ops });
    } catch (e) {
      drafts.push({
        image: name, image_url: imageUrls.get(name), raw_text: "",
        error: "识别失败：" + (e && e.message ? e.message : e), items: [],
      });
      continue;
    }
    const text = result.text;
    const imageOnly = isImageOnly(text);
    let items = parse(text);
    if (imageOnly) {
      items = [{ number: null, stem: "", options: {}, answer: null, analysis: null, type: "图片题" }];
    } else if (!items.length) {
      items = [{ number: null, stem: text, options: {}, answer: null, analysis: null, type: "选择题" }];
    }
    for (const item of items) {
      if (imageOnly) {
        Object.assign(item, {
          category: "判断推理", subtype: "图形推理", confidence: 0,
          reason: "图片题，请手动确认题型",
        });
      } else {
        const g = classify(item.stem, item.options);
        Object.assign(item, {
          category: g.category, subtype: g.subtype,
          confidence: g.confidence, reason: g.reason,
        });
      }
    }
    drafts.push({
      image: name, image_url: imageUrls.get(name), raw_text: text,
      avg_score: result.avgScore, image_only: imageOnly, items,
      proc: result.meta || null,
    });
  }
  return drafts;
}

/* ---------------------------------------------------------- 主入口 */

export async function localApi(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const [rawPath, query] = String(path).split("?");
  const params = new URLSearchParams(query || "");
  let payload = null;
  if (options.body && typeof options.body === "string") {
    try { payload = JSON.parse(options.body); } catch { payload = null; }
  }

  if (rawPath === "/api/meta") {
    const qs = await all("questions");
    const ex = new Map();
    for (const q of qs) {
      if (!q.subtype) continue;
      const k = `${q.category}\u0000${q.subtype}`;
      ex.set(k, (ex.get(k) || 0) + 1);
    }
    return {
      categories: CATEGORIES, subtypes: SUBTYPES, sources: SOURCES,
      error_tags: ERROR_TAGS, time_budget: TIME_BUDGET,
      existing: [...ex.entries()].map(([k, c]) => {
        const [category, subtype] = k.split("\u0000");
        return { category, subtype, count: c };
      }),
      ocr_ready: true, ocr_error: null, mode: "local",
    };
  }

  if (rawPath === "/api/health") return { ok: true, ocr_ready: true, mode: "local" };

  if (rawPath === "/api/import" && method === "POST") {
    const body = options.body;
    const files = body && body.getAll ? body.getAll("files").filter((f) => f && f.size) : [];
    if (!files.length) throw new Error("没有收到图片");
    await loadImageUrls();
    return { drafts: await buildDrafts(files, options.onProgress, options.ops) };
  }

  if (rawPath === "/api/parse-text" && method === "POST") {
    const text = (payload && payload.text) || "";
    if (!text.trim()) throw new Error("内容为空");
    let items = parse(text);
    if (!items.length) {
      items = [{ number: null, stem: text.trim(), options: {}, answer: null, analysis: null, type: "选择题" }];
    }
    items = items.map((it) => {
      const g = classify(it.stem, it.options);
      return { ...it, category: g.category, subtype: g.subtype, confidence: g.confidence, reason: g.reason };
    });
    return { items };
  }

  if (rawPath === "/api/classify" && method === "POST") {
    return classify((payload && payload.text) || "", payload && payload.options);
  }

  if (rawPath === "/api/questions" && method === "GET") {
    await loadImageUrls();
    const list = (await all("questions")).filter((q) => matchQuestion(q, params));
    const total = list.length;
    if (params.get("random_order")) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
    } else {
      list.sort((a, b) => b.id - a.id);
    }
    const limit = Number(params.get("limit") || 500);
    const offset = Number(params.get("offset") || 0);
    return { total, items: list.slice(offset, offset + limit).map(decorate) };
  }

  if (rawPath === "/api/questions" && method === "POST") {
    await loadImageUrls();
    const stamp = now();
    const rec = {
      created_at: stamp, updated_at: stamp,
      image: payload.image || null, raw_text: payload.raw_text || "",
      stem: payload.stem || "", options: payload.options || {},
      answer: payload.answer || "", my_answer: payload.my_answer || "",
      analysis: payload.analysis || "",
      category: payload.category || "常识", subtype: payload.subtype || "",
      qtype: payload.qtype || "选择题", tags: payload.tags || [],
      source: payload.source || "", note: payload.note || "",
      difficulty: payload.difficulty || 3, status: "new", level: 0,
      review_count: 0, correct_count: 0, wrong_count: 0,
      last_review_at: null, next_review_at: stamp,
    };
    if (payload.auto_classify) {
      const g = classify(rec.stem, rec.options);
      rec.category = g.category;
      rec.subtype = rec.subtype || g.subtype;
    }
    rec.id = await put("questions", rec);
    return decorate(rec);
  }

  const m = rawPath.match(/^\/api\/questions\/(\d+)(?:\/(review|logs))?$/);
  if (m) {
    const id = Number(m[1]);
    const action = m[2];
    await loadImageUrls();
    const existing = await getOne("questions", id);

    if (action === "logs" && method === "GET") {
      const rows = await all("logs");
      return rows.filter((l) => l.question_id === id).sort((a, b) => b.id - a.id).slice(0, 50);
    }

    if (action === "review" && method === "POST") {
      if (!existing) throw new Error("错题不存在");
      const correct = payload.result === "correct";
      let level = existing.level || 0;
      level = correct ? Math.min(level + 1, INTERVALS.length - 1) : 0;
      const days = correct ? INTERVALS[level] : 0;
      const next = new Date(todayStart().getTime() + days * 86400000).toISOString().slice(0, 19);
      const updated = {
        ...existing,
        review_count: (existing.review_count || 0) + 1,
        correct_count: (existing.correct_count || 0) + (correct ? 1 : 0),
        wrong_count: (existing.wrong_count || 0) + (correct ? 0 : 1),
        level,
        status: level >= 5 ? "mastered" : "reviewing",
        last_review_at: now(),
        next_review_at: next,
        updated_at: now(),
        note: payload.self_note || existing.note,
        tags: payload.tags && payload.tags.length ? payload.tags : existing.tags,
      };
      await put("questions", updated);
      await put("logs", {
        question_id: id, created_at: now(), result: payload.result,
        answer: payload.answer || "", duration_ms: payload.duration_ms || 0,
      });
      return decorate(updated);
    }

    if (!existing) throw new Error("错题不存在");
    if (method === "GET") return decorate(existing);

    if (method === "DELETE") {
      await del("questions", id);
      for (const l of await all("logs")) if (l.question_id === id) await del("logs", l.id);
      if (existing.image) {
        const rest = (await all("questions")).filter((q) => q.image === existing.image);
        if (!rest.length) {
          await del("images", existing.image);
          const u = imageUrls.get(existing.image);
          if (u) { URL.revokeObjectURL(u); imageUrls.delete(existing.image); }
        }
      }
      return { ok: true };
    }

    if (method === "PUT") {
      const updated = {
        ...existing,
        updated_at: now(),
        stem: payload.stem || "", options: payload.options || {},
        answer: payload.answer || "", my_answer: payload.my_answer || "",
        analysis: payload.analysis || "",
        category: payload.category || existing.category,
        subtype: payload.subtype || "",
        qtype: payload.qtype || existing.qtype,
        tags: payload.tags || [], source: payload.source || "",
        note: payload.note || "",
        difficulty: payload.difficulty || existing.difficulty,
      };
      await put("questions", updated);
      return decorate(updated);
    }
  }

  if (rawPath === "/api/stats") return buildStats();

  if (rawPath === "/api/export.csv") {
    const rows = (await all("questions")).sort((a, b) => a.id - b.id);
    const head = ["编号", "录入时间", "模块", "二级题型", "题型", "题目", "选项", "答案",
      "我的错答", "解析", "错因标签", "备注", "来源", "难度", "复习次数", "做对次数",
      "做错次数", "状态"];
    const cell = (v) => `"${String(v === undefined || v === null ? "" : v).replace(/"/g, '""')}"`;
    const lines = [head.map(cell).join(",")];
    for (const q of rows) {
      const opts = Object.keys(q.options || {}).sort()
        .map((k) => `${k}. ${q.options[k]}`).join(" ");
      lines.push([q.id, q.created_at, q.category, q.subtype, q.qtype, q.stem, opts, q.answer,
        q.my_answer, q.analysis, (q.tags || []).join("/"), q.note, q.source, q.difficulty,
        q.review_count, q.correct_count, q.wrong_count, q.status].map(cell).join(","));
    }
    return "\ufeff" + lines.join("\r\n");
  }

  throw new Error("本地模式暂不支持：" + rawPath);
}

/** 把所有数据导出成 JSON 文本 */
export async function exportBackup() {
  return JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    questions: await all("questions"),
    logs: await all("logs"),
  });
}

/** 从备份恢复 */
export async function importBackup(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.questions)) throw new Error("备份文件格式不对");
  for (const q of data.questions) await put("questions", q);
  for (const l of data.logs || []) await put("logs", l);
  return { questions: data.questions.length, logs: (data.logs || []).length };
}

export async function countAll() {
  return (await all("questions")).length;
}

/** 某张图片已经没有任何错题引用时，把它的数据删掉，避免重新裁剪后越攒越多 */
export async function releaseImage(name) {
  if (!name) return;
  const used = (await all("questions")).some((q) => q.image === name);
  if (used) return;
  await del("images", name);
  const url = imageUrls.get(name);
  if (url) { URL.revokeObjectURL(url); imageUrls.delete(name); }
}

/* ---------------------------------------------------------- 自动快照
 *
 * 存在 localStorage 里，和主数据库完全分开：
 *   - 不动 IndexedDB 的结构，所以不存在"升级把数据弄丢"的风险
 *   - 只存题目本身（不含图片二进制），体积小
 *   - 万一哪天升级出问题，可以在这里补回来
 */
const SNAPSHOT_KEY = "autoSnapshot";
const SNAPSHOT_MAX = 4000;

export async function writeSnapshot(force = false) {
  const qs = await all("questions");
  if (!qs.length) return null;
  let prev = null;
  try { prev = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null"); } catch { prev = null; }
  if (!force && prev && prev.at && prev.count === qs.length) {
    const age = Date.now() - new Date(prev.at).getTime();
    if (age < 12 * 3600 * 1000) return { count: prev.count, at: prev.at, skipped: true };
  }
  const payload = { at: new Date().toISOString(), count: qs.length, questions: qs.slice(0, SNAPSHOT_MAX) };
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(payload));
  } catch {
    return null;   // 容量不够就算了，不能影响正常使用
  }
  return { count: payload.count, at: payload.at, skipped: false };
}

export function readSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return { at: p.at, count: p.count || (p.questions || []).length, questions: p.questions || [] };
  } catch {
    return null;
  }
}

/** 把快照里缺失的题目补回来，已有的按 id 跳过，不会覆盖 */
export async function restoreSnapshot() {
  const snap = readSnapshot();
  if (!snap || !snap.questions.length) return { added: 0, total: 0 };
  const existing = new Set((await all("questions")).map((q) => q.id));
  let added = 0;
  for (const q of snap.questions) {
    if (existing.has(q.id)) continue;
    await put("questions", q);
    added += 1;
  }
  return { added, total: snap.questions.length };
}
