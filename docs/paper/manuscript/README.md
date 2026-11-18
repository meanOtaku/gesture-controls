# Manuscript (single source for the paper and the report)

This folder is the **one place to edit** the paper and the project report. Earlier
variants are frozen in [`../archive/`](../archive/) for reference only.

| Build file | Output | Notes |
| --- | --- | --- |
| `paper-ieee.tex` | IEEE conference paper (`IEEEtran`, conference mode) | Latest verified build: 6 pages including references; confirm the target venue's limit |
| `paper-lncs.tex` | Springer LNCS conference paper (`llncs`, `splncs04`) | Latest verified build: 16 pages including references; confirm the target venue's limit |
| `report.tex` | Project report (`report` class, 12 pt, 1.5 spacing) | Latest verified build: 65 physical PDF pages including front matter and appendices |

Build any of them with `latexmk -pdf <file>.tex`. PDFs and TeX temporaries are git-ignored.
The LNCS paper and the report use `placeins` (`tlmgr install placeins`); without it they fall back to
`floatbarrier-fallback.tex`, which behaves the same for these documents.
For Overleaf, upload this whole folder and choose the main document in the menu.

## Layout

```
abstract.tex            shared abstract
preamble-common.tex     shared packages, \todo, title/author macros
sections/NN-*.tex       shared paper sections (the scientific content)
sections/00-all.tex     paper section order
report/*.tex            report-only chapters (front matter, requirements, implementation, testing, appendices)
figures/                figures used by all builds
refs.bib                one bibliography (entries with % VERIFY still need checking)
```

## Conventions

- In `sections/`, write headings with `\sect{...}` and `\subsect{...}`, never `\section`.
  The papers map them to `\section`/`\subsection`; the report maps them to `\chapter`/`\section`.
- Use the `widefigure` environment for figures in shared files: two-column-wide in IEEE,
  a normal figure elsewhere.
- Papers print the short conference text; the report prints everything. In `sections/`, wrap
  report-only detail as `\iffull … \fi`, or give both versions as `\iffull <long> \else <short> \fi`
  (each keyword on its own line). Edit the long branch for the report, the short one for the papers.
- Wrap a figure that the LNCS paper and the report carry but the 6-page IEEE paper leaves out as
  `\ifmorefigures … \fi`. `paper-lncs.tex` and `report.tex` set `\morefigurestrue`.
- Mark unwritten text with `\todo{...}` (red in the PDF). Search for `\todo` before submitting.
- Edit a shared section once; both papers and the report pick it up. Paper-only or
  report-only material goes in the wrapper or in `report/`, not in `sections/`.

## Origin

The sections were split verbatim from the evidence-qualified rewrite of 8 Nov 2026 (its folders
and Markdown → LaTeX tools were removed on 15 Nov 2026; they remain in git history). The
bibliography merges its verified entries with the older `archive/ieee/refs.bib`. The `.tex`
files here are the source of truth.
