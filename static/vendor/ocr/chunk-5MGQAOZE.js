// src/geometry.ts
function convexHull(points) {
  const n = points.length;
  if (n < 2) return points.slice();
  const sorted = points.slice().sort((a, b) => a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
function minAreaRect(hull) {
  if (hull.length < 2) {
    const x = hull[0]?.[0] ?? 0;
    const y = hull[0]?.[1] ?? 0;
    return { cx: x, cy: y, width: 0, height: 0, angleRad: 0 };
  }
  let best = null;
  let bestArea = Number.POSITIVE_INFINITY;
  const n = hull.length;
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    let minU = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy;
      const v = -p[0] * uy + p[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU;
    const h = maxV - minV;
    const area = w * h;
    if (area < bestArea) {
      bestArea = area;
      const midU = (minU + maxU) / 2;
      const midV = (minV + maxV) / 2;
      const cx = midU * ux - midV * uy;
      const cy = midU * uy + midV * ux;
      best = { cx, cy, width: w, height: h, angleRad: Math.atan2(uy, ux) };
    }
  }
  return best;
}
function rectCorners(r) {
  const cos = Math.cos(r.angleRad);
  const sin = Math.sin(r.angleRad);
  const hw = r.width / 2;
  const hh = r.height / 2;
  const local = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh]
  ];
  const corners = local.map(([x, y]) => [
    r.cx + x * cos - y * sin,
    r.cy + x * sin + y * cos
  ]);
  return [corners[0], corners[1], corners[2], corners[3]];
}
function unclipRect(r, distance) {
  return {
    cx: r.cx,
    cy: r.cy,
    width: r.width + 2 * distance,
    height: r.height + 2 * distance,
    angleRad: r.angleRad
  };
}
function unclipDistance(r, ratio) {
  const area = r.width * r.height;
  const perimeter = 2 * (r.width + r.height) || 1;
  return area * ratio / perimeter;
}
function orderQuad(quad) {
  const pts = quad.slice();
  pts.sort((a, b) => a[1] - b[1]);
  const top = pts.slice(0, 2).sort((a, b) => a[0] - b[0]);
  const bot = pts.slice(2, 4).sort((a, b) => a[0] - b[0]);
  return [top[0], top[1], bot[1], bot[0]];
}
function quadWidth(q) {
  return Math.max(
    Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]),
    Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1])
  );
}
function quadHeight(q) {
  return Math.max(
    Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]),
    Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1])
  );
}
function quadCenter(q) {
  return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
}

// src/det/postprocess.ts
function postprocessDet(probMap, w, h, opts) {
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < probMap.length; i++) {
    if (probMap[i] > opts.threshold) bin[i] = 1;
  }
  const components = findComponents(bin, w, h);
  const boxes = [];
  for (const pts of components) {
    if (pts.length < opts.minBoxSize) continue;
    const hull = convexHull(pts);
    if (hull.length < 3) continue;
    const rect = minAreaRect(hull);
    if (Math.min(rect.width, rect.height) < 3) continue;
    const score = boxScore(probMap, w, h, pts);
    if (score < opts.boxThreshold) continue;
    const distance = unclipDistance(rect, opts.unclipRatio);
    const expanded = unclipRect(rect, distance);
    if (Math.min(expanded.width, expanded.height) < opts.minBoxSize) continue;
    const corners = rectCorners(expanded);
    const ordered = orderQuad(corners);
    const scaled = ordered.map(([x, y]) => [x * opts.scaleX, y * opts.scaleY]);
    boxes.push({ box: scaled, score });
  }
  return boxes;
}
function findComponents(bin, w, h) {
  const visited = new Uint8Array(w * h);
  const components = [];
  const stack = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!bin[idx] || visited[idx]) continue;
      const pts = [];
      stack.push(idx);
      visited[idx] = 1;
      while (stack.length) {
        const cur = stack.pop();
        const cy = cur / w | 0;
        const cx = cur - cy * w;
        pts.push([cx, cy]);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const nIdx = ny * w + nx;
            if (visited[nIdx] || !bin[nIdx]) continue;
            visited[nIdx] = 1;
            stack.push(nIdx);
          }
        }
      }
      components.push(pts);
    }
  }
  return components;
}
function boxScore(probMap, w, h, pts) {
  let sum = 0;
  for (const [x, y] of pts) sum += probMap[y * w + x] ?? 0;
  return sum / pts.length;
}

