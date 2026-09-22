/* 裁剪坐标换算的单元验证： node tools/test_crop.mjs */
import { cropRectToSource } from "../static/lib/crop.js";

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log("  OK  " + name + "  " + JSON.stringify(got)); }
  else { fail++; console.log("  !!  " + name + "  得到 " + JSON.stringify(got) + " 期望 " + JSON.stringify(want)); }
}

const work = { width: 1600, height: 1200 };

// 1. 显示尺寸和原图一致，框全选 → 整张图
check("全选整图",
  cropRectToSource({ x: 0, y: 0, w: 1600, h: 1200 }, { w: 1600, h: 1200 }, work),
  { sx: 0, sy: 0, sw: 1600, sh: 1200 });

// 2. 显示缩小一半，框住中间一半 → 原图中间一半
check("缩小一半",
  cropRectToSource({ x: 200, y: 150, w: 400, h: 300 }, { w: 800, h: 600 }, work),
  { sx: 400, sy: 300, sw: 800, sh: 600 });

// 3. 框超出右下边界 → 收回到图内，不越界
check("超出右下角",
  cropRectToSource({ x: 700, y: 500, w: 400, h: 300 }, { w: 800, h: 600 }, work),
  { sx: 1400, sy: 1000, sw: 200, sh: 200 });

// 4. 框超出左上边界（负数）→ 收到 0
check("超出左上角",
  cropRectToSource({ x: -50, y: -30, w: 400, h: 300 }, { w: 800, h: 600 }, work),
  { sx: 0, sy: 0, sw: 800, sh: 600 });

// 5. 长宽比不同的缩放（不是整数倍）
check("非整数倍缩放",
  cropRectToSource({ x: 0, y: 0, w: 333, h: 250 }, { w: 333, h: 250 }, work),
  { sx: 0, sy: 0, sw: 1600, sh: 1200 });

// 6. 极小的框 → 至少 1 像素，不会变成 0
const tiny = cropRectToSource({ x: 10, y: 10, w: 1, h: 1 }, { w: 1600, h: 1200 }, work);
check("极小框不为 0", { w: tiny.sw > 0, h: tiny.sh > 0 }, { w: true, h: true });

console.log("\n通过 " + pass + " / 失败 " + fail);
process.exit(fail ? 1 : 0);
