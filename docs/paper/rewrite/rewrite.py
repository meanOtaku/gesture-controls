#!/usr/bin/env python3
"""Rewrite the paper and report by hand, paragraph by paragraph, without touching LaTeX.

    python3 docs/paper/rewrite/rewrite.py make     # (re)build the Markdown rewrite documents from the .tex sources
    python3 docs/paper/rewrite/rewrite.py check    # say which blocks have a rewrite, and any problem, without writing
    python3 docs/paper/rewrite/rewrite.py apply    # write the rewrites back into the .tex sources

`make` splits every source file of the manuscript (abstract, the shared sections, the report's own chapters) into blocks:
paragraphs and list items you can rewrite, figure and table captions you can rewrite, and everything else (headings,
equations, tables, figures, LaTeX set-up) kept as it is and shown only as a placeholder. Each source file becomes one
Markdown document in this folder; the original LaTeX of every block is kept in `.state/`, so `apply` knows exactly what
to replace and refuses to write if a source file changed after `make`.

`make` never overwrites a document that already holds rewrites (use `make --force` to start over). Only standard
library Python is needed.
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANUSCRIPT = HERE.parent / "manuscript"
STATE = HERE / ".state"

# The files people read, in reading order. The report's own chapters sit beside the shared sections.
SOURCES = [
    "abstract.tex",
    "sections/01-introduction.tex",
    "report/intro-extra.tex",
    "sections/02-related-work.tex",
    "report/requirements.tex",
    "sections/03-system-design.tex",
    "report/implementation.tex",
    "sections/04-annotation-audit.tex",
    "sections/05-detection-method.tex",
    "sections/06-results.tex",
    "report/testing.tex",
    "sections/07-discussion.tex",
    "sections/08-prospective-protocol.tex",
    "sections/09-limitations.tex",
    "sections/10-conclusion.tex",
    "sections/11-declarations.tex",
    "report/front-matter.tex",
]

# Environments kept whole (their captions can still be rewritten), lists split into items, and display maths.
KEPT_ENVS = {"figure", "figure*", "table", "table*", "widefigure", "pagewidefigure", "titlepage", "tabular", "tabularx",
             "minipage", "center", "equation", "equation*", "align", "align*"}
LIST_ENVS = {"itemize", "enumerate", "description"}
# Commands a paragraph may start with and still be prose.
INLINE_START = ("\\textbf", "\\emph", "\\textit", "\\texttt", "\\noindent", "\\cite", "\\nolinkurl", "\\ref", "\\todo")

MARK_START = "<!-- block {id} -->"
MARK_REWRITE = "✏️ **Your rewrite** (write below this line; leave empty to keep the current text):"
MARK_END = "<!-- end {id} -->"
BLOCK_RE = re.compile(r"<!-- block (?P<id>[^ ]+) -->(?P<body>.*?)<!-- end (?P=id) -->", re.S)


@dataclass
class Segment:
    """A run of the source file. `kind` is prose, item, caption-holder (an env with captions) or kept."""
    kind: str
    latex: str
    variant: str = "both"          # both, report (\\iffull) or paper (\\else)
    id: str = ""
    captions: list[str] = field(default_factory=list)   # ids of the caption slots, for an env
    item_label: str = ""           # for a list item: its \\item[...] label, kept as it is


# ----------------------------------------------------------------------------------------------- splitting the source

def env_name(line: str, kind: str) -> str | None:
    m = re.match(r"\s*\\" + kind + r"\{([^}]+)\}", line)
    return m.group(1) if m else None


def is_prose(line: str) -> bool:
    s = line.lstrip()
    if not s:
        return False
    if s[0].isalnum() or s[0] in "($`\"'([":
        return True
    return s.startswith(INLINE_START)


def split(text: str, stem: str) -> list[Segment]:
    lines = text.split("\n")
    segs: list[Segment] = []
    variant = "both"
    i = 0
    counter = {"p": 0}

    def next_id(prefix: str) -> str:
        counter["p"] += 1
        return f"{stem}/{prefix}{counter['p']:03d}"

    def kept(chunk: list[str]):
        segs.append(Segment("kept", "\n".join(chunk), variant))

    while i < len(lines):
        line = lines[i]
        s = line.strip()
        if s in ("\\iffull", "\\else", "\\fi"):
            variant = {"\\iffull": "report", "\\else": "paper", "\\fi": "both"}[s]
            kept([line]); i += 1; continue
        name = env_name(line, "begin")
        if name in LIST_ENVS:
            # Each \item becomes its own block; the begin/end lines are kept.
            kept([line]); i += 1
            depth = 1
            item: list[str] = []
            def flush_item():
                if item:
                    m = re.match(r"(\s*\\item(?:\[[^\]]*\])?\s*)(.*)", item[0], re.S)
                    head, first = m.group(1), m.group(2)
                    body = "\n".join([first] + item[1:])
                    segs.append(Segment("kept", head, variant))
                    segs.append(Segment("item", body, variant, id=next_id("i"), item_label=head.strip()))
                    item.clear()
            while i < len(lines):
                l2 = lines[i]
                if env_name(l2, "begin") in LIST_ENVS:
                    depth += 1
                if env_name(l2, "end") in LIST_ENVS:
                    depth -= 1
                    if depth == 0:
                        flush_item()
                        # Items are joined to the next kept piece by a newline when rebuilt.
                        kept([l2]); i += 1; break
                if depth == 1 and re.match(r"\s*\\item\b", l2):
                    flush_item()
                    item.append(l2)
                elif item:
                    item.append(l2)
                else:
                    kept([l2])
                i += 1
            continue
        if name and name in KEPT_ENVS:
            chunk = [line]; depth = 1; i += 1
            while i < len(lines) and depth:
                chunk.append(lines[i])
                if env_name(lines[i], "begin") == name:
                    depth += 1
                if env_name(lines[i], "end") == name:
                    depth -= 1
                i += 1
            seg = Segment("kept", "\n".join(chunk), variant)
            if captions_in(seg.latex):
                seg.kind = "env"
                seg.captions = [next_id("c") for _ in captions_in(seg.latex)]
            segs.append(seg)
            continue
        if s == "\\[":
            chunk = [line]; i += 1
            while i < len(lines):
                chunk.append(lines[i]); i += 1
                if lines[i - 1].strip() == "\\]":
                    break
            kept(chunk); continue
        m = re.match(r"(\s*\\paragraph\*?\{[^}]*\}\s*)(\S.*)", line)
        if m:
            # A titled paragraph: the title stays, the text after it is a block, joined straight onto the title.
            segs.append(Segment("kept", m.group(1), variant))
            chunk = [m.group(2)]; i += 1
            while i < len(lines) and is_prose(lines[i]) and lines[i].strip() not in ("\\iffull", "\\else", "\\fi"):
                chunk.append(lines[i]); i += 1
            segs.append(Segment("item", "\n".join(chunk), variant, id=next_id("p"), item_label=m.group(1).strip()))
            continue
        if is_prose(line):
            chunk = []
            while i < len(lines) and is_prose(lines[i]) and lines[i].strip() not in ("\\iffull", "\\else", "\\fi"):
                chunk.append(lines[i]); i += 1
            segs.append(Segment("prose", "\n".join(chunk), variant, id=next_id("p")))
            continue
        kept([line]); i += 1
    return segs


def rebuild(segs: list[Segment], replace: dict[str, str]) -> str:
    """The source file again, with the given block ids replaced by new LaTeX. Pieces are joined by newlines, except a
    list item's text, which follows its \\item directly (the \\item piece keeps the space after it)."""
    text = ""
    for n, seg in enumerate(segs):
        latex = replace.get(seg.id, seg.latex) if seg.id else seg.latex
        if seg.kind == "env":
            for cid, (start, end) in reversed(list(zip(seg.captions, captions_in(seg.latex)))):
                if cid in replace:
                    latex = latex[:start] + replace[cid] + latex[end:]
        if n == 0:
            text = latex
        elif seg.kind == "item":
            text += latex
        else:
            text += "\n" + latex
    return text


