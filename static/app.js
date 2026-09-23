/* 考公错题本 · 前端逻辑
 *
 * 两种运行模式：
 *   server —— 电脑上跑 server.py，手机通过 WiFi 访问（识别精度高，数据在电脑）
 *   local  —— 打包成手机 App 时使用，数据存手机 IndexedDB，OCR 在手机本地跑
 * 所有数据操作都走 api()，模式对上面的界面代码是透明的。
 */

import {
  localApi, exportBackup, importBackup, releaseImage,
  writeSnapshot, readSnapshot, restoreSnapshot,
} from "./lib/localdb.js";
import { openCropEditor, loadOps, saveOps } from "./lib/crop.js";
import { warmUp, setProgressHandler } from "./lib/localocr.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const CATEGORY_EMOJI = {
  政治理论: "🚩", 常识: "🧠", 言语理解: "📖",
  数量关系: "🔢", 资料分析: "📊", 判断推理: "🧩", 科学推理: "🔬",
};
const STATUS_LABEL = { new: "新错题", reviewing: "复习中", mastered: "已掌握" };
const TYPE_OPTIONS = ["选择题", "填空题", "判断题", "解答题", "图片题", "其他"];
const ALL = "全部";

const S = {
  tab: "import",
  meta: { categories: [], subtypes: {}, sources: [], error_tags: [], time_budget: {}, existing: [] },
  staged: [],
  drafts: [],
  questions: [],
  filters: { category: ALL, status: ALL, q: "" },
  practice: null,
  timer: null,
  mode: "server",
  importProgress: "",
};

/* ---------------------------------------------------------- 运行模式 */

function isNativeApp() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform
    && window.Capacitor.isNativePlatform());
}

async function detectMode() {
  // 网址上带 ?mode=local / ?mode=server 可以直接指定，方便排查问题
  const forcedByUrl = new URLSearchParams(location.search).get("mode");
  if (forcedByUrl === "server" || forcedByUrl === "local") {
    localStorage.setItem("appMode", forcedByUrl);
    return forcedByUrl;
  }
  const forced = localStorage.getItem("appMode");
  if (forced === "server" || forced === "local") return forced;
  if (isNativeApp()) return "local";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch("/api/health", { cache: "no-store", signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && data.mode !== "local") return "server";
    }
  } catch { /* 连不上电脑，就用本地模式 */ }
  return "local";
}

/* ---------------------------------------------------------- 基础工具 */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

let toastTimer;
function toast(msg, isError = false) {
  const node = $("#toast");
  node.textContent = msg;
  node.className = "toast show" + (isError ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = "toast"; }, 2800);
}