// src/runtime.ts
import * as ort from "../ort/ort.wasm.min.mjs";
var configured = false;
function configureOrt(opts) {
  if (configured) return;
  if (opts.wasmPaths !== void 0) {
    ort.env.wasm.wasmPaths = opts.wasmPaths;
  }
  ort.env.wasm.numThreads = opts.numThreads ?? 1;
  ort.env.logLevel = "warning";
  configured = true;
}
async function fetchWithProgress(url, name, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${name} from ${url} (${res.status})`);
  const total = Number(res.headers.get("content-length") ?? 0);
  if (!onProgress || !res.body || total === 0) {
    return new Uint8Array(await res.arrayBuffer());
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total, name);
    }
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
async function createSession(model, runtime, name, onProgress) {
  const opts = {
    executionProviders: [runtime],
    graphOptimizationLevel: "all"
  };
  if (typeof model === "string") {
    const bytes = await fetchWithProgress(model, name, onProgress);
    return ort.InferenceSession.create(bytes, opts);
  }
  if (model instanceof Uint8Array) return ort.InferenceSession.create(model, opts);
  return ort.InferenceSession.create(new Uint8Array(model), opts);
}

// src/det/preprocess.ts
var MEAN = [0.485, 0.456, 0.406];
var STD = [0.229, 0.224, 0.225];
function roundTo32(n) {
  return Math.max(32, Math.round(n / 32) * 32);
}
function preprocessForDet(img, maxSideLen) {
  const { width: srcW, height: srcH } = img;
  const ratio = Math.max(srcW, srcH) > maxSideLen ? maxSideLen / Math.max(srcW, srcH) : 1;
  const targetW = roundTo32(srcW * ratio);
  const targetH = roundTo32(srcH * ratio);
  const off = new OffscreenCanvas(targetW, targetH);
  const ctx = off.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
  const srcCanvas = new OffscreenCanvas(srcW, srcH);
  const srcImageData = new ImageData(new Uint8ClampedArray(img.data), srcW, srcH);
  srcCanvas.getContext("2d").putImageData(srcImageData, 0, 0);
  ctx.drawImage(srcCanvas, 0, 0, targetW, targetH);
  const { data } = ctx.getImageData(0, 0, targetW, targetH);
  const chw = new Float32Array(3 * targetH * targetW);
  const plane = targetH * targetW;
  const m0 = MEAN[0];
  const m1 = MEAN[1];
  const m2 = MEAN[2];
  const s0 = STD[0];
  const s1 = STD[1];
  const s2 = STD[2];
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    chw[p] = (data[i] / 255 - m0) / s0;
    chw[plane + p] = (data[i + 1] / 255 - m1) / s1;
    chw[2 * plane + p] = (data[i + 2] / 255 - m2) / s2;
  }
  return {
    tensor: new ort.Tensor("float32", chw, [1, 3, targetH, targetW]),
    resizedW: targetW,
    resizedH: targetH,
    scaleX: srcW / targetW,
    scaleY: srcH / targetH
  };
}

// src/det/module.ts
var DetectionModule = class {
  constructor(session) {
    this.session = session;
  }
  session;
  async detect(img, opts) {
    const { tensor, resizedW, resizedH, scaleX, scaleY } = preprocessForDet(img, opts.maxSideLen);
    const inputName = this.session.inputNames[0];
    const outputs = await this.session.run({ [inputName]: tensor });
    const outName = this.session.outputNames[0];
    const out = outputs[outName];
    const probMap = out.data;
    const dims = out.dims;
    const oh = dims[2];
    const ow = dims[3];
    if (ow !== resizedW || oh !== resizedH) {
    }
    return postprocessDet(probMap, ow, oh, {
      threshold: opts.detThreshold,
      boxThreshold: opts.detBoxThreshold,
      unclipRatio: opts.unclipRatio,
      minBoxSize: opts.minBoxSize,
      scaleX: img.width / ow,
      scaleY: img.height / oh
    });
  }
};

// src/input.ts
async function blobToImageData(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    return bitmapToImageData(bitmap);
  } finally {
    bitmap.close();
  }
}
function bitmapToImageData(bmp) {
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { data: img.data, width: img.width, height: img.height };
}
function canvasToImageData(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2d context unavailable");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, width: img.width, height: img.height };
}
async function normalizeInput(input) {
  if (typeof input === "string") {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`Failed to fetch image: ${input} (${res.status})`);
    return blobToImageData(await res.blob());
  }
  if (input instanceof Blob) return blobToImageData(input);
  if (typeof ImageBitmap !== "undefined" && input instanceof ImageBitmap)
    return bitmapToImageData(input);
  if (typeof ImageData !== "undefined" && input instanceof ImageData)
    return { data: input.data, width: input.width, height: input.height };
  if (typeof HTMLCanvasElement !== "undefined" && input instanceof HTMLCanvasElement)
    return canvasToImageData(input);
  if (typeof OffscreenCanvas !== "undefined" && input instanceof OffscreenCanvas)
    return canvasToImageData(input);
  throw new Error("Unsupported ImageInput type");
}

// src/rec/decode.ts
function loadDictionary(source) {
  if (Array.isArray(source)) return source.slice();
  const lines = source.split("\n").filter((line) => line.length > 0);
  return [...lines, " "];
}
function ctcGreedyDecode(logits, T, C, dict) {
  const out = [];
  const probs = [];
  let prev = -1;
  for (let t = 0; t < T; t++) {
    let maxIdx = 0;
    let maxVal = logits[t * C];
    for (let c = 1; c < C; c++) {
      const v = logits[t * C + c];
      if (v > maxVal) {
        maxVal = v;
        maxIdx = c;
      }
    }
    if (maxIdx !== 0 && maxIdx !== prev) {
      const ch = dict[maxIdx - 1];
      if (ch !== void 0) {
        out.push(ch);
        probs.push(maxVal);
      }
    }
    prev = maxIdx;
  }
  const conf = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 0;
  return { text: out.join(""), confidence: conf };
}

// src/rec/crop.ts
function solveHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = src[i];
    const [dx, dy] = dst[i];
    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
    b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
    b.push(dy);
  }
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(M[r][i]) > Math.abs(M[pivot][i])) pivot = r;
    }
    if (pivot !== i) [M[i], M[pivot]] = [M[pivot], M[i]];
    const div = M[i][i];
    if (Math.abs(div) < 1e-12) throw new Error("Singular matrix in homography");
    for (let c = i; c <= n; c++) M[i][c] = M[i][c] / div;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const factor = M[r][i];
      if (factor === 0) continue;
      for (let c = i; c <= n; c++) M[r][c] = M[r][c] - factor * M[i][c];
    }
  }
  return new Float64Array([
    M[0][8],
    M[1][8],
    M[2][8],
    M[3][8],
    M[4][8],
    M[5][8],
    M[6][8],
    M[7][8],
    1
  ]);
}
function invertHomography(h) {
  const a = h[0];
  const b = h[1];
  const c = h[2];
  const d = h[3];
  const e = h[4];
  const f = h[5];
  const g = h[6];
  const hh = h[7];
  const i = h[8];
  const det = a * (e * i - f * hh) - b * (d * i - f * g) + c * (d * hh - e * g);
  if (Math.abs(det) < 1e-12) throw new Error("Non-invertible homography");
  const inv = new Float64Array(9);
  inv[0] = (e * i - f * hh) / det;
  inv[1] = (c * hh - b * i) / det;
  inv[2] = (b * f - c * e) / det;
  inv[3] = (f * g - d * i) / det;
  inv[4] = (a * i - c * g) / det;
  inv[5] = (c * d - a * f) / det;
  inv[6] = (d * hh - e * g) / det;
  inv[7] = (b * g - a * hh) / det;
  inv[8] = (a * e - b * d) / det;
  return inv;
}
function warpQuad(src, quad, targetW, targetH) {
  const dst = [
    [0, 0],
    [targetW - 1, 0],
    [targetW - 1, targetH - 1],
    [0, targetH - 1]
  ];
  const fwd = solveHomography(quad, dst);
  const inv = invertHomography(fwd);
  const out = new Uint8ClampedArray(targetW * targetH * 4);
  const sw = src.width;
  const sh = src.height;
  const sd = src.data;
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const wz = inv[6] * x + inv[7] * y + inv[8];
      const sx = (inv[0] * x + inv[1] * y + inv[2]) / wz;
      const sy = (inv[3] * x + inv[4] * y + inv[5]) / wz;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = x0 + 1;
      const y1 = y0 + 1;
      const dx = sx - x0;
      const dy = sy - y0;
      const oOff = (y * targetW + x) * 4;
      if (x0 < 0 || y0 < 0 || x1 >= sw || y1 >= sh) {
        out[oOff] = 0;
        out[oOff + 1] = 0;
        out[oOff + 2] = 0;
        out[oOff + 3] = 255;
        continue;
      }
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - dx) * (1 - dy);
      const w10 = dx * (1 - dy);
      const w01 = (1 - dx) * dy;
      const w11 = dx * dy;
      for (let c = 0; c < 3; c++) {
        out[oOff + c] = sd[i00 + c] * w00 + sd[i10 + c] * w10 + sd[i01 + c] * w01 + sd[i11 + c] * w11;
      }
      out[oOff + 3] = 255;
    }
  }
  return out;
}

// src/rec/preprocess.ts
var REC_HEIGHT = 32;
var PAD_TO_MULTIPLE = 16;
function preprocessRecCrop(rgba, srcW, srcH) {
  const targetH = REC_HEIGHT;
  const ratio = targetH / srcH;
  let targetW = Math.ceil(srcW * ratio);
  if (targetW < PAD_TO_MULTIPLE) targetW = PAD_TO_MULTIPLE;
  const paddedW = Math.ceil(targetW / PAD_TO_MULTIPLE) * PAD_TO_MULTIPLE;
  const srcCanvas = new OffscreenCanvas(srcW, srcH);
  const srcImageData = new ImageData(new Uint8ClampedArray(rgba), srcW, srcH);
  srcCanvas.getContext("2d").putImageData(srcImageData, 0, 0);
  const dstCanvas = new OffscreenCanvas(paddedW, targetH);
  const ctx = dstCanvas.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, paddedW, targetH);
  ctx.drawImage(srcCanvas, 0, 0, srcW, srcH, 0, 0, targetW, targetH);
  const { data } = ctx.getImageData(0, 0, paddedW, targetH);
  const chw = new Float32Array(3 * targetH * paddedW);
  const plane = targetH * paddedW;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    chw[p] = (data[i] / 255 - 0.5) / 0.5;
    chw[plane + p] = (data[i + 1] / 255 - 0.5) / 0.5;
    chw[2 * plane + p] = (data[i + 2] / 255 - 0.5) / 0.5;
  }
  return {
    tensor: new ort.Tensor("float32", chw, [1, 3, targetH, paddedW]),
    width: paddedW
  };
}

// src/rec/module.ts
var REC_HEIGHT2 = 32;
var BATCH_SIZE = 8;
var PAD_TO_MULTIPLE2 = 16;
var RecognitionModule = class {
  constructor(session, dict) {
    this.session = session;
    this.dict = dict;
  }
  session;
  dict;
  async recognizeBoxes(img, detBoxes) {
    if (detBoxes.length === 0) return [];
    const prepared = detBoxes.map(({ box }) => {
      const targetW = Math.max(REC_HEIGHT2, Math.round(quadWidth(box)));
      const targetH = Math.max(REC_HEIGHT2, Math.round(quadHeight(box)));
      const rgba = warpQuad(img, box, targetW, targetH);
      const { tensor, width } = preprocessRecCrop(rgba, targetW, targetH);
      return { tensor, tensorWidth: width, box };
    });
    prepared.sort((a, b) => a.tensorWidth - b.tensorWidth);
    const lines = [];
    const inputName = this.session.inputNames[0];
    const outName = this.session.outputNames[0];
    for (let start = 0; start < prepared.length; start += BATCH_SIZE) {
      const chunk = prepared.slice(start, start + BATCH_SIZE);
      const maxW = Math.max(...chunk.map((c) => c.tensorWidth));
      const paddedW = Math.ceil(maxW / PAD_TO_MULTIPLE2) * PAD_TO_MULTIPLE2;
      const N = chunk.length;
      const planeSize = REC_HEIGHT2 * paddedW;
      const batchData = new Float32Array(N * 3 * planeSize);
      for (let i = 0; i < N; i++) {
        const { tensor, tensorWidth } = chunk[i];
        const src = tensor.data;
        const srcPlane = REC_HEIGHT2 * tensorWidth;
        for (let c = 0; c < 3; c++) {
          for (let y = 0; y < REC_HEIGHT2; y++) {
            const srcOff = c * srcPlane + y * tensorWidth;
            const dstOff = i * 3 * planeSize + c * planeSize + y * paddedW;
            batchData.set(src.subarray(srcOff, srcOff + tensorWidth), dstOff);
          }
        }
      }
      const Tensor = chunk[0].tensor.constructor;
      const batchTensor = new Tensor("float32", batchData, [N, 3, REC_HEIGHT2, paddedW]);
      const outputs = await this.session.run({ [inputName]: batchTensor });
      const out = outputs[outName];
      const dims = out.dims;
      const T = dims[1];
      const C = dims[2];
      const logits = out.data;
      for (let i = 0; i < N; i++) {
        const slice = logits.subarray(i * T * C, (i + 1) * T * C);
        const { text, confidence } = ctcGreedyDecode(slice, T, C, this.dict);
        if (!text) continue;
        lines.push({ text, box: chunk[i].box, confidence });
      }
    }
    return lines;
  }
};

// src/engine.ts
var DEFAULT_RECOGNIZE_OPTS = {
  useClassification: false,
  detThreshold: 0.3,
  detBoxThreshold: 0.6,
  maxSideLen: 960,
  unclipRatio: 1.6,
  minBoxSize: 3
};
function isFetchableSource(s) {
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../")) return true;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}
async function fetchDictionary(source) {
  if (Array.isArray(source)) return loadDictionary(source);
  if (isFetchableSource(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Failed to fetch dictionary ${source} (${res.status})`);
    return loadDictionary(await res.text());
  }
  return loadDictionary(source);
}
var OcrEngine = class _OcrEngine {
  constructor(det, rec, sessions) {
    this.det = det;
    this.rec = rec;
    this.sessions = sessions;
  }
  det;
  rec;
  sessions;
  static async create(opts) {
    configureOrt({ wasmPaths: opts.wasmPaths, numThreads: opts.numThreads });
    const runtime = opts.runtime ?? "wasm";
    const onProgress = opts.onProgress ? (loaded, total, file) => opts.onProgress({ loaded, total, file }) : void 0;
    const [detSession, recSession, dict] = await Promise.all([
      createSession(opts.models.detection, runtime, "detection", onProgress),
      createSession(opts.models.recognition, runtime, "recognition", onProgress),
      fetchDictionary(opts.dictionary)
    ]);
    return new _OcrEngine(new DetectionModule(detSession), new RecognitionModule(recSession, dict), [
      detSession,
      recSession
    ]);
  }
  async recognize(input, opts = {}) {
    const start = performance.now();
    const merged = { ...DEFAULT_RECOGNIZE_OPTS, ...opts };
    const img = await normalizeInput(input);
    const detBoxes = await this.det.detect(img, merged);
    const lines = await this.rec.recognizeBoxes(img, detBoxes);
    const sorted = sortLines(lines);
    return {
      lines: sorted,
      fullText: sorted.map((l) => l.text).join("\n"),
      durationMs: performance.now() - start
    };
  }
  async dispose() {
    await Promise.all(this.sessions.map((s) => s.release().catch(() => void 0)));
  }
};
function sortLines(lines) {
  if (lines.length === 0) return lines;
  const items = lines.map((l) => ({ line: l, center: quadCenter(l.box) }));
  const heights = items.map(({ line }) => {
    const h1 = Math.hypot(line.box[3][0] - line.box[0][0], line.box[3][1] - line.box[0][1]);
    const h2 = Math.hypot(line.box[2][0] - line.box[1][0], line.box[2][1] - line.box[1][1]);
    return Math.max(h1, h2);
  });
  const medianH = heights.slice().sort((a, b) => a - b)[Math.floor(heights.length / 2)] ?? 20;
  const tol = medianH * 0.6;
  items.sort((a, b) => {
    if (Math.abs(a.center[1] - b.center[1]) < tol) return a.center[0] - b.center[0];
    return a.center[1] - b.center[1];
  });
  return items.map(({ line }) => line);
}

// src/rpc.ts
function isRpcMessage(data) {
  return typeof data === "object" && data !== null && "__rpc" in data;
}

export {
  normalizeInput,
  OcrEngine,
  isRpcMessage
};
//# sourceMappingURL=chunk-5MGQAOZE.js.map