def captions_in(latex: str) -> list[tuple[int, int]]:
    """Where the text of each \\caption{...} is (start and end of what is between the braces)."""
    spans = []
    for m in re.finditer(r"\\caption(?:\[[^\]]*\])?\{", latex):
        depth, j = 1, m.end()
        while j < len(latex) and depth:
            depth += {"{": 1, "}": -1}.get(latex[j], 0)
            j += 1
        spans.append((m.end(), j - 1))
    return spans


# ---------------------------------------------------------------------------------------- LaTeX <-> readable text

def braced(text: str, start: int) -> tuple[str, int]:
    """The contents of the {...} starting at `start` (which is '{'), and the index after the closing brace."""
    depth, j = 1, start + 1
    while j < len(text) and depth:
        depth += {"{": 1, "}": -1}.get(text[j], 0)
        j += 1
    return text[start + 1:j - 1], j


def to_readable(latex: str) -> str:
    out, i = [], 0
    simple = {"\\textbf": ("**", "**"), "\\emph": ("*", "*"), "\\textit": ("*", "*"), "\\texttt": ("`", "`")}
    while i < len(latex):
        c = latex[i]
        if c == "$":                                    # inline maths stays exactly as written
            j = latex.index("$", i + 1) + 1
            out.append(latex[i:j]); i = j; continue
        if c == "\\":
            m = re.match(r"\\([a-zA-Z]+|.)", latex[i:])
            cmd = "\\" + m.group(1); j = i + len(m.group(0))
            if cmd in ("\\%", "\\&", "\\_", "\\#", "\\$"):
                out.append(cmd[1]); i = j; continue
            if cmd == "\\ ":
                out.append(" "); i = j; continue
            if cmd in ("\\cite", "\\ref", "\\label", "\\nolinkurl", "\\url", "\\eqref") and j < len(latex) and latex[j] == "{":
                arg, k = braced(latex, j)
                tag = {"\\cite": "cite", "\\ref": "ref", "\\label": "label", "\\nolinkurl": "url", "\\url": "url", "\\eqref": "eqref"}[cmd]
                if out and out[-1].endswith("~"):
                    out[-1] = out[-1][:-1] + " "
                out.append(f"[{tag}:{arg}]"); i = k; continue
            if cmd in simple and j < len(latex) and latex[j] == "{":
                arg, k = braced(latex, j)
                a, b = simple[cmd]
                out.append(a + to_readable(arg) + b); i = k; continue
            out.append(latex[i:j]); i = j; continue     # any other command stays as it is
        if latex.startswith("---", i):
            out.append("—"); i += 3; continue
        if latex.startswith("--", i):
            out.append("–"); i += 2; continue
        if latex.startswith("``", i):
            out.append("“"); i += 2; continue
        if latex.startswith("''", i):
            out.append("”"); i += 2; continue
        if c == "~":
            out.append(" "); i += 1; continue
        out.append(c); i += 1
    return "".join(out)


