# Rewriting the paper in your own words

Each document here is one source file of the manuscript, split into numbered blocks: every paragraph, list item and
figure or table caption. Figures, tables, equations and headings are shown only as placeholders and are not touched.

| Document | Source file | Appears in |
| --- | --- | --- |
| `abstract.md` | `manuscript/abstract.tex` | both papers and the report |
| `sections--*.md` | `manuscript/sections/*.tex` | both papers and the report |
| `report--*.md` | `manuscript/report/*.tex` | the report only |

## How to rewrite a block

Write your version under the **✏️ Your rewrite** line of the block, before its `<!-- end … -->` line. Leave it empty
to keep the current text. Don't edit the `<!-- block … -->` and `<!-- end … -->` lines or the "Current" quote: they
are how your text finds its place.

Many paragraphs come twice: the **report version (long)** and the **papers version (short)**. They are separate
blocks; rewrite one, the other, or both.

## What to keep in your text

| You see | Means | Keep it as |
| --- | --- | --- |
| `[cite:tsunoda]`, `[cite:a,b]` | a citation | the same token, where the citation should go |
| `[ref:fig:score-timeline]` | a cross-reference ("Fig. 3") | the same token |
| `[label:…]` | an anchor something else points to | the same token, anywhere in the block |
| `[url:manual_label]` | a file or field name in monospace | the same token |
| `$...$` | maths | exactly as it is |
| `**bold**`, `*italic*`, `` `code` `` | formatting | the same marks |

Write `%`, `&`, `_`, `#`, quotes and dashes (– —) normally: they are converted for LaTeX. Anything that still starts with
a backslash (`\todo{…}`) is a LaTeX command: keep it unless you mean to remove it.

## Handing it over

Save the documents and tell me which ones you rewrote. I then run:

```bash
python3 docs/paper/rewrite/rewrite.py check
```

```bash
python3 docs/paper/rewrite/rewrite.py apply
```

`check` lists the rewritten blocks and any problem (an unclosed `$` or `**`, a lost marker). `apply` writes them into the
`.tex` files, and refuses if a source file changed since the documents were made. Then I compile the papers and the
report, check that the numbers, citations and claims still match the evidence, and run `make` to refresh the documents
for the next round (documents that still hold rewrites are not overwritten).
