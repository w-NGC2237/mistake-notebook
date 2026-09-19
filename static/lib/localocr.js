/* 本地 OCR：PP-OCRv5 ONNX 模型 + onnxruntime-web，全部离线运行。
 * 模型和 wasm 都在 vendor/ 下，不联网。首次调用会加载约 20MB 模型。
 */

const CJK = "\u4e00-\u9fff\u3000-\u303f\uff00-\uffef";
const CJK_RE = new RegExp(`([${CJK}])\\s+([${CJK}])`, "g");

let enginePromise = null;
let onProgress = null;
let progressPhase = "";

export function setProgressHandler(fn) {
  onProgress = fn;
}

export function setProgressPhase(phase) {
  progressPhase = phase;
}

export function isSupported() {
  return typeof WebAssembly === "object" && typeof createImageBitmap === "function";
}

export async function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const coreUrl = new URL("../vendor/ocr/core.js", import.meta.url).href;
      const modelBase = new URL("../vendor/ocr/models/", import.meta.url).href;
      const { OcrEngine } = await import(coreUrl);
      return OcrEngine.create({
        models: {
          detection: modelBase + "ppocrv5_det.onnx",
          recognition: modelBase + "ppocrv5_rec.onnx",
        },
        dictionary: modelBase + "ppocrv5_dict.txt",
        wasmPaths: new URL("../vendor/ort/", import.meta.url).href,
        runtime: "wasm",
        numThreads: 1,
        onProgress: (p) => onProgress && onProgress(p),
      });
    })().catch((e) => {
      enginePromise = null;
      throw e;
    });
  }
  return enginePromise;
}

/** 预热：页面空闲时先加载模型，等真正识别时就不用等 */
export function warmUp() {
  return getEngine().catch(() => {});
}

/** 把图片压到最长边 maxSide，返回 canvas */
async function toCanvas(blobOrFile, maxSide = 1600) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blobOrFile);
  } catch {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("图片无法读取"));
      img.src = URL.createObjectURL(blobOrFile);
    });
  }
  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  const scale = Math.max(w, h) > maxSide ? maxSide / Math.max(w, h) : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();
  return canvas;
}

/** 去掉汉字之间被识别出来的多余空格 */
export function cleanText(text) {
  if (!text) return "";
  let s = text.replace(/\u00a0/g, " ");
  let prev = null;
  while (prev !== s) {
    prev = s;
    s = s.replace(CJK_RE, "$1$2");
  }
  s = s.replace(/[\u200b-\u200f\ufeff]/g, "");
  s = s.replace(/[ \t]{2,}/g, "  ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** 把检测框按"行"分组，行内按横坐标排序，还原阅读顺序 */
function groupLines(lines) {
  const items = lines
    .filter((l) => l.text && l.text.trim())
    .map((l) => {
      const xs = l.box.map((p) => p[0]);
      const ys = l.box.map((p) => p[1]);
      return {
        cx: xs.reduce((a, b) => a + b, 0) / xs.length,
        cy: ys.reduce((a, b) => a + b, 0) / ys.length,
        h: Math.max(...ys) - Math.min(...ys),
        text: l.text.trim(),
        conf: l.confidence,
      };
    })
    .sort((a, b) => a.cy - b.cy);

  const rows = [];
  for (const it of items) {
    let placed = false;
    for (const row of rows) {
      if (Math.abs(row.cy - it.cy) <= Math.max(it.h, row.h) * 0.6) {
        row.items.push(it);
        row.cy = (row.cy * row.n + it.cy) / (row.n + 1);
        row.h = Math.max(row.h, it.h);
        row.n += 1;
        placed = true;
        break;
      }
    }
    if (!placed) rows.push({ cy: it.cy, h: it.h, n: 1, items: [it] });
  }
  rows.sort((a, b) => a.cy - b.cy);
  return rows.map((row) =>
    row.items.sort((a, b) => a.cx - b.cx).map((it) => it.text).join("  ")
  );
}

/**
 * 识别一个图片文件。
 * @returns {{text: string, avgScore: number|null, durationMs: number}}
 */
export async function recognizeFile(file, { maxSide = 1600 } = {}) {
  const engine = await getEngine();
  const canvas = await toCanvas(file, maxSide);
  const t0 = performance.now();
  const res = await engine.recognize(canvas, {
    detThreshold: 0.2,
    unclipRatio: 1.8,
    maxSideLen: 1400,
  });
  const rows = groupLines(res.lines);
  const confs = res.lines.map((l) => l.confidence).filter((c) => typeof c === "number");
  return {
    text: cleanText(rows.join("\n")),
    avgScore: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
    durationMs: Math.round(performance.now() - t0),
  };
}
