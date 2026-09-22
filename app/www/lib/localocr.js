/* 本地 OCR：PP-OCRv5 ONNX 模型 + onnxruntime-web，全部离线运行。
 * 模型和 wasm 都在 vendor/ 下，不联网。
 *
 * 识别前会先跑一遍图片预处理（去手写笔迹 + 自动扶正），见 imageproc.js。
 */

import { processCanvas, normalizeOps } from "./imageproc.js";

const CJK = "\u4e00-\u9fff\u3000-\u303f\uff00-\uffef";
const CJK_RE = new RegExp(`([${CJK}])\\s+([${CJK}])`, "g");

let enginePromise = null;
let onProgress = null;

export function setProgressHandler(fn) {
  onProgress = fn;
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

/**
 * 把检测框按"行"分组。
 * 容差取所有文本框高度的中位数，而不是两两比较，避免行高差异大时串行。
 * 每个框优先并入纵向距离最近的那一行。
 */
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
        w: Math.max(...xs) - Math.min(...xs),
        text: l.text.trim(),
        conf: l.confidence,
      };
    })
    .filter((it) => it.h > 0)
    .sort((a, b) => a.cy - b.cy);

  if (!items.length) return [];

  const heights = items.map((it) => it.h).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 20;
  const tol = Math.max(6, medH * 0.5);

  const rows = [];
  for (const it of items) {
    let best = null;
    let bestDist = Infinity;
    for (const row of rows) {
      const dist = Math.abs(row.cy - it.cy);
      if (dist <= tol && dist < bestDist) { best = row; bestDist = dist; }
    }
    if (best) {
      best.items.push(it);
      best.cy = (best.cy * best.n + it.cy) / (best.n + 1);
      best.n += 1;
      best.h = Math.max(best.h, it.h);
    } else {
      rows.push({ cy: it.cy, h: it.h, n: 1, items: [it] });
    }
  }

  rows.sort((a, b) => a.cy - b.cy);
  return rows.map((row) =>
    row.items.sort((a, b) => a.cx - b.cx).map((it) => it.text).join("  ")
  );
}

/** 对已经准备好的 canvas 做识别（裁剪后的图直接用这个） */
export async function recognizeCanvas(canvas, { ops } = {}) {
  const engine = await getEngine();
  const { canvas: ready, meta } = processCanvas(canvas, normalizeOps(ops));
  const t0 = performance.now();
  const res = await engine.recognize(ready, {
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
    width: ready.width,
    height: ready.height,
    meta,
  };
}

/**
 * 识别一个图片文件：先预处理（去手写 + 扶正），再送进 OCR。
 * @returns {{text:string, avgScore:number|null, durationMs:number, meta:object}}
 */
export async function recognizeFile(file, { maxSide = 1600, ops } = {}) {
  const { sourceToCanvas } = await import("./imageproc.js");
  const canvas = await sourceToCanvas(file, maxSide);
  return recognizeCanvas(canvas, { ops });
}
