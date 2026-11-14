# Manuscript (single source for the paper and the report)

This folder is the **one place to edit** the paper and the project report. Earlier
variants are frozen in [`../archive/`](../archive/) for reference only.

| Build file | Output | Notes |
| --- | --- | --- |
| `paper-ieee.tex` | IEEE conference paper (`IEEEtran`, conference mode) | About 4.7 pages incl. references; limit is usually 6 |
| `paper-lncs.tex` | Springer LNCS conference paper (`llncs`, `splncs04`) | 12 pages incl. references; LNCS limits are usually 12–16 |
| `report.tex` | Project report (`report` class, 12 pt, 1.5 spacing) | Shared sections become chapters; report-only chapters in `report/` |

Build any of them with `latexmk -pdf <file>.tex`. PDFs and TeX temporaries are git-ignored.
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
- Mark unwritten text with `\todo{...}` (red in the PDF). Search for `\todo` before submitting.
- Edit a shared section once; both papers and the report pick it up. Paper-only or
  report-only material goes in the wrapper or in `report/`, not in `sections/`.

## Origin

The sections were split verbatim from the evidence-qualified "Codex" manuscript
(`archive/ieee codex/body.tex`, 8 Nov 2026). The bibliography merges its verified entries
with the older `archive/ieee/refs.bib`. The Markdown → LaTeX pipeline in
`archive/codex-tools/` is retired: the `.tex` files here are now the source of truth.
