/* 在 Node 里跑 JS 版的图片预处理，和 Python 版逐像素比对。
 * 用法： node tools/parity_image.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eraseHandwriting, estimateSkewFromGray } from "../static/lib/imageproc.js";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(here, "..", ".testimg", "parity");
const read = (n) => readFileSync(join(tmp, n));

const meta = JSON.parse(readFileSync(join(tmp, "meta.json"), "utf8"));
const rgba = read("rgba.bin");
// 浏览器里的 ImageData 就是 RGBA 四通道
const imageData = { data: new Uint8ClampedArray(rgba), width: meta.w, height: meta.h };
const stat = eraseHandwriting(imageData, { ink: true, pencil: true });
writeFileSync(join(tmp, "js.bin"), Buffer.from(imageData.data.buffer));

const grayMeta = JSON.parse(readFileSync(join(tmp, "gray.json"), "utf8"));
const gray = new Uint8Array(read("gray.bin"));
const skew = estimateSkewFromGray(gray, grayMeta.w, grayMeta.h);
console.log(JSON.stringify({
  jsAngle: skew.angle,
  jsGain: skew.confidence,
  inkRemoved: stat.ink,
  pencilRemoved: stat.pencil,
  threshold: skew.threshold,
  points: skew.points,
}));
