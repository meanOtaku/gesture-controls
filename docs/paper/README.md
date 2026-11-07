# Papers

Four versions of the Spatial Gesture Control paper: two conference and two journal formats.

| Folder | Format | Pages |
| --- | --- | --- |
| `ieee/` | IEEE conference (`IEEEtran` conference mode) | 6 |
| `springer/` | Springer LNCS conference proceedings (`llncs`, `splncs04`) | 11 |
| `ieee-journal/` | IEEE journal / Transactions (`IEEEtran` journal mode, biography, statements) | 8 |
| `springer-journal/` | Springer Nature journal (`sn-jnl`, December 2024 template, Declarations) | 17 |

The two conference versions share one `body.tex`; the two journal versions share a longer `body.tex` with research
questions, a dataset section, the full results (including the robustness screen and further variations), a discussion
with threats to validity, and future work. Keep each pair's `body.tex` identical when editing.

Each folder is self-contained and uploads as-is to Overleaf: `main.tex` (class, title, abstract, back matter),
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
