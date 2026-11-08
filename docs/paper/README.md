# Papers

## Evidence audit and revision guides

The manuscripts currently mix historical cue/camera-labelled experiments and later model variants.
The November 7 audit separates these from the newer hand-labelled development model; **do not
replace old table values with new manifest percentages without matching cohort and protocol**.

- [Evidence audit: old versus hand-labelled data, source aliases and claim corrections](EVIDENCE_AUDIT.md)
- [Q2-target research plan: implemented capabilities, related work and proposed studies](Q2_RESEARCH_PLAN.md)
- Format-specific improvements and suggested manuscript text:
  [IEEE conference](ieee/IMPROVEMENTS.md), [Springer LNCS](springer/IMPROVEMENTS.md),
  [IEEE journal](ieee-journal/IMPROVEMENTS.md), [Springer Nature journal](springer-journal/IMPROVEMENTS.md)
- [Reproducible figures, inventory, provenance and verification](revision-assets/README.md)
- [Journal companion: every claim, term, number, equation, table and figure of the journal version explained](JOURNAL_COMPANION.md)

These additions are documentation and proposed revisions, not a completed new study, a rewritten
manuscript or a guarantee of journal quartile/acceptance. The shared audit assets are outside the
self-contained LaTeX folders: copy selected figures into a paper folder before standalone upload.

## New evidence-qualified Codex manuscript

The new [IEEE Codex](ieee%20codex/README.md) and [Springer Codex](springer%20codex/README.md)
folders contain a complete rewritten paper using the audit: current hand-labelled development evidence,
separately identified historical results, corrected causal methods and explicitly proposed future studies.
The scientific body is identical across the two formats. Both compile locally; PDFs remain local rather
than being committed. Full Markdown, embedded figures, downloadable Markdown and both PDFs are saved
in Joplin's **Conference Papers** notebook as **Failure-Aware Spatial Interaction — Codex manuscript
(IEEE + Springer)**. The note and all seven resources were read back after successful server sync.
See [generation, provenance and checks](codex-tools/README.md).

The four original variants below are preserved alongside the two new Codex journal formats.

| Folder | Format | Pages |
| --- | --- | --- |
| `ieee/` | IEEE conference (`IEEEtran` conference mode) | 6 |
| `springer/` | Springer LNCS conference proceedings (`llncs`, `splncs04`) | 11 |
| `ieee-journal/` | IEEE journal / Transactions (`IEEEtran` journal mode, biography, statements) | 8 |
| `springer-journal/` | Springer Nature journal (`sn-jnl`, December 2024 template, Declarations) | 17 |
| `ieee codex/` | New evidence-qualified IEEE journal manuscript | 8 |
| `springer codex/` | New evidence-qualified Springer Nature journal manuscript | 15 |

The original two conference versions share one `body.tex`; the original two journal versions share a longer `body.tex` with research
questions, a dataset section, the full results (including the robustness screen and further variations), a discussion
with threats to validity, and future work. Keep each pair's `body.tex` identical when editing.

Each original folder is self-contained and uploads as-is to Overleaf: `main.tex` (class, title, abstract, back matter),
`body.tex`, `refs.bib` and `architecture.png`. `springer-journal/` also holds `sn-jnl.cls` and `sn-mathphys-num.bst`
from Springer Nature's official template package; change the `sn-mathphys-num` option in `main.tex` if the target
journal asks for another reference style.

Build locally with `latexmk -pdf main.tex`. With BasicTeX, first install the classes, fonts and the packages
`sn-jnl` needs:

```bash
tlmgr --usermode install ieeetran llncs courier times helvetic sttools ncctools multirow appendix algorithms algorithmicx jknapltx rsfs lineno fix2col environ trimspaces etoolbox xstring natbib caption float wrapfig enumitem textcase threeparttable
```

Before submitting:

- Fill in every `[bracketed]` placeholder: affiliation, journal name and dates, biography, data and code
  availability, ethics, funding and competing interests.
- Check every `refs.bib` entry with a `% VERIFY` comment above it, complete the `[... to be completed]` titles and
  authors, and complete the "et al." author lists from each DOI record.
- Follow the target journal's own Instructions for Authors: page limits, reference style and required sections vary.
