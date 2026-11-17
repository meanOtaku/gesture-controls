# Papers

**Edit the paper and the report in [`manuscript/`](manuscript/README.md).** It is the single source:
one set of section files builds the IEEE conference paper, the Springer LNCS paper and the
project report.

## Layout

| Folder | What it holds |
| --- | --- |
| [`manuscript/`](manuscript/README.md) | The source: section files, bibliography, figures, and the three build targets |
| [`notes/`](notes/) | Working notes behind the paper: the [paper improvement guide](notes/PAPER_IMPROVEMENT_GUIDE.md), the [evidence audit](notes/EVIDENCE_AUDIT.md), the [Q2 research plan](notes/Q2_RESEARCH_PLAN.md) and the [journal companion](notes/JOURNAL_COMPANION.md) |
| [`rewrite/`](rewrite/README.md) | Your own-words rewrite: one document per source file, applied back with `rewrite.py` |
| [`revision-assets/`](revision-assets/README.md) | Reproducible figures, data inventory, provenance and the `verify.py` check |
| [`archive/`](archive/) | The four earlier format variants, frozen for reference |

The evidence-qualified rewrite of 8 Nov 2026 (its IEEE and Springer folders and its Markdown → LaTeX tools) was
folded into `manuscript/` and removed on 15 Nov 2026; it remains in git history.

## Evidence audit

The manuscripts mix historical cue/camera-labelled experiments and later model variants. The November 7 audit
separates these from the newer hand-labelled development model; **do not replace old table values with new
manifest percentages without matching cohort and protocol**. See the [evidence audit](notes/EVIDENCE_AUDIT.md)
and the format-specific suggestions for the archived variants:
[IEEE conference](archive/ieee/IMPROVEMENTS.md), [Springer LNCS](archive/springer/IMPROVEMENTS.md),
[IEEE journal](archive/ieee-journal/IMPROVEMENTS.md), [Springer Nature journal](archive/springer-journal/IMPROVEMENTS.md).

These are documentation and proposed revisions, not a completed new study or a guarantee of journal
quartile/acceptance.

## The archived variants

| Folder (under `archive/`) | Format | Pages |
| --- | --- | --- |
| `ieee/` | IEEE conference (`IEEEtran` conference mode) | 6 |
| `springer/` | Springer LNCS conference proceedings (`llncs`, `splncs04`) | 11 |
| `ieee-journal/` | IEEE journal / Transactions (`IEEEtran` journal mode, biography, statements) | 8 |
| `springer-journal/` | Springer Nature journal (`sn-jnl`, December 2024 template, Declarations) | 17 |

The two conference versions share one `body.tex`; the two journal versions share a longer `body.tex`. Each folder
is self-contained and uploads as-is to Overleaf: `main.tex`, `body.tex`, `refs.bib` and `architecture.png`
(`springer-journal/` also holds Springer Nature's `sn-jnl.cls` and `sn-mathphys-num.bst`).

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