def to_latex(text: str) -> str:
    """Your readable text back into LaTeX: the reverse of to_readable."""
    text = text.strip()
    out, i = [], 0
    while i < len(text):
        c = text[i]
        if c == "$":
            j = text.find("$", i + 1)
            if j < 0:
                raise ValueError("a $ for maths is not closed")
            out.append(text[i:j + 1]); i = j + 1; continue
        m = re.match(r"\[(cite|ref|label|url|eqref):([^\]]+)\]", text[i:])
        if m:
            tag, arg = m.groups()
            cmd = {"cite": "\\cite", "ref": "\\ref", "label": "\\label", "url": "\\nolinkurl", "eqref": "\\eqref"}[tag]
            if tag in ("cite", "ref", "eqref") and out and out[-1].endswith(" "):
                out[-1] = out[-1][:-1] + "~"            # a citation or reference never starts a line
            out.append(f"{cmd}{{{arg}}}"); i += len(m.group(0)); continue
        if text.startswith("**", i):
            j = text.find("**", i + 2)
            if j < 0:
                raise ValueError("a ** for bold is not closed")
            out.append("\\textbf{" + to_latex(text[i + 2:j]) + "}"); i = j + 2; continue
        if c == "*" :
            j = text.find("*", i + 1)
            if j < 0:
                raise ValueError("a * for italics is not closed")
            out.append("\\emph{" + to_latex(text[i + 1:j]) + "}"); i = j + 1; continue
        if c == "`":
            j = text.find("`", i + 1)
            if j < 0:
                raise ValueError("a ` for code is not closed")
            out.append("\\texttt{" + text[i + 1:j].replace("_", "\\_").replace("%", "\\%") + "}"); i = j + 1; continue
        if c == "\\":
            m = re.match(r"\\([a-zA-Z]+|.)", text[i:])
            out.append(m.group(0)); i += len(m.group(0)); continue
        out.append({"%": "\\%", "&": "\\&", "_": "\\_", "#": "\\#", "—": "---", "–": "--", "“": "``", "”": "''",
                    "‘": "`", "’": "'", "…": "\\ldots{}", "\"": "''" if out and not out[-1].endswith((" ", "(")) else "``"}.get(c, c))
        i += 1
    return re.sub(r"[ \t]*\n[ \t]*", "\n", "".join(out))


