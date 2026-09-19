/* 考公错题分类 · 浏览器版
 * 逻辑与 classifier.py 保持一致，词表由 tools/gen_classifier_data.py 导出。
 */

import { DATA } from "./classifier_data.js";

export const CATEGORIES = DATA.categories;
export const SUBTYPES = DATA.subtypes;
export const SOURCES = DATA.sources;
export const ERROR_TAGS = DATA.errorTags;
export const TIME_BUDGET = DATA.timeBudget;
const DEFAULT_CATEGORY = DATA.defaultCategory;

const CJK = /[\u4e00-\u9fff]/g;
const DIGITS = /\d/g;
const SEQ = /\d+\s*[，,、]\s*\d+\s*[，,、]\s*\d+/;
const BLANK = /[（(]\s*[)）]|\?|＿|_/;
const DEF_STYLE = /(属于|符合|不属于|不符合).{0,8}(上述|该)?定义/;
const ARG_STYLE = /最能(削弱|加强|支持|质疑|反驳|解释|说明)/;

const count = (text, sub) => {
  if (!sub) return 0;
  let n = 0, i = 0;
  for (;;) {
    const at = text.indexOf(sub, i);
    if (at < 0) return n;
    n += 1;
    i = at + sub.length;
  }
};

const len = (s) => [...s].length;

function scoreCategories(text) {
  const scores = {};
  for (const [cat, table] of Object.entries(DATA.categoryKeywords)) {
    let total = 0;
    for (const [word, weight] of table) {
      const n = count(text, word);
      if (n) total += Math.min(n, 2) * weight * Math.max(2, Math.floor(len(word) / 2));
    }
    if (total) scores[cat] = total;
  }
  return scores;
}

function hits(text, words) {
  let score = 0;
  for (const w of words) {
    const n = count(text, w);
    if (n) score += Math.min(n, 2) * len(w);
  }
  return score;
}

export function classify(text, options) {
  const stem = text || "";
  let blob = stem;
  if (options && Object.keys(options).length) {
    blob += " " + Object.values(options).join(" ");
  }

  const scores = scoreCategories(blob);
  const reasons = [];
  const digits = (blob.match(DIGITS) || []).length;
  const cjk = (blob.match(CJK) || []).length;

  const isSeq = SEQ.test(stem) && BLANK.test(stem);
  if (isSeq && cjk < 25) {
    scores["判断推理"] = (scores["判断推理"] || 0) + 120;
    reasons.push("数字序列");
  }
  if (digits >= 6 && cjk < 12 && !isSeq) {
    scores["数量关系"] = (scores["数量关系"] || 0) + 40;
  }
  if (DEF_STYLE.test(blob)) {
    scores["判断推理"] = (scores["判断推理"] || 0) + 120;
    reasons.push("定义判断问法");
  }
  if (ARG_STYLE.test(blob) || blob.includes("上述论证")) {
    scores["判断推理"] = (scores["判断推理"] || 0) + 130;
    reasons.push("论证问法");
  }
  if (/根据(以下|上述|所给)/.test(blob) && /(资料|材料|表|图)/.test(blob)) {
    scores["资料分析"] = (scores["资料分析"] || 0) + 100;
    reasons.push("资料分析提示语");
  }

  const letters = (blob.match(/[A-Za-z]/g) || []).length;
  if (letters >= 20 && letters > cjk) {
    for (const k of Object.keys(scores)) scores[k] = Math.floor(scores[k] * 0.3);
  }
  if (scores["常识"] !== undefined && Object.keys(scores).length > 1) {
    scores["常识"] = Math.floor(scores["常识"] * 0.8);
  }

  const entries = Object.entries(scores);
  if (!entries.length) {
    return {
      category: DEFAULT_CATEGORY, subtype: "", confidence: 0,
      scores: {}, reason: "没命中关键词，先归到常识，请手动确认",
    };
  }

  let category = entries[0][0];
  for (const [k, v] of entries) if (v > scores[category]) category = k;
  const top = scores[category];
  const ranked = Object.values(scores).sort((a, b) => b - a);
  const second = ranked.length > 1 ? ranked[1] : 0;

  const strength = Math.min(1, top / 60);
  const separation = top ? 1 - second / top : 0;
  let confidence = Math.min(0.97, Math.max(0.15, 0.3 + 0.45 * strength + 0.25 * separation));
  confidence = Math.round(confidence * 100) / 100;

  let subtype = "";
  let subScore = 0;
  for (const [name, words] of Object.entries(DATA.subtypeKeywords[category] || {})) {
    const s = hits(blob, words);
    if (s > subScore) { subtype = name; subScore = s; }
  }

  if (category === "判断推理" && isSeq && cjk < 25) subtype = "数字推理";
  else if (category === "判断推理" && ARG_STYLE.test(blob) && (subtype === "" || subtype === "定义判断")) {
    subtype = "论证推理";
  } else if (category === "判断推理" && DEF_STYLE.test(blob) && !subtype) subtype = "定义判断";

  if (top < 20) reasons.push("信号较弱");

  return { category, subtype, confidence, scores, reason: reasons.join("、") };
}

/** 识别出来的文字太少，基本可以判定是纯图片题 */
export function isImageOnly(text) {
  return (text || "").replace(/\s+/g, "").length < 12;
}
