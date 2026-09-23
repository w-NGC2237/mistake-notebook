/* 裁剪编辑器：选题目范围，顺便预览去手写和自动扶正的效果。
 *
 * 用法：
 *   const out = await openCropEditor(file, { ops });
 *   if (out) { out.file }   // 处理好的新图片，直接拿去识别
 */

import {
  DEFAULT_OPS, normalizeOps, sourceToCanvas, processCanvas, rotateCanvas,
} from "./imageproc.js";

const MIN_SIZE = 44;
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const HANDLE_CURSOR = {
  nw: "nwse-resize", se: "nwse-resize",
  ne: "nesw-resize", sw: "nesw-resize",
  n: "ns-resize", s: "ns-resize",
  e: "ew-resize", w: "ew-resize",
};

/**
 * 把界面上裁剪框的坐标换算成原图里的像素范围。
 * rect / display 都是界面坐标，work 是原图尺寸。
 * 单独抽出来是为了能脱离浏览器做验证。
 */
export function cropRectToSource(rect, display, work) {
  const scaleX = work.width / display.w;
  const scaleY = work.height / display.h;
  const sx = Math.max(0, Math.min(work.width - 1, Math.round(rect.x * scaleX)));
  const sy = Math.max(0, Math.min(work.height - 1, Math.round(rect.y * scaleY)));
  const sw = Math.max(1, Math.min(work.width - sx, Math.round(rect.w * scaleX)));
  const sh = Math.max(1, Math.min(work.height - sy, Math.round(rect.h * scaleY)));
  return { sx, sy, sw, sh };
}

