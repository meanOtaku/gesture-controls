# Papers

Two versions of the Spatial Gesture Control paper, built from the same text.

| Folder | Format | Pages |
| --- | --- | --- |
| `ieee/` | IEEE conference (`IEEEtran`, two columns, `IEEEtran` references) | 6 |
| `springer/` | Springer LNCS (`llncs`, `splncs04` references) | 11 |

Each folder is self-contained and uploads as-is to Overleaf: `main.tex` (class, title, abstract),
`body.tex` (the paper text, identical in both), `refs.bib` and `architecture.png`.
Edit `body.tex` in one folder and copy it to the other to keep them in step.

Build locally with `latexmk -pdf main.tex`. With BasicTeX, first run
`tlmgr --usermode install ieeetran llncs courier times helvetic`.

Before submitting:

- Fill in the affiliation (`[Department, Institution]`, `[City, Country]`) in each `main.tex`.
- Check every `refs.bib` entry with a `% VERIFY` comment above it, and complete the "et al."
  author lists from each DOI record.
- Check the venue's page limit and current template version.