# ------------------------------------------------------------------------------------------------ the documents

def variant_note(v: str) -> str:
    return {"report": " · **report version** (long)", "paper": " · **papers version** (short)", "both": ""}[v]


def quote(text: str) -> str:
    return "\n".join("> " + l if l.strip() else ">" for l in text.split("\n"))


def placeholder(latex: str) -> str:
    s = latex.strip()
    if not s:
        return ""
    m = re.match(r"\\(sect|subsect|section|chapter|subsection|subsubsection)\*?\{([^}]*)\}", s)
    if m:
        level = {"sect": "##", "chapter": "##", "section": "##", "subsect": "###", "subsection": "###"}.get(m.group(1), "####")
        return f"{level} {m.group(2)}"
    if s.startswith("\\["):
        return "📐 *[equation, kept as it is]*\n```latex\n" + s + "\n```"
    name = env_name(s, "begin")
    if name:
        label = re.search(r"\\label\{([^}]+)\}", s)
        what = "figure" if "figure" in name else "table" if name in ("table", "table*", "tabular", "tabularx") else name
        return f"🖼️ *[{what}{' ' + label.group(1) if label else ''}, kept as it is]*"
    if s in ("\\iffull", "\\else", "\\fi") or s.startswith("%") or s.startswith("\\end{"):
        return ""
    return ""


def block(id_: str, title: str, current: str) -> str:
    return "\n".join([MARK_START.format(id=id_), f"#### {title}", "", "**Current:**", "", quote(current), "",
                      MARK_REWRITE, "", "", MARK_END.format(id=id_), ""])


def make_document(src: str, segs: list[Segment]) -> str:
    stem = Path(src).stem
    parts = [f"# Rewrite: `{src}`", "",
             f"Rewrite any block below in your own words. See [the guide](README.md) for the few things to keep "
             f"(citations, references, maths). Blocks left empty keep their current text.", ""]
    for seg in segs:
        if seg.kind == "prose":
            parts.append(block(seg.id, f"¶ {seg.id.split('/')[-1]}{variant_note(seg.variant)}", to_readable(seg.latex)))
        elif seg.kind == "item":
            label = re.match(r"\\(item|paragraph)\*?[\[{]([^\]}]*)[\]}]", seg.item_label)
            kind = "¶" if seg.item_label.startswith("\\paragraph") else "• list item"
            parts.append(block(seg.id, f"{kind} {seg.id.split('/')[-1]}{' — ' + label.group(2) if label else ''}"
                                       f"{variant_note(seg.variant)}", to_readable(seg.latex)))
        elif seg.kind == "env":
            parts.append(placeholder(seg.latex))
            parts.append("")
            for cid, (a, b) in zip(seg.captions, captions_in(seg.latex)):
                parts.append(block(cid, f"🏷️ caption {cid.split('/')[-1]}{variant_note(seg.variant)}",
                                   to_readable(seg.latex[a:b])))
        else:
            p = placeholder(seg.latex)
            if p:
                parts.extend([p, ""])
    return re.sub(r"\n{3,}", "\n\n", "\n".join(parts)).rstrip() + "\n"


