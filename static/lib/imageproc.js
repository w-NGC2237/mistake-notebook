/* 图片预处理：去手写笔迹 + 自动扶正
 *
 * 这三步都是为了让 OCR 拿到"干净且水平"的图：
 *   1. 去彩色笔迹   —— 红笔、蓝笔批注的饱和度很高，印刷黑字几乎没有饱和度，按饱和度剔除
 *   2. 去浅色笔迹   —— 铅笔是浅灰细线，特点是"周围没有很黑的像素"，据此和印刷字区分
 *   3. 自动扶正     —— 用投影法估计文字行的倾角，把图片转正，解决拍照不水平导致的错行
 *
 * 所有函数都直接在 canvas 上工作，不依赖任何第三方库，浏览器和手机 WebView 都能跑。
 */

export const DEFAULT_OPS = { ink: true, pencil: true, deskew: true };

export function normalizeOps(ops) {
  return { ...DEFAULT_OPS, ...(ops || {}) };
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

export { makeCanvas };

/** 复制一份 canvas */
export function cloneCanvas(src) {
  const out = makeCanvas(src.width, src.height);
  out.getContext("2d").drawImage(src, 0, 0);
  return out;
}

/** 把任意图片源画进 canvas，并限制最长边 */
export async function sourceToCanvas(source, maxSide = 1600) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("图片无法读取"));
      img.src = URL.createObjectURL(source);
    });
  }
  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  const scale = Math.max(w, h) > maxSide ? maxSide / Math.max(w, h) : 1;
  const canvas = makeCanvas(w * scale, h * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();
  return canvas;
}

/* ---------------------------------------------------------- 灰度 / 阈值 */

function luminance(data, n) {
  const lum = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    lum[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }
  return lum;
}

function otsuThreshold(lum) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < lum.length; i++) hist[lum[i]]++;
  const total = lum.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/** 用可分离的膨胀把"确定的黑像素"向外扩一圈，得到保护区 */
function dilate(mask, w, h, radius = 1) {
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -radius; d <= radius && !v; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < w && mask[row + xx]) v = 1;
      }
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -radius; d <= radius && !v; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < h && tmp[yy * w + x]) v = 1;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/* ---------------------------------------------------------- 去手写 */

/**
 * 就地擦除手写笔迹（改成白色）。
 * @returns {{ink:number, pencil:number}} 各擦掉多少像素，用来给用户反馈
 */
export function eraseHandwriting(imageData, ops = DEFAULT_OPS) {
  const o = normalizeOps(ops);
  const { data, width: w, height: h } = imageData;
  const n = w * h;
  const lum = luminance(data, n);
  const thr = otsuThreshold(lum);
  let ink = 0;
  let pencil = 0;

  // --- 1. 彩色笔迹：红笔 / 蓝笔 / 荧光笔
  // 先用饱和度加色差找出笔迹像素，再向外膨胀一圈。
  // 膨胀是为了把笔迹边缘的抗锯齿光晕一起擦掉，否则会留下"小尾巴"，
  // OCR 会把它读成逗号、句号之类的标点。
  const colored = new Uint8Array(n);
  let coloredCount = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    if (!mx) continue;
    const sat = (mx - mn) / mx;
    // 印刷黑字饱和度接近 0；JPEG 在文字边缘的彩色噪点色差很小，
    // 加了 delta 判据之后不会被误擦，字边才不会被啃掉。
    if (sat > 0.26 && (mx - mn) > 50 && mx > 40) { colored[i] = 1; coloredCount++; }
  }
  const grown = coloredCount ? dilate(colored, w, h, 1) : colored;
  if (o.ink && coloredCount) {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      if (!grown[i]) continue;
      data[p] = 255; data[p + 1] = 255; data[p + 2] = 255; data[p + 3] = 255;
      ink++;
    }
  }

  // --- 2. 浅色铅笔：中等灰度、细线、周围没有很黑的像素
  if (o.pencil) {
    const coreThr = Math.max(40, Math.round(thr * 0.6));
    const core = new Uint8Array(n);
    let coreCount = 0;
    for (let i = 0; i < n; i++) {
      if (lum[i] <= coreThr) { core[i] = 1; coreCount++; }
    }
    // 整张图几乎没有黑字，说明不是试卷照片，不要乱擦
    if (coreCount > n * 0.0005) {
      const guard = dilate(core, w, h, 1);
      const lo = Math.max(70, Math.round(thr * 0.72));
      const hi = 218;
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        if (guard[i]) continue;
        if (data[p] === 255 && data[p + 1] === 255 && data[p + 2] === 255) continue;
        const r = data[p];
        const g = data[p + 1];
        const b = data[p + 2];
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (grown[i]) continue;                       // 已经按彩色笔迹擦过了
        if (lum[i] >= lo && lum[i] <= hi) {
          data[p] = 255; data[p + 1] = 255; data[p + 2] = 255; data[p + 3] = 255;
          pencil++;
        }
      }
    }
  }

  return { ink, pencil };
}

/* ---------------------------------------------------------- 自动扶正 */

/**
 * 估计文字行的倾斜角，单位「度」。
 * 思路：文字行在水平方向上成行时，把所有黑像素按 y 做投影会出现明显尖峰。
 * 我们试着把坐标按不同斜率 m 斜切（t = y - m·x），谁的投影最尖锐，谁就是真实倾角。
 * 返回值是「把图转正需要旋转的角度」，正值表示需要逆时针旋转。
 */