async function api(path, options = {}) {
  if (S.mode === "local") return localApi(path, options);
  const res = await fetch(path, options);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text }; }
  if (!res.ok) {
    const msg = (data && (data.detail || data.message)) || `请求失败 (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

function downloadText(text, filename, mime = "text/csv;charset=utf-8") {
  const blob = text instanceof Blob ? text : new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const jsonBody = (path, body, method = "POST") => api(path, {
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function lightbox(src) {
  const node = document.createElement("div");
  node.className = "lightbox";
  node.innerHTML = `<button class="close">✕</button><img src="${esc(src)}" alt="">`;
  node.addEventListener("click", () => node.remove());
  document.body.appendChild(node);
}

function sheet(html) {
  const mask = document.createElement("div");
  mask.className = "sheet-mask";
  mask.innerHTML = `<div class="sheet"><div class="sheet-handle"></div>${html}</div>`;
  mask.addEventListener("click", (e) => { if (e.target === mask) mask.remove(); });
  document.body.appendChild(mask);
  return mask;
}

function setTopActions(html) { $("#top-actions").innerHTML = html || ""; }

function categoryEmoji(c) { return CATEGORY_EMOJI[c] || "📝"; }

/** 二级分类既可下拉选建议值，也能直接手输 */
function fillSubtypeList(category) {
  const list = $("#subtype-list");
  if (!list) return;
  const opts = (S.meta.subtypes && S.meta.subtypes[category]) || [];
  list.innerHTML = opts.map((v) => `<option value="${esc(v)}"></option>`).join("");
}

function categorySelect(current, extraClass = "") {
  return `<select class="${extraClass}" data-k="category">${
    S.meta.categories.map((c) =>
      `<option value="${esc(c)}"${c === current ? " selected" : ""}>${categoryEmoji(c)} ${esc(c)}</option>`
    ).join("")}</select>`;
}

/** 复习节奏：连对次数越高，下次间隔越长 */
const INTERVAL_LABEL = ["当天", "1 天", "2 天", "4 天", "7 天", "15 天", "30 天", "60 天"];

/* ---------------------------------------------------------- 路由 */

const TITLES = { import: "导入错题", list: "错题本", practice: "刷题模式", stats: "学习统计" };

function go(tab) {
  clearTimer();
  S.tab = tab;
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#page-title").textContent = TITLES[tab];
  window.scrollTo({ top: 0 });
  render();
}

function render() {
  if (S.tab === "import") renderImport();
  else if (S.tab === "list") renderList();
  else if (S.tab === "practice") renderPractice();
  else renderStats();
}

function clearTimer() {
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
}

/* ---------------------------------------------------------- 导入页 */

function renderImport() {
  setTopActions("");
  $("#view").innerHTML = `
    <div class="dropzone" id="drop">
      <div class="big">📷</div>
      <div class="t">拍照 / 从相册选图</div>
      <div class="tiny" style="margin-top:4px">可一次选多张，自动识别文字并判断模块和题型</div>
    </div>
    <input type="file" id="picker" accept="image/*" multiple hidden>
    <div class="thumbs" id="thumbs"></div>
    <div id="import-actions"></div>
    <div id="drafts"></div>
    <details class="collapsible card" style="margin-top:12px">
      <summary>粘贴文字导入（没有图片时用）</summary>
      <div style="margin-top:10px">
        <textarea id="paste-text" placeholder="把题目文字粘贴到这里，支持多道题，用 1. / 2. 或 (1) (2) 编号"></textarea>
        <button class="btn soft sm" id="paste-parse" style="margin-top:8px">解析文字</button>
      </div>
    </details>`;

  const picker = $("#picker");
  $("#drop").addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    S.staged = [...S.staged, ...picker.files];
    picker.value = "";
    drawThumbs();
  });

  const drop = $("#drop");
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) { S.staged = [...S.staged, ...files]; drawThumbs(); }
  });

  $("#paste-parse").addEventListener("click", async () => {
    const text = $("#paste-text").value.trim();
    if (!text) return toast("先粘贴题目文字", true);
    try {
      const data = await jsonBody("/api/parse-text", { text });
      S.drafts = [{ image: null, image_url: null, raw_text: text, items: data.items }];
      drawDrafts();
      toast(`解析出 ${data.items.length} 道题`);
    } catch (e) { toast(e.message, true); }
  });

  drawThumbs();
  drawDrafts();
}

const thumbUrls = new WeakMap();
function fileUrl(file) {
  let url = thumbUrls.get(file);
  if (!url) { url = URL.createObjectURL(file); thumbUrls.set(file, url); }
  return url;
}

function drawThumbs() {
  const box = $("#thumbs");
  if (!box) return;
  box.innerHTML = S.staged.map((f, i) => `
    <div class="thumb">
      <img src="${fileUrl(f)}" alt="">
      ${f.__cropped ? `<span class="badge">已裁剪</span>` : ""}
      <button class="x" data-i="${i}">✕</button>
      <div class="ops"><button data-crop="${i}">裁剪</button></div>
    </div>`).join("");
  $$(".thumb .x", box).forEach((b) => b.addEventListener("click", () => {
    S.staged.splice(Number(b.dataset.i), 1);
    drawThumbs();
  }));
  $$("[data-crop]", box).forEach((b) => b.addEventListener("click", () => cropStaged(Number(b.dataset.crop))));

  const actions = $("#import-actions");
  actions.innerHTML = S.staged.length
    ? `<button class="btn block" id="do-import">识别这 ${S.staged.length} 张图片</button>
       <div class="proc-note">识别前会自动去掉红蓝笔迹、扶正倾斜。只想识别某道题，点缩略图上的「裁剪」先框住范围。</div>`
    : "";
  const btn = $("#do-import");
  if (btn) btn.addEventListener("click", doImport);
}

/** 裁剪待识别的图片，替换掉原来的文件 */
async function cropStaged(index) {
  const file = S.staged[index];
  if (!file) return;
  const out = await openCropEditor(file, { ops: loadOps(), name: file.name || "photo" });
  if (!out) return;
  out.file.__cropped = true;
  S.staged[index] = out.file;
  drawThumbs();
  toast(`已裁剪为 ${out.width}×${out.height}`);
}

async function doImport() {
  const btn = $("#do-import");
  btn.disabled = true;
  const setLabel = (t) => { btn.innerHTML = `<span class="spinner"></span> ${t}`; };
  setLabel(S.mode === "local" ? "正在准备本地识别引擎…" : "正在识别，请稍等…");
  setProgressHandler((p) => {
    if (p && p.total) {
      setLabel(`正在加载识别模型 ${Math.round((p.loaded / p.total) * 100)}%`);
    }
  });
  const form = new FormData();
  S.staged.forEach((f) => form.append("files", f, f.name || "photo.jpg"));
  try {
    const data = await api("/api/import", {
      method: "POST",
      body: form,
      ops: loadOps(),
      onProgress: (i, n) => setLabel(`正在识别第 ${i} / ${n} 张图片…`),
    });
    S.drafts = data.drafts;
    S.staged = [];
    drawThumbs();
    drawDrafts();
    const n = data.drafts.reduce((s, d) => s + (d.items?.length || 0), 0);
    toast(`识别完成，共 ${n} 道题`);
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
    btn.textContent = "重试识别";
  }
}

function drawDrafts() {
  const box = $("#drafts");
  if (!box) return;
  if (!S.drafts.length) { box.innerHTML = ""; return; }

  const total = S.drafts.reduce((s, d) => s + (d.items?.length || 0), 0);
  box.innerHTML = S.drafts.map((d, di) => `
    <div class="card" data-draft="${di}">
      ${d.image_url ? `<img class="draft-img" src="${esc(d.image_url)}" data-zoom="${esc(d.image_url)}" alt="">
      <div class="proc-note">
        <button class="btn soft sm" data-recrop="${di}">重新裁剪识别</button>
        ${d.proc && Math.abs(d.proc.angle || 0) >= 0.25
          ? `<span class="tag grey">已扶正 ${Math.abs(d.proc.angle).toFixed(1)}\u00b0</span>` : ""}
        ${d.proc && ((d.proc.inkRemoved || 0) + (d.proc.pencilRemoved || 0)) > 0
          ? `<span class="tag grey">已擦除手写笔迹</span>` : ""}
      </div>` : ""}
      ${d.error ? `<div class="verdict bad" style="margin-top:10px">${esc(d.error)}</div>` : ""}
      ${d.error ? "" : `<div class="tiny" style="margin:8px 0 4px">
        ${d.image_only ? "⚠️ 这张图几乎没有文字，已按图片题处理，请手动确认题型 · " : ""}
        ${d.image_url ? "" : "文字导入 · "}识别出 ${d.items.length} 道题${
          d.avg_score ? ` · 识别置信度 ${(d.avg_score * 100).toFixed(0)}%` : ""}</div>`}
      ${(d.items || []).map((it, ii) => draftItem(di, ii, it)).join("")}
    </div>`).join("") + `
    <button class="btn block" id="save-all" style="margin-bottom:20px">保存全部 ${total} 道错题</button>`;

  $$("[data-zoom]", box).forEach((img) =>
    img.addEventListener("click", () => lightbox(img.dataset.zoom)));
  $$("[data-del-item]", box).forEach((b) => b.addEventListener("click", () => {
    const [di, ii] = b.dataset.delItem.split(":").map(Number);
    S.drafts[di].items.splice(ii, 1);
    if (!S.drafts[di].items.length) S.drafts.splice(di, 1);
    drawDrafts();
  }));
  $$("[data-raw]", box).forEach((b) => b.addEventListener("click", () => {
    const d = S.drafts[Number(b.dataset.raw)];
    sheet(`<h3>原始识别文字</h3>
      <div class="answer-block"><p>${esc(d.raw_text || "（空）")}</p></div>
      <button class="btn block soft" style="margin-top:14px" onclick="this.closest('.sheet-mask').remove()">关闭</button>`);
  }));
  $$("[data-recrop]", box).forEach((b) =>
    b.addEventListener("click", () => recropDraft(Number(b.dataset.recrop))));
  $$(".sel-category", box).forEach((sel) => sel.addEventListener("change", () => {
    const it = S.drafts[Number(sel.dataset.di)].items[Number(sel.dataset.ii)];
    fillSubtypeList(sel.value);
    const sub = sel.closest(".item-box").querySelector('[data-k="subtype"]');
    if (sub && !(S.meta.subtypes[sel.value] || []).includes(sub.value)) sub.value = "";
    it.category = sel.value;
  }));

  const saveAll = $("#save-all");
  if (saveAll) saveAll.addEventListener("click", saveAllDrafts);
}

/** 对已经有草稿的图片重新框一次范围，只保留新识别的结果 */
async function recropDraft(di) {
  const d = S.drafts[di];
  if (!d || !d.image_url) return;
  let blob;
  try {
    blob = await (await fetch(d.image_url)).blob();
  } catch (e) {
    return toast("原图读取失败：" + (e && e.message ? e.message : e), true);
  }
  const out = await openCropEditor(blob, { ops: loadOps(), name: "recrop" });
  if (!out) return;
  const form = new FormData();
  form.append("files", out.file, out.file.name);
  try {
    const data = await api("/api/import", { method: "POST", body: form, ops: loadOps() });
    const fresh = data.drafts && data.drafts[0];
    if (!fresh || !fresh.items || !fresh.items.length) return toast("这块区域没识别出内容，换个范围再试", true);
    const oldImage = d.image;
    S.drafts[di] = fresh;
    drawDrafts();
    if (S.mode === "local" && oldImage && oldImage !== fresh.image) {
      releaseImage(oldImage).catch(() => {});
    }
    toast(`重新识别出 ${fresh.items.length} 道题`);
  } catch (e) { toast(e.message, true); }
}

function draftItem(di, ii, it) {
  const optionsText = Object.entries(it.options || {})
    .sort().map(([k, v]) => `${k}. ${v}`).join("\n");
  const lowConf = (it.confidence ?? 1) < 0.45;
  return `
    <div class="item-box" data-di="${di}" data-ii="${ii}">
      <div class="item-head">
        <div class="row tight">
          ${it.number ? `<span class="tag grey">第 ${esc(it.number)} 题</span>` : ""}
          <span class="tag">${esc(it.type || "选择题")}</span>
          ${it.confidence !== undefined
            ? `<span class="tag ${lowConf ? "warn" : "grey"}">分类 ${Math.round(it.confidence * 100)}%</span>` : ""}
          ${it.reason ? `<span class="tiny">${esc(it.reason)}</span>` : ""}
        </div>
        <div class="row tight">
          <button class="btn soft sm" data-raw="${di}">原文</button>
          <button class="btn danger sm" data-del-item="${di}:${ii}">删除</button>
        </div>
      </div>
      <label class="field"><span>题干</span>
        <textarea data-k="stem" rows="3" placeholder="纯图片题可以留空，做题时看原图">${esc(it.stem)}</textarea></label>
      <label class="field"><span>选项（每行一个，如 A. xxx）</span>
        <textarea data-k="options" rows="2">${esc(optionsText)}</textarea></label>
      <div class="row" style="gap:8px">
        <label class="field grow"><span>模块</span>
          ${categorySelect(it.category, `sel-category`).replace("<select ", `<select data-di="${di}" data-ii="${ii}" `)}</label>
        <label class="field grow"><span>二级题型 / 知识点</span>
          <input type="text" data-k="subtype" list="subtype-list" value="${esc(it.subtype || "")}"
                 placeholder="可下拉选，也可手输"></label>
      </div>
      <div class="row" style="gap:8px">
        <label class="field grow"><span>题型</span>
          <select data-k="type">${TYPE_OPTIONS.map((t) =>
            `<option${t === it.type ? " selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="field grow"><span>正确答案</span>
          <input type="text" data-k="answer" value="${esc(it.answer || "")}" placeholder="可后补"></label>
      </div>
      <div class="row" style="gap:8px">
        <label class="field grow"><span>来源</span>
          <select data-k="source">${["", ...S.meta.sources].map((s) =>
            `<option value="${esc(s)}"${s === (it.source || "") ? " selected" : ""}>${
              s ? esc(s) : "未标注"}</option>`).join("")}</select></label>
        <label class="field grow"><span>解析（可后补）</span>
          <input type="text" data-k="analysis" value="${esc(it.analysis || "")}"></label>
      </div>
    </div>`;
}

function collectDrafts() {
  const out = [];
  S.drafts.forEach((d, di) => {
    (d.items || []).forEach((it, ii) => {
      const box = $(`.item-box[data-di="${di}"][data-ii="${ii}"]`);
      if (!box) return;
      const val = (k) => { const n = box.querySelector(`[data-k="${k}"]`); return n ? n.value : ""; };
      const options = {};
      val("options").split("\n").forEach((line) => {
        const m = line.match(/^\s*([A-Ha-h])\s*[.、．)）:：]\s*(.+)$/);
        if (m) options[m[1].toUpperCase()] = m[2].trim();
      });
      out.push({
        image: d.image || null,
        raw_text: d.raw_text || "",
        stem: val("stem").trim(),
        options,
        answer: val("answer").trim(),
        analysis: val("analysis").trim(),
        category: val("category") || "常识",
        subtype: val("subtype").trim(),
        qtype: val("type") || "选择题",
        source: val("source") || "",
        my_answer: "",
        tags: [],
        note: "",
        difficulty: 3,
      });
    });
  });
  // 图片题允许没有题干，只要有图
  return out.filter((q) => q.stem || q.image);
}

async function saveAllDrafts() {
  const items = collectDrafts();
  if (!items.length) return toast("没有可保存的题目", true);
  const btn = $("#save-all");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> 保存中…`;
  try {
    for (const item of items) await jsonBody("/api/questions", item);
    S.drafts = [];
    drawDrafts();
    await loadMeta();
    toast(`已保存 ${items.length} 道错题`);
    setTimeout(() => go("list"), 500);
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
    btn.textContent = "重试保存";
  }
}

/* ---------------------------------------------------------- 错题本 */

async function loadQuestions() {
  const p = new URLSearchParams();
  if (S.filters.category !== ALL) p.set("category", S.filters.category);
  if (S.filters.status !== ALL) p.set("status", S.filters.status);
  if (S.filters.q) p.set("q", S.filters.q);
  const data = await api(`/api/questions?${p}`);
  S.questions = data.items;
  return data;
}

async function renderList() {
  setTopActions(`<button class="btn soft sm" id="to-import">+ 导入</button>`);
  $("#to-import").addEventListener("click", () => go("import"));

  $("#view").innerHTML = `
    <div class="card" style="padding:10px">
      <input type="search" id="search" placeholder="搜索题目 / 答案 / 知识点" value="${esc(S.filters.q)}">
      <div class="chips" id="category-chips" style="margin-top:8px">
        ${[ALL, ...S.meta.categories].map((c) =>
          `<button class="chip${S.filters.category === c ? " active" : ""}" data-c="${esc(c)}">${
            c === ALL ? "全部模块" : categoryEmoji(c) + " " + esc(c)}</button>`).join("")}
      </div>
      <div class="chips" id="status-chips">
        ${[[ALL, "全部"], ["new", "新错题"], ["reviewing", "复习中"], ["mastered", "已掌握"]]
          .map(([v, l]) =>
            `<button class="chip${S.filters.status === v ? " active" : ""}" data-st="${v}">${l}</button>`).join("")}
      </div>
    </div>
    <div id="list-body"><div class="center" style="padding:30px"><span class="spinner"></span></div></div>`;

  let timer;
  $("#search").addEventListener("input", (e) => {
    S.filters.q = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(async () => { await loadQuestions(); drawListBody(); }, 250);
  });
  $$("#category-chips .chip").forEach((c) => c.addEventListener("click", async () => {
    S.filters.category = c.dataset.c;
    $$("#category-chips .chip").forEach((x) => x.classList.toggle("active", x === c));
    await loadQuestions(); drawListBody();
  }));
  $$("#status-chips .chip").forEach((c) => c.addEventListener("click", async () => {
    S.filters.status = c.dataset.st;
    $$("#status-chips .chip").forEach((x) => x.classList.toggle("active", x === c));
    await loadQuestions(); drawListBody();
  }));

  try { await loadQuestions(); drawListBody(); }
  catch (e) { $("#list-body").innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
}

function drawListBody() {
  const body = $("#list-body");
  if (!body) return;
  if (!S.questions.length) {
    body.innerHTML = `<div class="empty"><div class="big">📭</div>还没有符合条件的错题</div>`;
    return;
  }
  body.innerHTML = S.questions.map((q) => `
    <div class="card q-card" data-id="${q.id}">
      <div class="thumb-wrap">${q.image_url
        ? `<img src="${esc(q.image_url)}" alt="">`
        : `<div class="no-img">${categoryEmoji(q.category)}</div>`}</div>
      <div class="grow">
        <div class="q-stem">${esc(q.stem || "（图片题，点击查看原图）")}</div>
        <div class="q-meta">
          <span class="tag">${categoryEmoji(q.category)} ${esc(q.category)}</span>
          ${q.subtype ? `<span class="tag grey">${esc(q.subtype)}</span>` : ""}
          ${q.source ? `<span class="tag grey">${esc(q.source)}</span>` : ""}
          <span class="tag ${q.status === "mastered" ? "ok" : "grey"}">${STATUS_LABEL[q.status] || q.status}</span>
          ${q.wrong_count ? `<span class="tag bad">错 ${q.wrong_count} 次</span>` : ""}
        </div>
      </div>
    </div>`).join("");
  $$(".q-card", body).forEach((card) =>
    card.addEventListener("click", () => openDetail(+card.dataset.id)));
}

function questionBody(q) {
  const opts = Object.entries(q.options || {}).sort()
    .map(([k, v]) => `<div class="opt"><span class="k">${esc(k)}</span><span>${esc(v)}</span></div>`).join("");
  return `
    ${q.stem ? `<div class="stem-box">${esc(q.stem)}</div>` : `<div class="muted">（图片题，请看原图）</div>`}
    ${opts}`;
}

function openDetail(id) {
  const q = S.questions.find((x) => x.id === id);
  if (!q) return;
  const mask = sheet(`
    <h3>${categoryEmoji(q.category)} ${esc(q.category)}${q.subtype ? " · " + esc(q.subtype) : ""}</h3>
    <div class="row tight" style="margin-bottom:10px">
      ${q.source ? `<span class="tag grey">${esc(q.source)}</span>` : ""}
      <span class="tag grey">${esc(q.qtype)}</span>
      <span class="tag ${q.status === "mastered" ? "ok" : "grey"}">${STATUS_LABEL[q.status] || q.status}</span>
      ${(q.tags || []).map((t) => `<span class="tag warn">${esc(t)}</span>`).join("")}
    </div>
    ${q.image_url ? `<img class="draft-img" src="${esc(q.image_url)}" style="margin-bottom:12px" data-zoom="${esc(q.image_url)}" alt="">` : ""}
    <div class="card">${questionBody(q)}</div>
    <div class="card">
      <div class="answer-block"><h4>正确答案</h4><p>${esc(q.answer || "未填写")}</p></div>
      ${q.my_answer ? `<div class="answer-block"><h4>我当时的错答</h4><p>${esc(q.my_answer)}</p></div>` : ""}
      ${q.analysis ? `<div class="answer-block"><h4>解析</h4><p>${esc(q.analysis)}</p></div>` : ""}
      ${q.note ? `<div class="answer-block"><h4>备注</h4><p>${esc(q.note)}</p></div>` : ""}
      <div class="row" style="margin-top:12px">
        <span class="tiny">复习 ${q.review_count} 次 · 对 ${q.correct_count} / 错 ${q.wrong_count}</span>
      </div>
    </div>
    <div class="row">
      <button class="btn soft grow" id="d-edit">编辑</button>
      <button class="btn soft grow" id="d-practice">单独练这题</button>
      <button class="btn danger" id="d-del">删除</button>
    </div>
    <button class="btn ghost block" id="d-close" style="margin-top:10px">关闭</button>`);

  $("[data-zoom]", mask)?.addEventListener("click", (e) => lightbox(e.target.dataset.zoom));
  $("#d-close", mask).addEventListener("click", () => mask.remove());
  $("#d-del", mask).addEventListener("click", async () => {
    if (!confirm("确定删除这道错题？原图也会一并删除。")) return;
    try {
      await api(`/api/questions/${id}`, { method: "DELETE" });
      mask.remove();
      await loadQuestions();
      drawListBody();
      toast("已删除");
    } catch (e) { toast(e.message, true); }
  });
  $("#d-practice", mask).addEventListener("click", () => {
    mask.remove();
    startPractice([q]);
  });
  $("#d-edit", mask).addEventListener("click", () => { mask.remove(); openEdit(q); });
}

function openEdit(q) {
  const opts = Object.entries(q.options || {}).sort().map(([k, v]) => `${k}. ${v}`).join("\n");
  const mask = sheet(`
    <h3>编辑错题</h3>
    <label class="field"><span>题干</span><textarea id="e-stem" rows="4">${esc(q.stem)}</textarea></label>
    <label class="field"><span>选项（每行一个，如 A. xxx）</span><textarea id="e-options" rows="2">${esc(opts)}</textarea></label>
    <div class="row" style="gap:8px">
      <label class="field grow"><span>模块</span>
        <select id="e-category" class="sel-category">${S.meta.categories.map((c) =>
          `<option value="${esc(c)}"${c === q.category ? " selected" : ""}>${categoryEmoji(c)} ${esc(c)}</option>`).join("")}</select></label>
      <label class="field grow"><span>二级题型 / 知识点</span>
        <input type="text" id="e-subtype" list="subtype-list" value="${esc(q.subtype)}"></label>
    </div>
    <label class="field"><span>正确答案</span><input type="text" id="e-answer" value="${esc(q.answer)}"></label>
    <label class="field"><span>我当时的错答</span><input type="text" id="e-my" value="${esc(q.my_answer)}"></label>
    <label class="field"><span>解析</span><textarea id="e-analysis" rows="2">${esc(q.analysis)}</textarea></label>
    <div class="row" style="gap:8px">
      <label class="field grow"><span>题型</span>
        <select id="e-type">${TYPE_OPTIONS.map((t) =>
          `<option${t === q.qtype ? " selected" : ""}>${t}</option>`).join("")}</select></label>
      <label class="field grow"><span>来源</span>
        <select id="e-source">${["", ...S.meta.sources].map((s) =>
          `<option value="${esc(s)}"${s === (q.source || "") ? " selected" : ""}>${
            s ? esc(s) : "未标注"}</option>`).join("")}</select></label>
    </div>
    <div class="row" style="gap:8px">
      <label class="field grow"><span>难度 1-5</span><input type="text" id="e-diff" value="${q.difficulty}"></label>
      <label class="field grow"><span>备注</span><input type="text" id="e-note" value="${esc(q.note)}"></label>
    </div>
    <label class="field"><span>错因标签</span>
      <div class="chips" id="e-tags">
        ${S.meta.error_tags.map((t) =>
          `<button type="button" class="chip${(q.tags || []).includes(t) ? " active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}
      </div></label>
    <button class="btn block" id="e-save">保存修改</button>`);

  fillSubtypeList(q.category);
  $("#e-category", mask).addEventListener("change", (e) => {
    fillSubtypeList(e.target.value);
    const sub = $("#e-subtype", mask);
    if (!(S.meta.subtypes[e.target.value] || []).includes(sub.value)) sub.value = "";
  });
  $$("#e-tags .chip", mask).forEach((c) =>
    c.addEventListener("click", () => c.classList.toggle("active")));

  $("#e-save", mask).addEventListener("click", async () => {
    const options = {};
    $("#e-options", mask).value.split("\n").forEach((line) => {
      const m = line.match(/^\s*([A-Ha-h])\s*[.、．)）:：]\s*(.+)$/);
      if (m) options[m[1].toUpperCase()] = m[2].trim();
    });
    const payload = {
      stem: $("#e-stem", mask).value.trim(),
      options,
      answer: $("#e-answer", mask).value.trim(),
      my_answer: $("#e-my", mask).value.trim(),
      analysis: $("#e-analysis", mask).value.trim(),
      category: $("#e-category", mask).value,
      subtype: $("#e-subtype", mask).value.trim(),
      qtype: $("#e-type", mask).value,
      source: $("#e-source", mask).value,
      difficulty: Math.min(5, Math.max(1, Number($("#e-diff", mask).value) || 3)),
      note: $("#e-note", mask).value.trim(),
      tags: $$("#e-tags .chip.active", mask).map((c) => c.dataset.tag),
    };
    try {
      await jsonBody(`/api/questions/${q.id}`, payload, "PUT");
      mask.remove();
      await loadQuestions();
      drawListBody();
      await loadMeta();
      toast("已保存");
    } catch (e) { toast(e.message, true); }
  });
}

/* ---------------------------------------------------------- 刷题模式 */

function renderPractice() {
  setTopActions("");
  if (S.practice && S.practice.queue && S.practice.queue.length && !S.practice.done) {
    return drawPracticeCard();
  }

  const picked = S.practice?.category || "";
  $("#view").innerHTML = `
    <div class="card">
      <h3 style="margin:0 0 10px;font-size:15px">选择刷题范围</h3>
      <label class="field"><span>模块</span>
        <select id="p-category">
          <option value="">全部模块</option>
          ${S.meta.categories.map((c) =>
            `<option value="${esc(c)}"${c === picked ? " selected" : ""}>${categoryEmoji(c)} ${esc(c)}</option>`).join("")}
        </select></label>
      <label class="field"><span>二级题型（可留空）</span>
        <select id="p-subtype"><option value="">全部题型</option></select></label>
      <div class="row" style="gap:8px">
        <label class="field grow"><span>范围</span>
          <select id="p-scope">
            <option value="all">全部错题</option>
            <option value="due" selected>今天该复习的</option>
            <option value="weak">错得最多的</option>
            <option value="new">还没复习过的</option>
          </select></label>
        <label class="field grow"><span>题量</span>
          <select id="p-size">
            <option>5</option><option selected>10</option><option>20</option><option>50</option>
          </select></label>
      </div>
      <label class="field"><span>顺序</span>
        <select id="p-order">
          <option value="random" selected>随机打乱</option>
          <option value="recent">最新录入优先</option>
        </select></label>
      <label class="row" style="gap:8px;align-items:center;margin-bottom:12px">
        <input type="checkbox" id="p-showimg" style="width:auto" checked>
        <span class="muted">允许查看原题图片</span>
      </label>
      <button class="btn block" id="p-start">开始刷题</button>
    </div>
    <div class="card">
      <div class="spread">
        <div><div style="font-weight:600">今天该复习</div>
          <div class="tiny">按遗忘曲线自动排的，做对往后推、做错回到当天</div></div>
        <button class="btn soft sm" id="p-due">直接开始</button>
      </div>
    </div>`;

  fillPracticeSubtypes(picked);
  $("#p-category").addEventListener("change", (e) => {
    S.practice = { category: e.target.value };
    fillPracticeSubtypes(e.target.value);
  });
  $("#p-start").addEventListener("click", startFromForm);
  $("#p-due").addEventListener("click", () => {
    $("#p-scope").value = "due";
    startFromForm();
  });
}

function fillPracticeSubtypes(category) {
  const sel = $("#p-subtype");
  if (!sel) return;
  let opts = [];
  if (category) {
    opts = S.meta.subtypes[category] || [];
  } else {
    const seen = new Set();
    S.meta.existing.forEach((x) => { if (x.subtype) seen.add(x.subtype); });
    opts = [...seen];
  }
  sel.innerHTML = `<option value="">全部题型</option>` +
    opts.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
}

async function startFromForm() {
  const category = $("#p-category")?.value || "";
  const subtype = $("#p-subtype")?.value || "";
  const scope = $("#p-scope")?.value || "due";
  const size = Number($("#p-size")?.value || 10);
  const order = $("#p-order")?.value || "random";
  const showImage = $("#p-showimg")?.checked ?? true;

  // "错得最多" 需要在本地排序，所以总是多取一些；其余情况可以交给后端随机抽样
  const serverRandom = order === "random" && scope !== "weak";
  const p = new URLSearchParams({ limit: String(serverRandom ? size : 500) });
  if (category) p.set("category", category);
  if (subtype) p.set("subtype", subtype);
  if (scope === "due") p.set("due", "1");
  if (scope === "new") p.set("status", "new");
  if (serverRandom) p.set("random_order", "1");

  try {
    const data = await api(`/api/questions?${p}`);
    let items = data.items;
    if (scope === "weak") {
      items = items.filter((q) => q.wrong_count > 0)
        .sort((a, b) => b.wrong_count - a.wrong_count);
      if (order === "random") items = items.sort(() => Math.random() - 0.5);
      items = items.slice(0, size);
    }
    if (!items.length) return toast("这个范围里没有题目", true);
    startPractice(items, showImage, category);
  } catch (e) { toast(e.message, true); }
}

function startPractice(items, showImage = true, category = "") {
  S.practice = {
    queue: items,
    index: 0,
    showImage,
    picked: "",
    input: "",
    revealed: false,
    startedAt: Date.now(),
    results: [],
    tagPicks: [],
    category: category || S.practice?.category || "",
  };
  go("practice");
}

function budgetOf(q) {
  return (S.meta.time_budget && S.meta.time_budget[q.category]) || 60;
}

function drawPracticeCard() {
  const P = S.practice;
  const q = P.queue[P.index];
  if (!q) return practiceSummary();
  clearTimer();

  const pct = Math.round((P.index / P.queue.length) * 100);
  const opts = Object.entries(q.options || {}).sort();
  const correctKey = (q.answer || "").trim().toUpperCase().charAt(0);
  const budget = budgetOf(q);

  $("#view").innerHTML = `
    <div class="progress-bar"><i style="width:${pct}%"></i></div>
    <div class="spread" style="margin-bottom:10px">
      <span class="tiny">第 ${P.index + 1} / ${P.queue.length} 题 ·
        ${categoryEmoji(q.category)} ${esc(q.category)}${q.subtype ? " · " + esc(q.subtype) : ""}</span>
      <span class="row tight">
        <span class="tag grey" id="p-timer">0:00</span>
        <button class="btn ghost sm" id="p-quit">结束</button>
      </span>
    </div>
    ${P.showImage && q.image_url
      ? `<img class="draft-img" src="${esc(q.image_url)}" style="margin-bottom:12px;max-height:220px" data-zoom="${esc(q.image_url)}" alt="">`
      : ""}
    <div class="card">
      ${q.stem ? `<div class="stem-box">${esc(q.stem)}</div>`
               : `<div class="muted">这题是纯图片题，请看上面的原图作答。</div>`}
      ${opts.length ? `<div id="p-opts" style="margin-top:10px">${opts.map(([k, v]) => `
        <div class="opt" data-k="${esc(k)}"><span class="k">${esc(k)}</span><span>${esc(v)}</span></div>`).join("")}</div>` : ""}
    </div>
    <div class="card">
      ${opts.length
        ? `<div class="muted">${P.revealed
            ? "正确答案：<b>" + esc(q.answer || "未填写") + "</b>"
            : "在上面选出你的答案"}</div>`
        : `<label class="field"><span>你的作答</span>
             <textarea id="p-input" rows="3" placeholder="写出答案或解题要点"
               ${P.revealed ? "disabled" : ""}>${esc(P.input)}</textarea></label>`}
      ${P.revealed ? `
        <div class="answer-block"><h4>正确答案</h4><p>${esc(q.answer || "未填写")}</p></div>
        ${q.analysis ? `<div class="answer-block"><h4>解析</h4><p>${esc(q.analysis)}</p></div>` : ""}
        ${q.note ? `<div class="answer-block"><h4>备注</h4><p>${esc(q.note)}</p></div>` : ""}
        <div class="answer-block"><h4>这题错在哪（可多选）</h4>
          <div class="chips" id="p-tags" style="margin-top:6px">
            ${S.meta.error_tags.map((t) =>
              `<button type="button" class="chip${P.tagPicks.includes(t) ? " active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}
          </div></div>
        <div class="row" style="margin-top:12px">
          ${q.image_url ? `<button class="btn ghost sm" id="p-again">看原图</button>` : ""}
          <button class="btn ghost sm" id="p-more">完整详情</button>
        </div>` : ""}
    </div>
    <div id="p-actions"></div>`;

  const zoomImg = $("[data-zoom]");
  if (zoomImg) zoomImg.addEventListener("click", () => lightbox(zoomImg.dataset.zoom));

  const timerNode = $("#p-timer");
  const tick = () => {
    const sec = Math.floor((Date.now() - P.startedAt) / 1000);
    const m = Math.floor(sec / 60);
    timerNode.textContent = `${m}:${String(sec % 60).padStart(2, "0")} / ${budget}s`;
    timerNode.className = sec > budget ? "tag bad" : "tag grey";
  };
  tick();
  S.timer = setInterval(tick, 1000);

  $$("#p-opts .opt").forEach((o) => {
    if (P.picked === o.dataset.k) o.classList.add("active");
    if (P.revealed && correctKey && o.dataset.k === correctKey) o.classList.add("right");
    if (P.revealed && P.picked && o.dataset.k === P.picked && P.picked !== correctKey) o.classList.add("wrong");
    o.addEventListener("click", () => {
      if (P.revealed) return;
      P.picked = P.picked === o.dataset.k ? "" : o.dataset.k;
      drawPracticeCard();
    });
  });

  const input = $("#p-input");
  if (input) input.addEventListener("input", (e) => { P.input = e.target.value; });

  $("#p-quit").addEventListener("click", () => {
    if (confirm("结束本轮刷题？")) { clearTimer(); S.practice = null; renderPractice(); }
  });
  if (P.revealed) {
    $$("#p-tags .chip").forEach((c) => c.addEventListener("click", () => {
      c.classList.toggle("active");
      const t = c.dataset.tag;
      P.tagPicks = c.classList.contains("active")
        ? [...P.tagPicks, t] : P.tagPicks.filter((x) => x !== t);
    }));
    $("#p-again")?.addEventListener("click", () => { if (q.image_url) lightbox(q.image_url); });
    $("#p-more")?.addEventListener("click", () => {
      S.questions = [q, ...S.questions.filter((x) => x.id !== q.id)];
      openDetail(q.id);
    });
  }

  $("#p-actions").innerHTML = P.revealed
    ? `<div class="row" style="gap:8px">
         <button class="btn ok grow" id="p-right">做对了</button>
         <button class="btn danger grow" id="p-wrong">做错了</button>
       </div>`
    : `<button class="btn block" id="p-submit">提交答案</button>`;

  if (P.revealed) {
    $("#p-right").addEventListener("click", () => nextQuestion(true));
    $("#p-wrong").addEventListener("click", () => nextQuestion(false));
  } else {
    $("#p-submit").addEventListener("click", () => {
      if (opts.length && !P.picked) return toast("先选一个答案", true);
      if (!opts.length && !q.stem) return toast("看原图作答后直接提交", true);
      P.revealed = true;
      clearTimer();
      drawPracticeCard();
    });
  }
}

async function nextQuestion(selfJudged) {
  const P = S.practice;
  const q = P.queue[P.index];
  const isChoice = q.options && Object.keys(q.options).length > 0;
  const answer = isChoice ? P.picked : P.input;
  const correctKey = (q.answer || "").trim().toUpperCase().charAt(0);

  // 有标准答案的选择题自动判分，其余按自评
  const auto = isChoice && correctKey && P.picked;
  const correct = auto ? (P.picked === correctKey) : selfJudged;

  P.results.push({ id: q.id, correct, answer, auto });
  try {
    await jsonBody(`/api/questions/${q.id}/review`, {
      result: correct ? "correct" : "wrong",
      answer,
      duration_ms: Date.now() - P.startedAt,
      tags: P.tagPicks,
    });
  } catch (e) { toast(e.message, true); }

  P.index += 1;
  P.picked = "";
  P.input = "";
  P.revealed = false;
  P.tagPicks = [];
  P.startedAt = Date.now();
  if (P.index >= P.queue.length) practiceSummary();
  else drawPracticeCard();
}

function practiceSummary() {
  const P = S.practice;
  clearTimer();
  P.done = true;
  setTopActions("");
  const total = P.results.length;
  const right = P.results.filter((r) => r.correct).length;
  const rate = total ? Math.round((right / total) * 100) : 0;
  const wrong = P.results.filter((r) => !r.correct);

  $("#view").innerHTML = `
    <div class="card center" style="padding:26px 16px">
      <div style="font-size:40px">${rate >= 80 ? "🎉" : rate >= 50 ? "💪" : "📖"}</div>
      <h2 style="margin:8px 0 2px">本轮完成</h2>
      <div class="muted">共 ${total} 题，做对 ${right} 题，正确率 ${rate}%</div>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="n">${total}</div><div class="l">已刷题数</div></div>
      <div class="stat"><div class="n" style="color:var(--ok)">${right}</div><div class="l">做对</div></div>
      <div class="stat"><div class="n" style="color:var(--bad)">${total - right}</div><div class="l">做错</div></div>
    </div>
    ${wrong.length ? `
      <div class="card"><h3 style="margin:0 0 8px;font-size:14px">本轮做错的题</h3>
        ${wrong.map((r) => {
          const q = P.queue.find((x) => x.id === r.id);
          return `<div class="item-box">
            <div class="q-stem">${esc(q ? (q.stem || "（图片题）") : "")}</div>
            <div class="tiny" style="margin-top:4px">
              ${esc(q?.category || "")}${q?.subtype ? " · " + esc(q.subtype) : ""} ·
              你的作答：${esc(r.answer || "（空）")} · 正确答案：${esc(q?.answer || "未填写")}</div>
          </div>`;
        }).join("")}
      </div>` : ""}
    <div class="row" style="gap:8px">
      <button class="btn soft grow" id="s-again">只重练错题</button>
      <button class="btn ghost" id="s-back">返回</button>
    </div>`;

  const wrongOnes = wrong.map((r) => P.queue.find((x) => x.id === r.id)).filter(Boolean);
  $("#s-again").addEventListener("click", () => {
    if (!wrongOnes.length) return toast("本轮没有错题");
    startPractice(wrongOnes, P.showImage, P.category);
  });
  $("#s-back").addEventListener("click", () => { S.practice = null; renderPractice(); });
}

/* ---------------------------------------------------------- 统计页 */

async function renderStats() {
  setTopActions("");
  const view = $("#view");
  view.innerHTML = `<div class="center" style="padding:30px"><span class="spinner"></span></div>`;
  let d;
  try { d = await api("/api/stats"); }
  catch (e) { view.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }

  const maxCat = Math.max(1, ...d.by_category.map((x) => x.count));
  const maxRecent = Math.max(1, ...d.recent.map((x) => x.count));
  const days = [];
  const todayMs = new Date(new Date().toDateString()).getTime();
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(todayMs - i * 86400000);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    days.push({ key, label: `${dt.getMonth() + 1}/${dt.getDate()}`,
      count: d.recent.find((r) => r.date === key)?.count || 0 });
  }

  view.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="n">${d.total}</div><div class="l">错题总数</div></div>
      <div class="stat"><div class="n" style="color:var(--accent)">${d.due}</div><div class="l">今天待复习</div></div>
      <div class="stat"><div class="n">${d.review_count_total}</div><div class="l">累计刷题</div></div>
      <div class="stat"><div class="n">${d.mastery === null ? "—" : Math.round(d.mastery * 100) + "%"}</div>
        <div class="l">历史正确率</div></div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 10px;font-size:14px">模块分布</h3>
      ${d.by_category.length ? d.by_category.map((x) => `
        <div class="bar-row">
          <div class="t"><span>${categoryEmoji(x.category)} ${esc(x.category)}</span><b>${x.count}</b></div>
          <div class="bar"><i style="width:${(x.count / maxCat) * 100}%"></i></div>
        </div>`).join("") : `<div class="muted">还没有数据</div>`}
    </div>

    ${d.cat_accuracy.length ? `
    <div class="card">
      <h3 style="margin:0 0 10px;font-size:14px">各模块正确率</h3>
      ${d.cat_accuracy.map((x) => {
        const tot = x.correct + x.wrong;
        const pct = tot ? Math.round((x.correct / tot) * 100) : 0;
        return `<div class="bar-row">
          <div class="t"><span>${categoryEmoji(x.category)} ${esc(x.category)}</span>
            <b style="color:${pct >= 70 ? "var(--ok)" : pct >= 50 ? "var(--warn)" : "var(--bad)"}">${pct}%</b></div>
          <div class="bar"><i style="width:${pct}%;background:${pct >= 70 ? "var(--ok)" : pct >= 50 ? "var(--warn)" : "var(--bad)"}"></i></div>
          <div class="tiny">对 ${x.correct} · 错 ${x.wrong}</div>
        </div>`;
      }).join("")}
    </div>` : ""}

    <div class="card">
      <h3 style="margin:0 0 10px;font-size:14px">薄弱题型 TOP 10</h3>
      ${d.by_subtype.length ? d.by_subtype.slice(0, 10).map((x, i) => `
        <div class="spread" style="padding:6px 0;border-bottom:1px solid var(--line)">
          <span class="grow">${i + 1}. <b>${esc(x.subtype)}</b>
            <span class="tiny">${esc(x.category)}</span></span>
          <span class="tag">${x.count} 题</span>
        </div>`).join("") : `<div class="muted">还没有数据</div>`}
    </div>

    ${d.by_tag.length ? `
    <div class="card">
      <h3 style="margin:0 0 10px;font-size:14px">错因分布</h3>
      <div class="chips" style="flex-wrap:wrap">
        ${d.by_tag.map((x) => `<span class="tag warn">${esc(x.tag)} · ${x.count}</span>`).join("")}
      </div>
    </div>` : ""}

    <div class="card">
      <h3 style="margin:0 0 10px;font-size:14px">最近 14 天录入</h3>
      <div class="spark">
        ${days.map((x) => `<div class="b" title="${x.key}：${x.count}">
          <i style="height:${(x.count / maxRecent) * 100}%;min-height:${x.count ? 2 : 0}px"></i></div>`).join("")}
      </div>
      <div class="spread tiny" style="margin-top:4px">
        <span>${days[0].label}</span><span>${days[days.length - 1].label}</span>
      </div>
    </div>

    ${d.by_source.length ? `
    <div class="card">
      <h3 style="margin:0 0 10px;font-size:14px">题源分布</h3>
      ${d.by_source.map((x) => `
        <div class="spread" style="padding:5px 0">
          <span>${esc(x.source)}</span><span class="tag grey">${x.count} 题</span>
        </div>`).join("")}
    </div>` : ""}

    <div class="card">
      <h3 style="margin:0 0 10px;font-size:14px">导出与打印</h3>
      <div class="row" style="gap:8px">
        <button class="btn soft grow" id="ex-csv">导出 CSV</button>
        <button class="btn soft grow" id="ex-print">打印空白重做卷</button>
      </div>
      <div class="tiny" style="margin-top:8px">打印时可以指定模块，生成一份只有题目、留白作答的重做卷。</div>
    </div>
    <div class="card">
      <h3 style="margin:0 0 10px;font-size:14px">数据与设置</h3>
      <div style="padding:4px 0 8px">
        <div class="tiny" style="margin-bottom:6px">识别前处理（拍照歪了、有笔迹时保持打开）</div>
        <div class="chips" id="ops-chips">
          <button class="chip${loadOps().ink ? " active" : ""}" data-ops="ink">去红蓝笔迹</button>
          <button class="chip${loadOps().pencil ? " active" : ""}" data-ops="pencil">去铅笔痕</button>
          <button class="chip${loadOps().deskew ? " active" : ""}" data-ops="deskew">自动扶正</button>
        </div>
      </div>
      <div class="spread" style="padding:4px 0">
        <span>当前模式</span>
        <span class="tag ${S.mode === "local" ? "ok" : ""}">${
          S.mode === "local" ? "手机本地（离线可用）" : "连接电脑"}</span>
      </div>
      <div class="row" style="gap:8px;margin-top:10px">
        <button class="btn soft grow" id="ex-backup">导出备份</button>
        <button class="btn soft grow" id="ex-restore">恢复备份</button>
      </div>
      <div class="tiny" style="margin-top:8px">
        ${S.mode === "local"
          ? "数据全部存在这台手机里，不上传任何服务器。换手机时用备份文件搬过去。"
          : "数据存在电脑的 data 文件夹里。想在手机上离线用，请安装打包好的 App。"}
      </div>
      ${S.mode === "local" ? `
      <div class="spread" style="padding:4px 0;margin-top:6px">
        <span>自动快照</span>
        <span class="tag grey">${snapLabel()}</span>
      </div>
      <div class="row" style="gap:8px;margin-top:8px">
        <button class="btn soft grow" id="ex-snap">立即快照</button>
        <button class="btn soft grow" id="ex-restore-snap">从快照恢复</button>
      </div>
      <div class="tiny" style="margin-top:6px">
        快照只存题目文字，存在另一处，和主数据分开。升级或误删之后可以用它补回来。
      </div>` : ""}
      <button class="btn ghost block sm" id="ex-mode" style="margin-top:10px">
        切换数据模式（当前：${S.mode === "local" ? "手机本地" : "连接电脑"}）</button>
    </div>
    <div style="height:10px"></div>`;

  $("#ex-csv").addEventListener("click", exportCsv);
  $("#ex-print").addEventListener("click", printSheet);
  $("#ex-backup").addEventListener("click", doBackup);
  $("#ex-restore").addEventListener("click", doRestore);
  $("#ex-mode").addEventListener("click", switchMode);
  $("#ex-snap")?.addEventListener("click", async () => {
    const r = await writeSnapshot(true);
    if (r) { toast(`已保存快照：${r.count} 道题`); render(); }
    else toast("没有可保存的题目", true);
  });
  $("#ex-restore-snap")?.addEventListener("click", async () => {
    const snap = readSnapshot();
    if (!snap || !snap.questions.length) return toast("还没有快照", true);
    if (!confirm(`从 ${snap.at.slice(0, 10)} 的快照恢复 ${snap.count} 道题？\n只会补齐缺失的，不动现有数据。`)) return;
    const r = await restoreSnapshot();
    await loadMeta();
    toast(r.added ? `补回 ${r.added} 道题` : "没有需要补的，数据是完整的");
    render();
  });
  $$("#ops-chips .chip").forEach((c) => c.addEventListener("click", () => {
    const ops = loadOps();
    ops[c.dataset.ops] = !ops[c.dataset.ops];
    saveOps(ops);
    c.classList.toggle("active", ops[c.dataset.ops]);
    toast(`${c.textContent}已${ops[c.dataset.ops] ? "打开" : "关闭"}`);
  }));
}

async function exportCsv() {
  if (S.mode !== "local") { location.href = "/api/export.csv"; return; }
  try {
    const text = await api("/api/export.csv");
    downloadText(text, "kaogong-cuotiben.csv");
    toast("已导出 CSV");
  } catch (e) { toast(e.message, true); }
}

async function doBackup() {
  if (S.mode !== "local") {
    toast("连接电脑模式下，直接备份电脑上的 data 文件夹即可");
    return;
  }
  try {
    const text = await exportBackup();
    downloadText(text, `cuotiben-backup-${new Date().toISOString().slice(0, 10)}.json`,
      "application/json");
    toast("备份已导出");
  } catch (e) { toast(e.message, true); }
}

function doRestore() {
  if (S.mode !== "local") return toast("只在手机本地模式下支持恢复备份");
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".json,application/json";
  picker.addEventListener("change", async () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    try {
      const res = await importBackup(await file.text());
      await loadMeta();
      toast(`已恢复 ${res.questions} 道错题`);
      render();
    } catch (e) { toast("恢复失败：" + e.message, true); }
  });
  picker.click();
}

async function switchMode() {
  const next = S.mode === "local" ? "server" : "local";
  if (!confirm(`切换到「${next === "local" ? "手机本地" : "连接电脑"}」模式？\n\n` +
      `两种模式的数据是分开存的，不会互相覆盖。`)) return;
  localStorage.setItem("appMode", next);
  location.reload();
}

async function printSheet() {
  const scope = prompt(
    `打印哪个模块？\n可选：${S.meta.categories.join("、")}\n留空打印全部：`, "");
  if (scope === null) return;
  const p = new URLSearchParams({ limit: "500" });
  if (scope.trim()) p.set("category", scope.trim());
  const data = await api(`/api/questions?${p}`);
  if (!data.items.length) return toast("没有题目", true);

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <title>考公错题重做卷</title><style>
      body{font:14px/1.8 "Microsoft YaHei",sans-serif;margin:26px;color:#000}
      h1{font-size:20px;text-align:center;margin:0 0 4px}
      .sub{text-align:center;color:#666;font-size:12px;margin-bottom:18px}
      .q{margin-bottom:20px;page-break-inside:avoid}
      .meta{font-size:12px;color:#777;margin-bottom:2px}
      .stem{white-space:pre-wrap}
      .opt{margin-left:14px}
      .blank{height:60px;border-bottom:1px dashed #bbb;margin-top:8px}
      .img{max-width:100%;max-height:260px;margin:6px 0;border:1px solid #eee}
      @media print{ .no-print{display:none} body{margin:12mm} }
    </style></head><body>
    <h1>考公错题重做卷${scope.trim() ? " · " + esc(scope.trim()) : ""}</h1>
    <div class="sub">共 ${data.items.length} 题 · 生成于 ${new Date().toLocaleString("zh-CN")}</div>
    ${data.items.map((q, i) => `<div class="q">
      <div class="meta">${esc(q.category)}${q.subtype ? " · " + esc(q.subtype) : ""}${
        q.source ? " · " + esc(q.source) : ""}</div>
      <div class="stem"><b>${i + 1}.</b> ${esc(q.stem || "（见下图）")}</div>
      ${Object.entries(q.options || {}).sort().map(([k, v]) =>
        `<div class="opt">${esc(k)}. ${esc(v)}</div>`).join("")}
      ${q.image_url ? `<img class="img" src="${location.origin}${esc(q.image_url)}" alt="">` : ""}
      <div class="blank"></div>
    </div>`).join("")}
    <div class="no-print" style="margin-top:20px;text-align:center">
      <button onclick="window.print()" style="padding:8px 20px">打印 / 存为 PDF</button></div>
    </body></html>`;
  const w = window.open("", "_blank");
  if (!w) return toast("浏览器拦截了新窗口", true);
  w.document.write(html);
  w.document.close();
}

/* ---------------------------------------------------------- 启动 */

async function loadMeta() {
  try {
    S.meta = await api("/api/meta");
    if (!S.meta.ocr_ready) {
      toast("OCR 引擎未就绪，图片导入不可用。请查看启动窗口提示。", true);
    }
  } catch (e) { toast("无法连接后端：" + e.message, true); }
}

$$(".tab").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab)));

(async function init() {
  try {
    await boot();
  } catch (e) {
    if (window.__bootShow) window.__bootShow("初始化失败：" + (e && (e.stack || e.message) || e));
    else throw e;
  }
})();

function snapLabel() {
  const snap = readSnapshot();
  if (!snap || !snap.questions.length) return "还没有";
  return `${snap.count} 道 · ${snap.at.slice(5, 10)}`;
}

async function boot() {
  S.mode = await detectMode();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  await loadMeta();
  go("import");
  // 本地模式下先把识别模型加载好，等真正导入时就不用等
  if (S.mode === "local") {
    setProgressHandler(null);
    setTimeout(() => warmUp(), 1200);
    // 后台留一份题目快照，和主数据分开存
    writeSnapshot().catch(() => {});
  }
}
