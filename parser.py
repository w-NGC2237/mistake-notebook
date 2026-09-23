"""把 OCR 出来的大段文字切成一道道题目，并抽出选项 / 答案 / 解析。

考公题目的现实情况：
  * 选项经常被 OCR 挤成一行（``A.25天B.30天C.28天D.32天``），必须能切开；
  * ``【答案】`` 常和选项挤在同一行，不能把整行吞掉；
  * 数学题干里会出现 ``设A、B两点``，不能误判成 A、B 两个选项。
"""
from __future__ import annotations

import re

# 题干起点：1. / 1、/ 1） / (1) / （1） / 一、
_NUM_START = re.compile(
    r"^\s*(?:"
    r"(?P<arabic>\d{1,3})\s*[.、．)）]\s*"
    r"|[(（]\s*(?P<paren>\d{1,3})\s*[)）]\s*"
    r"|(?P<cn>[一二三四五六七八九十]{1,3})\s*[、.．]\s*"
    r")"
)

# 一个选项：A. / A、 / A） / (A) / A：
_OPTION = re.compile(
    r"^\s*[(（]?\s*(?P<key>[A-Ha-h])\s*[.、．)）:：]\s*(?P<val>.+)$"
)
# 兜底规则：笔迹把分隔符盖住时，"A 25天" 这种也要能认出来。
# 只在"一行里能连出 A、B、C、D"时才启用，避免把题干里的字母误判成选项。
_OPTION_ANY = re.compile(
    r"^\s*[(（]?\s*(?P<key>[A-Ha-h])\s*[.、．)）:：]?\s+(?P<val>.+)$"
)

# 严格切分：顿号、空位等常规分隔
_OPT_STRICT = re.compile(
    r"(?:(?<=^)|(?<=[\s，,；;、。：:）)】\]\}\>]))(?=[A-Ha-h]\s*[.、．)）]\s*)"
)
# 宽松切分：OCR 把空格吃掉时用（只认句点/括号型，避免"设A、B两点"被误切）
_OPT_LOOSE = re.compile(r"(?=[A-Ha-h]\s*[.．)）]\s*)")

# 【答案】 / [答案] / 行首"答案：" / 行首"正确答案"
_ANSWER = re.compile(
    r"(?:[【\[]\s*答\s*案\s*[】\]]|^\s*答\s*案|^\s*正确答案)\s*[:：]?\s*(?P<val>.*)$"
)
# 【解析】 / 【解答】 / 行首"解析"
_ANALYSIS = re.compile(
    r"(?:[【\[]\s*解\s*[析答]\s*[】\]]|^\s*解\s*析)\s*[:：]?\s*(?P<val>.*)$"
)

_BLANK = re.compile(r"_{2,}|[（(]\s{1,}[)）]|[（(]\s*[)）]")
_JUDGE = re.compile(r"判断|对错|正确与否")
_FIGURE = re.compile(r"如图|下图|图中|图形|图1|图2")

SUBJECT_OPTIONS = ["语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理", "政治", "其他"]


def _split_blocks(text: str) -> list[str]:
    blocks: list[str] = []
    current: list[str] = []
    started = False
    for line in [ln.rstrip() for ln in text.splitlines()]:
        if not line.strip():
            if current:
                current.append("")
            continue
        if _NUM_START.match(line):
            if started and current:
                blocks.append("\n".join(current).strip())
            current = [line]
            started = True
        else:
            current.append(line)
    if current:
        blocks.append("\n".join(current).strip())
    return [b for b in blocks if b]


def _strip_number(block: str) -> tuple[str, str | None]:
    first, _, rest = block.partition("\n")
    m = _NUM_START.match(first)
    if not m:
        return block, None
    number = m.group("arabic") or m.group("paren") or m.group("cn")
    return (first[m.end():].strip() + ("\n" + rest if rest else "")).strip(), number


def _cut(line: str, pattern: re.Pattern) -> tuple[str, str | None]:
    """把 【答案】xxx 这类片段从行里抠掉，返回 (剩下的内容, 抠出来的值)。"""
    m = pattern.search(line)
    if not m:
        return line, None
    val = (m.group("val") or "").strip()
    rest = (line[: m.start()] + " " + line[m.end():]).strip()
    return rest, (val or None)


def _match_option(seg: str, permissive: bool = False):
    m = _OPTION.match(seg)
    if m:
        return m
    return _OPTION_ANY.match(seg) if permissive else None


