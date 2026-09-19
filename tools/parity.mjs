/* 跑一遍 parity_cases.json，输出 JS 端结果，用来和 Python 端比对。
 * 用法： node tools/parity.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classify } from "../static/lib/classifier.js";
import { parse } from "../static/lib/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "parity_cases.json"), "utf8"));
const out = { classify: [], parse: [] };
for (const [text, options] of cases.classify) out.classify.push(classify(text, options));
for (const text of cases.parse) out.parse.push(parse(text));
console.log(JSON.stringify(out, null, 1));