export async function openCropEditor(source, options = {}) {
  const ops = normalizeOps(options.ops || loadOps());
  const work = await sourceToCanvas(source, 1800);
  let processedCache = null;   // 预览用的处理结果

  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "crop-mask";
    mask.innerHTML = `
      <div class="crop-panel">
        <div class="crop-head">
          <span>${options.title || "框住要识别的题目范围"}</span>
          <button class="btn ghost sm" id="crop-cancel-top">取消</button>
        </div>
        <div class="crop-stage" id="crop-stage">
          <canvas id="crop-canvas"></canvas>
          <div class="crop-rect" id="crop-rect">
            ${HANDLES.map((h) => `<i class="crop-h crop-${h}" data-h="${h}"></i>`).join("")}
          </div>
        </div>
        <div class="crop-hint" id="crop-hint">拖动方框选范围，四角可以拉伸。只保留框内的内容。</div>
        <div class="crop-tools">
          <button class="chip${ops.ink ? " active" : ""}" data-op="ink">去红蓝笔迹</button>
          <button class="chip${ops.pencil ? " active" : ""}" data-op="pencil">去铅笔痕</button>
          <button class="chip${ops.deskew ? " active" : ""}" data-op="deskew">自动扶正</button>
          <button class="chip" id="crop-rotate">旋转 90°</button>
          <button class="chip" id="crop-all">全选</button>
        </div>
        <div class="crop-actions">
          <button class="btn ghost grow" id="crop-cancel">取消</button>
          <button class="btn grow" id="crop-ok">确认</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    const stage = mask.querySelector("#crop-stage");
    const canvas = mask.querySelector("#crop-canvas");
    const rectEl = mask.querySelector("#crop-rect");
    const hint = mask.querySelector("#crop-hint");

    let display = { w: 1, h: 1 };
    let rect = { x: 0, y: 0, w: 1, h: 1 };
    let drag = null;

    function layout() {
      const panel = mask.querySelector(".crop-panel");
      const maxW = Math.max(180, Math.min(panel.clientWidth - 24, window.innerWidth - 48));
      const maxH = Math.max(160, Math.min(window.innerHeight * 0.52, 520));
      const scale = Math.min(maxW / work.width, maxH / work.height);
      display = {
        w: Math.max(60, Math.round(work.width * scale)),
        h: Math.max(60, Math.round(work.height * scale)),
      };
      // 容器和图片严格同尺寸，裁剪框的坐标才能直接换算回原图
      stage.style.width = `${display.w}px`;
      stage.style.height = `${display.h}px`;
      const dpr = window.devicePixelRatio > 1 ? 2 : 1;
      canvas.width = Math.round(display.w * dpr);
      canvas.height = Math.round(display.h * dpr);
      canvas.style.width = `${display.w}px`;
      canvas.style.height = `${display.h}px`;
    }

    function draw() {
      const ctx = canvas.getContext("2d");
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const src = processedCache || work;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      ctx.restore();
      rectEl.style.left = `${rect.x}px`;
      rectEl.style.top = `${rect.y}px`;
      rectEl.style.width = `${rect.w}px`;
      rectEl.style.height = `${rect.h}px`;
    }

    function resetRect() {
      const insetX = display.w * 0.04;
      const insetY = display.h * 0.04;
      rect = {
        x: insetX, y: insetY,
        w: display.w - insetX * 2, h: display.h - insetY * 2,
      };
      draw();
    }

    function clampRect() {
      rect.w = Math.min(Math.max(rect.w, MIN_SIZE), display.w);
      rect.h = Math.min(Math.max(rect.h, MIN_SIZE), display.h);
      rect.x = Math.min(Math.max(rect.x, 0), display.w - rect.w);
      rect.y = Math.min(Math.max(rect.y, 0), display.h - rect.h);
    }

    async function refreshPreview() {
      const wanted = ops.ink || ops.pencil || ops.deskew;
      if (!wanted) {
        processedCache = null;
        hint.textContent = "拖动方框选范围，四角可以拉伸。只保留框内的内容。";
        draw();
        return;
      }
      hint.textContent = "正在生成预览…";
      await new Promise((r) => setTimeout(r, 30));
      try {
        const out = processCanvas(work, ops);
        processedCache = out.canvas;
        const parts = [];
        if (out.meta.angle) parts.push(`已扶正 ${Math.abs(out.meta.angle).toFixed(1)}°`);
        else if (ops.deskew) parts.push("无需扶正");
        const wiped = out.meta.inkRemoved + out.meta.pencilRemoved;
        if (wiped) parts.push(`擦除笔迹 ${(wiped / 1000).toFixed(0)}k 像素`);
        hint.textContent = parts.length
          ? `预览已应用：${parts.join(" · ")}`
          : "看不清可以关掉上面的开关再试";
      } catch (e) {
        processedCache = null;
        hint.textContent = "预览失败：" + (e && e.message ? e.message : e);
      }
      draw();
    }

    function onDown(e) {
      const handle = e.target.dataset ? e.target.dataset.h : null;
      const box = rectEl.getBoundingClientRect();
      const inside = e.clientX >= box.left && e.clientX <= box.right
        && e.clientY >= box.top && e.clientY <= box.bottom;
      if (!handle && !inside) return;
      e.preventDefault();
      drag = {
        mode: handle || "move",
        startX: e.clientX,
        startY: e.clientY,
        origin: { ...rect },
      };
      rectEl.setPointerCapture?.(e.pointerId);
    }

    function onMove(e) {
      if (!drag) return;
      e.preventDefault();
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const o = drag.origin;
      let { x, y, w, h } = o;
      const m = drag.mode;
      if (m === "move") {
        x = o.x + dx;
        y = o.y + dy;
      } else {
        if (m.includes("w")) { x = o.x + dx; w = o.w - dx; }
        if (m.includes("e")) { w = o.w + dx; }
        if (m.includes("n")) { y = o.y + dy; h = o.h - dy; }
        if (m.includes("s")) { h = o.h + dy; }
        if (w < MIN_SIZE) { if (m.includes("w")) x = o.x + o.w - MIN_SIZE; w = MIN_SIZE; }
        if (h < MIN_SIZE) { if (m.includes("n")) y = o.y + o.h - MIN_SIZE; h = MIN_SIZE; }
      }
      rect = { x, y, w, h };
      clampRect();
      draw();
    }

    function onUp() { drag = null; }

    mask.addEventListener("pointerdown", onDown);
    mask.addEventListener("pointermove", onMove);
    mask.addEventListener("pointerup", onUp);
    mask.addEventListener("pointercancel", onUp);

    mask.querySelectorAll(".crop-h").forEach((el) => {
      el.style.cursor = HANDLE_CURSOR[el.dataset.h];
    });

    mask.querySelectorAll("[data-op]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.op;
        ops[key] = !ops[key];
        btn.classList.toggle("active", ops[key]);
        saveOps(ops);
        refreshPreview();
      });
    });

    mask.querySelector("#crop-rotate").addEventListener("click", () => {
      const rotated = rotateCanvas(work, 90);
      work.width = rotated.width;
      work.height = rotated.height;
      work.getContext("2d").drawImage(rotated, 0, 0);
      processedCache = null;
      layout();
      resetRect();
      refreshPreview();
    });

    mask.querySelector("#crop-all").addEventListener("click", () => {
      rect = { x: 0, y: 0, w: display.w, h: display.h };
      draw();
    });

    const close = (result) => {
      window.removeEventListener("resize", onResize);
      mask.remove();
      resolve(result);
    };
    mask.querySelector("#crop-cancel").addEventListener("click", () => close(null));
    mask.querySelector("#crop-cancel-top").addEventListener("click", () => close(null));

    mask.querySelector("#crop-ok").addEventListener("click", async () => {
      const btn = mask.querySelector("#crop-ok");
      btn.disabled = true;
      btn.textContent = "处理中…";
      try {
        const { sx, sy, sw, sh } = cropRectToSource(rect, display, work);

        const cropped = document.createElement("canvas");
        cropped.width = sw;
        cropped.height = sh;
        const cctx = cropped.getContext("2d");
        cctx.fillStyle = "#ffffff";
        cctx.fillRect(0, 0, cropped.width, cropped.height);
        cctx.drawImage(work, sx, sy, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);

        const isDefaultOps = ops.ink && ops.pencil && ops.deskew
          && Object.keys(DEFAULT_OPS).every((k) => ops[k] === DEFAULT_OPS[k]);
        // 用户没关掉任何开关时，预处理交给识别流程统一做（Otsu 阈值会更准）
        const out = isDefaultOps ? { canvas: cropped, meta: { deferred: true } } : processCanvas(cropped, ops);
        const blob = await new Promise((r) => out.canvas.toBlob(r, "image/jpeg", 0.94));
        const name = (options.name || "crop") + "-crop.jpg";
        const file = new File([blob], name, { type: "image/jpeg" });
        close({ file, width: out.canvas.width, height: out.canvas.height, meta: out.meta, ops: { ...ops } });
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "确认";
        hint.textContent = "处理失败：" + (e && e.message ? e.message : e);
      }
    });

    const onResize = () => { layout(); resetRect(); refreshPreview(); };
    window.addEventListener("resize", onResize);

    layout();
    resetRect();
    refreshPreview();
  });
}

/* ---------------------------------------------------------- 设置持久化 */

const OPS_KEY = "ocrOps";

export function loadOps() {
  try {
    return normalizeOps(JSON.parse(localStorage.getItem(OPS_KEY) || "null"));
  } catch {
    return { ...DEFAULT_OPS };
  }
}

export function saveOps(ops) {
  try { localStorage.setItem(OPS_KEY, JSON.stringify(normalizeOps(ops))); } catch { /* 忽略 */ }
}