def _validate(line: str, pattern: re.Pattern, permissive: bool = False) -> list[str] | None:
    """按某个分隔规则切开，并判断切出来的确实像一组选项。"""
    segs = [s.strip() for s in pattern.split(line) if s.strip()]
    if not segs:
        return None
    keys: list[str | None] = []
    for seg in segs:
        m = _match_option(seg, permissive)
        keys.append(m.group("key").upper() if m else None)
    first = next((i for i, k in enumerate(keys) if k), None)
    if first is None:
        return None
    matched = [k for k in keys[first:] if k]
    # 连着 A、B、C、D…… 才是真选项。
    # 选项可以从 C 开始（上一行已经出现了 A、B），所以额外允许"从行首开始"的情况。
    if (
        len(matched) >= 2
        and len(set(matched)) == len(matched)
        and len(matched) == len(keys) - first
        and _consecutive(matched)
        and (matched[0] == "A" or first == 0)
    ):
        return segs
    # 整行只有一个选项，且就在行首。兜底规则不参与单选项判断，
    # 否则 "A 点处的电场强度" 这类题干会被误认成选项。
    if not permissive and len(matched) == 1 and first == 0 and len(keys) == 1:
        return segs
    return None


def _split_options(line: str) -> list[str] | None:
    """把一行切成若干选项片段；判断不出是选项就返回 None。

    依次尝试：严格分隔 → 宽松分隔（OCR 吃掉空格）→ 兜底（笔迹盖住分隔符）。
    这样 "A.25天B.30天" 能切开，"设A、B两点" 不会被误切，
    "A 25天  B.30天" 这种被笔迹破坏的也能救回来。
    """
    strict = _validate(line, _OPT_STRICT)
    if strict and len(strict) >= 2:
        return strict
    loose = _validate(line, _OPT_LOOSE)
    if loose and len(loose) >= 2:
        return loose
    anyopt = _validate(line, _OPT_LOOSE, permissive=True)
    if anyopt and len(anyopt) >= 2:
        return anyopt
    return strict or loose or anyopt


def _consecutive(keys: list[str]) -> bool:
    return all(ord(b) - ord(a) == 1 for a, b in zip(keys, keys[1:]))


def parse_block(block: str) -> dict:
    body, number = _strip_number(block)

    answer: str | None = None
    analysis: str | None = None
    stem_lines: list[str] = []
    options: dict[str, str] = {}
    current_opt: str | None = None
    figure = False

    def take_options(segments: list[str]) -> None:
        nonlocal current_opt
        for seg in segments:
            m = _match_option(seg, permissive=True)
            if m:
                current_opt = m.group("key").upper()
                options[current_opt] = m.group("val").strip()
            elif current_opt:
                options[current_opt] = (options[current_opt] + " " + seg.strip()).strip()
            elif seg.strip():
                stem_lines.append(seg.strip())

    for raw in body.splitlines():
        line = raw.strip()
        if not line:
            continue
        line, found_analysis = _cut(line, _ANALYSIS)
        if found_analysis:
            analysis = f"{analysis} {found_analysis}".strip() if analysis else found_analysis
        line, found_answer = _cut(line, _ANSWER)
        if found_answer:
            answer = f"{answer} {found_answer}".strip() if answer else found_answer
        line = line.strip()
        if not line:
            continue
        if _FIGURE.search(line):
            figure = True

        segments = _split_options(line)
        if segments is not None:
            take_options(segments)
        elif current_opt:
            options[current_opt] = (options[current_opt] + " " + line).strip()
        else:
            stem_lines.append(line)

    stem = "\n".join(stem_lines).strip()

    if options:
        qtype = "选择题"
    elif _JUDGE.search(stem) and len(stem) < 140:
        qtype = "判断题"
    elif _BLANK.search(stem):
        qtype = "填空题"
    elif figure and len(stem) < 90:
        qtype = "图片题"
    else:
        qtype = "选择题"

    return {
        "number": number,
        "stem": stem,
        "options": options,
        "answer": answer,
        "analysis": analysis,
        "type": qtype,
    }


def parse(text: str) -> list[dict]:
    """返回一组题目草稿。识别不出题号时，整段作为一道题。"""
    blocks = _split_blocks(text)
    if not blocks:
        return []
    if len(blocks) == 1 and not _NUM_START.match(blocks[0]):
        items = [parse_block(blocks[0])]
    else:
        items = [parse_block(b) for b in blocks]
    return [it for it in items if it["stem"] or it["options"]]


def render_text(item: dict) -> str:
    """把结构化题目还原成可编辑文本。"""
    parts = [item.get("stem", "")]
    for key in sorted(item.get("options") or {}):
        parts.append(f"{key}. {item['options'][key]}")
    if item.get("answer"):
        parts.append(f"【答案】{item['answer']}")
    if item.get("analysis"):
        parts.append(f"【解析】{item['analysis']}")
    return "\n".join(p for p in parts if p)