def doc_path(src: str) -> Path:
    return HERE / (src.replace("/", "--").replace(".tex", ".md"))


def read_rewrites(doc: Path) -> dict[str, str]:
    found = {}
    for m in BLOCK_RE.finditer(doc.read_text()):
        body = m.group("body")
        if MARK_REWRITE not in body:
            raise ValueError(f"{doc.name}: block {m.group('id')} lost its '{MARK_REWRITE[:20]}…' line")
        text = body.split(MARK_REWRITE, 1)[1].strip()
        if text:
            found[m.group("id")] = text
    return found


def cmd_make(force: bool) -> None:
    STATE.mkdir(exist_ok=True)
    for src in SOURCES:
        tex = (MANUSCRIPT / src).read_text()
        stem = Path(src).stem
        segs = split(tex, stem)
        if rebuild(segs, {}) != tex:
            sys.exit(f"{src}: splitting it does not give the file back; nothing written")
        doc = doc_path(src)
        if doc.exists() and read_rewrites(doc) and not force:
            print(f"kept   {doc.name} (it holds rewrites; use --force to start it over)")
            continue
        doc.write_text(make_document(src, segs))
        (STATE / (doc.stem + ".json")).write_text(json.dumps(
            {"source": src, "tex": tex, "segments": [asdict(s) for s in segs]}, ensure_ascii=False, indent=1))
        blocks = sum(1 for s in segs if s.kind in ("prose", "item")) + sum(len(s.captions) for s in segs)
        print(f"wrote  {doc.name}: {blocks} blocks")


def plan() -> list[tuple[str, Path, dict, dict[str, str]]]:
    jobs = []
    for src in SOURCES:
        doc = doc_path(src)
        state_file = STATE / (doc.stem + ".json")
        if not doc.exists() or not state_file.exists():
            continue
        jobs.append((src, doc, json.loads(state_file.read_text()), read_rewrites(doc)))
    return jobs


def cmd_apply(write: bool) -> None:
    problems, total = [], 0
    for src, doc, state, rewrites in plan():
        if not rewrites:
            continue
        current = (MANUSCRIPT / src).read_text()
        if current != state["tex"]:
            problems.append(f"{src} changed since `make`; its {len(rewrites)} rewrite(s) were not applied")
            continue
        segs = [Segment(**s) for s in state["segments"]]
        known = {s.id for s in segs if s.id} | {c for s in segs for c in s.captions}
        replace = {}
        for id_, text in rewrites.items():
            if id_ not in known:
                problems.append(f"{doc.name}: unknown block {id_}")
                continue
            try:
                replace[id_] = to_latex(text)
            except ValueError as error:
                problems.append(f"{doc.name}: block {id_}: {error}")
        total += len(replace)
        print(f"{'apply ' if write else 'ready '} {src}: {len(replace)} rewritten block(s)")
        if write and replace:
            (MANUSCRIPT / src).write_text(rebuild(segs, replace))
    for p in problems:
        print("PROBLEM", p)
    if write and total:
        print(f"{total} block(s) written. Run `make` again before the next round, so the documents show the new text.")
    if problems:
        sys.exit(1)


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action == "make":
        cmd_make("--force" in sys.argv)
    elif action == "check":
        cmd_apply(write=False)
    elif action == "apply":
        cmd_apply(write=True)
    else:
        sys.exit(__doc__)