export function estimateSkewAngle(canvas, opts = {}) {
  const maxSide = opts.maxSide || 640;
  const scale = Math.max(canvas.width, canvas.height) > maxSide
    ? maxSide / Math.max(canvas.width, canvas.height)
    : 1;
  const w = Math.max(16, Math.round(canvas.width * scale));
  const h = Math.max(16, Math.round(canvas.height * scale));
  const small = makeCanvas(w, h);
  small.getContext("2d").drawImage(canvas, 0, 0, w, h);
  const src = small.getContext("2d").getImageData(0, 0, w, h).data;
  return estimateSkewFromGray(luminance(src, w * h), w, h, opts);
}

/** 纯算法版本：直接吃灰度数组，方便在 Node 里和 Python 版做一致性比对 */
export function estimateSkewFromGray(lum, w, h, { range = 10, coarse = 1, fine = 0.2 } = {}) {
  const thr = otsuThreshold(lum);

  const xs = [];
  const ys = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (lum[y * w + x] < thr) { xs.push(x); ys.push(y); }
    }
  }
  if (xs.length < 60) return { angle: 0, confidence: 0, threshold: thr, points: xs.length };

  // 黑点太多就抽样，保证速度
  const stride = Math.max(1, Math.ceil(xs.length / 40000));
  const px = [];
  const py = [];
  for (let i = 0; i < xs.length; i += stride) { px.push(xs[i]); py.push(ys[i]); }

  const binH = 2;
  const span = Math.ceil((h + w * Math.tan((range * Math.PI) / 180)) / binH) + 4;
  const hist = new Int32Array(span);

  const scoreAt = (deg) => {
    const m = Math.tan((deg * Math.PI) / 180);
    hist.fill(0);
    for (let i = 0; i < px.length; i++) {
      const t = py[i] - m * px[i];
      const bin = Math.round(t / binH) + (span >> 1);
      if (bin >= 0 && bin < span) hist[bin]++;
    }
    let acc = 0;
    for (let i = 0; i < span; i++) acc += hist[i] * hist[i];
    return acc / px.length;
  };

  let bestDeg = 0;
  let bestScore = -1;
  for (let d = -range; d <= range + 1e-9; d += coarse) {
    const s = scoreAt(d);
    if (s > bestScore) { bestScore = s; bestDeg = d; }
  }
  let fineBest = bestDeg;
  let fineScore = bestScore;
  for (let d = bestDeg - coarse; d <= bestDeg + coarse + 1e-9; d += fine) {
    const s = scoreAt(d);
    if (s > fineScore) { fineScore = s; fineBest = d; }
  }

  // 和 0 度比一比，提升不明显就别转了，避免把本来正的图转歪
  const zero = scoreAt(0);
  const gain = zero > 0 ? (fineScore - zero) / zero : 0;
  const angle = gain > 0.02 ? -fineBest : 0;
  return {
    angle: Math.round(angle * 100) / 100,
    confidence: Math.round(gain * 1000) / 1000,
    threshold: thr,
    points: px.length,
  };
}

/** 按给定角度旋转 canvas（正值 = 顺时针），自动扩充画布避免切角，底色白 */
export function rotateCanvas(canvas, deg) {
  if (!deg) return canvas;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const w = canvas.width * cos + canvas.height * sin;
  const h = canvas.width * sin + canvas.height * cos;
  // 只保留需要的部分，别让白边无限膨胀
  const out = makeCanvas(w, h);
  const ctx = out.getContext("2d");
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rad);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

/** 去掉旋转后四周多余的白边 */
export function trimWhite(canvas, threshold = 245, pad = 6) {
  const { width: w, height: h } = canvas;
  const data = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  let left = w;
  let right = -1;
  let top = h;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (data[p] < threshold || data[p + 1] < threshold || data[p + 2] < threshold) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0 || bottom < 0) return canvas;
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(w - 1, right + pad);
  bottom = Math.min(h - 1, bottom + pad);
  const out = makeCanvas(right - left + 1, bottom - top + 1);
  out.getContext("2d").drawImage(canvas, -left, -top);
  return out;
}

/**
 * 完整预处理：去手写 → 扶正 → 裁掉白边。
 * @returns {{canvas: HTMLCanvasElement, meta: object}}
 */
export function processCanvas(input, ops = DEFAULT_OPS) {
  const o = normalizeOps(ops);
  let canvas = cloneCanvas(input);
  const meta = { inkRemoved: 0, pencilRemoved: 0, angle: 0, deskewGain: 0 };

  if (o.ink || o.pencil) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const stat = eraseHandwriting(imgData, o);
    ctx.putImageData(imgData, 0, 0);
    meta.inkRemoved = stat.ink;
    meta.pencilRemoved = stat.pencil;
  }

  if (o.deskew) {
    const est = estimateSkewAngle(canvas);
    meta.deskewGain = est.confidence;
    if (Math.abs(est.angle) >= 0.25) {
      canvas = rotateCanvas(canvas, est.angle);
      meta.angle = est.angle;
    }
  }

  return { canvas, meta };
}
