/* 拆题 · 浏览器版，逻辑与 parser.py 一致 */

// 题干起点：1. / 1、 / 1） / (1) / （1） / 一、
const NUM_START =
  /^\s*(?:(\d{1,3})\s*[.、．)）]\s*|[(（]\s*(\d{1,3})\s*[)）]\s*|([一二三四五六七八九十]{1,3})\s*[、.．]\s*)/;

// 一个选项：A. / A、 / A） / (A) / A：
const OPTION = /^\s*[(（]?\s*([A-Ha-h])\s*[.、．)）:：]\s*(.+)$/;
// 兜底规则：笔迹盖住分隔符时，"A 25天" 也要能认出来。
// 只在"一行里能连出 A、B、C、D"时启用，避免把题干里的字母误判成选项。
const OPTION_ANY = /^\s*[(（]?\s*([A-Ha-h])\s*[.、．)）:：]?\s+(.+)$/;

// 严格切分
const OPT_STRICT = /(?<=[\s，,；;、。：:）)】\]\}>])(?=[A-Ha-h]\s*[.、．)）]\s*)/;
// 宽松切分：OCR 把空格吃掉时用（只认句点/括号型，避免"设A、B两点"被误切）
const OPT_LOOSE = /(?=[A-Ha-h]\s*[.．)）]\s*)/;

const ANSWER = /(?:[【\[]\s*答\s*案\s*[】\]]|^\s*答\s*案|^\s*正确答案)\s*[:：]?\s*(.*)$/;
const ANALYSIS = /(?:[【\[]\s*解\s*[析答]\s*[】\]]|^\s*解\s*析)\s*[:：]?\s*(.*)$/;

const BLANK = /_{2,}|[（(]\s{1,}[)）]|[（(]\s*[)）]/;
const JUDGE = /判断|对错|正确与否/;
const FIGURE = /如图|下图|图中|图形|图1|图2/;

function splitBlocks(text) {
  const blocks = [];
  let current = [];
  let started = false;
  for (const line of String(text).split("\n").map((l) => l.replace(/\s+$/, ""))) {
    if (!line.trim()) {
      if (current.length) current.push("");
      continue;
    }
    if (NUM_START.test(line)) {
      if (started && current.length) blocks.push(current.join("\n").trim());
      current = [line];
      started = true;
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join("\n").trim());
  return blocks.filter(Boolean);
}

function stripNumber(block) {
  const idx = block.indexOf("\n");
  const first = idx < 0 ? block : block.slice(0, idx);
  const rest = idx < 0 ? "" : block.slice(idx + 1);
  const m = NUM_START.exec(first);
  if (!m || m.index !== 0) return [block, null];
  const number = m[1] || m[2] || m[3] || null;
  return [(first.slice(m[0].length).trim() + (rest ? "\n" + rest : "")).trim(), number];
}

function cut(line, pattern) {
  const m = pattern.exec(line);
  if (!m) return [line, null];
  const val = (m[1] || "").trim();
  const rest = (line.slice(0, m.index) + " " + line.slice(m.index + m[0].length)).trim();
  return [rest, val || null];
}

function consecutive(keys) {
  for (let i = 1; i < keys.length; i++) {
    if (keys[i].charCodeAt(0) - keys[i - 1].charCodeAt(0) !== 1) return false;
  }
  return true;
}

function matchOption(seg, permissive) {
  return OPTION.exec(seg) || (permissive ? OPTION_ANY.exec(seg) : null);
}

function validate(line, pattern, permissive = false) {
  const segs = line.split(pattern).map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return null;
  const keys = segs.map((seg) => {
    const m = matchOption(seg, permissive);
    return m ? m[1].toUpperCase() : null;
  });
  let first = -1;
  for (let i = 0; i < keys.length; i++) if (keys[i]) { first = i; break; }
  if (first < 0) return null;
  const matched = keys.slice(first).filter(Boolean);
  if (
    matched.length >= 2 &&
    new Set(matched).size === matched.length &&
    matched.length === keys.length - first &&
    consecutive(matched) &&
    (matched[0] === "A" || first === 0)
  ) return segs;
  // 兜底规则不参与单选项判断，否则 "A 点处的电场强度" 这类题干会被误认成选项
  if (!permissive && matched.length === 1 && first === 0 && keys.length === 1) return segs;
  return null;
}

/** 把一行切成若干选项片段；判断不出是选项就返回 null */
export function splitOptions(line) {
  const strict = validate(line, OPT_STRICT, false);
  if (strict && strict.length >= 2) return strict;
  const loose = validate(line, OPT_LOOSE, false);
  if (loose && loose.length >= 2) return loose;
  const anyopt = validate(line, OPT_LOOSE, true);
  if (anyopt && anyopt.length >= 2) return anyopt;
  return strict || loose || anyopt;
}

export function parseBlock(block) {
  const [body, number] = stripNumber(block);
  let answer = null;
  let analysis = null;
  const stemLines = [];
  const options = {};
  let currentOpt = null;
  let figure = false;

  const takeOptions = (segments) => {
    for (const seg of segments) {
      const m = matchOption(seg, true);
      if (m) {
        currentOpt = m[1].toUpperCase();
        options[currentOpt] = m[2].trim();
      } else if (currentOpt) {
        options[currentOpt] = (options[currentOpt] + " " + seg.trim()).trim();
      } else if (seg.trim()) {
        stemLines.push(seg.trim());
      }
    }
  };

  for (const raw of body.split("\n")) {
    let line = raw.trim();
    if (!line) continue;
    let found;
    [line, found] = cut(line, ANALYSIS);
    if (found) analysis = analysis ? `${analysis} ${found}`.trim() : found;
    [line, found] = cut(line, ANSWER);
    if (found) answer = answer ? `${answer} ${found}`.trim() : found;
    line = line.trim();
    if (!line) continue;
    if (FIGURE.test(line)) figure = true;

    const segs = splitOptions(line);
    if (segs) takeOptions(segs);
    else if (currentOpt) options[currentOpt] = `${options[currentOpt]} ${line}`.trim();
    else stemLines.push(line);
  }

  const stem = stemLines.join("\n").trim();
  let qtype;
  if (Object.keys(options).length) qtype = "选择题";
  else if (JUDGE.test(stem) && stem.length < 140) qtype = "判断题";
  else if (BLANK.test(stem)) qtype = "填空题";
  else if (figure && stem.length < 90) qtype = "图片题";
  else qtype = "选择题";

  return { number, stem, options, answer, analysis, type: qtype };
}

export function parse(text) {
  const blocks = splitBlocks(text);
  if (!blocks.length) return [];
  const items =
    blocks.length === 1 && !NUM_START.test(blocks[0])
      ? [parseBlock(blocks[0])]
      : blocks.map(parseBlock);
  return items.filter((it) => it.stem || Object.keys(it.options).length);
}

export function renderText(item) {
  const parts = [item.stem || ""];
  for (const k of Object.keys(item.options || {}).sort()) {
    parts.push(`${k}. ${item.options[k]}`);
  }
  if (item.answer) parts.push(`【答案】${item.answer}`);
  if (item.analysis) parts.push(`【解析】${item.analysis}`);
  return parts.filter(Boolean).join("\n");
}
