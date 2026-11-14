# Codex manuscript: Springer Nature journal format

New manuscript, 8 November 2026:

**Failure-Aware Spatial Interaction with Consumer Wearables: A Source-Audited Study of Head Targeting and Smartwatch Pinch Detection**

This is the Springer Nature layout of the same evidence-qualified working paper as [IEEE Codex](../ieee%20codex/README.md), not an additional scientific study or a Q2 acceptance claim. The existing Springer/IEEE manuscripts are unchanged.

## Contents and build

- `main.tex`: Springer Nature wrapper with the existing official `sn-jnl` class.
- `abstract.tex`, `body.tex`, `refs.bib`: identical scientific source to the IEEE Codex copy.
- `manuscript-source.md`: canonical-source copy; edit the IEEE copy and regenerate to keep them aligned.
- `manuscript.md`: complete rendered Markdown, including bibliography and relative figure links.
- `figures/`: four self-contained paper images.
- `sn-jnl.cls`, `sn-mathphys-num.bst`: copied unmodified from the project's existing Springer journal template; their embedded licences/notices apply.

```bash
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
```

Run from this directory. `main.pdf` and auxiliary outputs are ignored. The compiled PDF is kept local and attached to the Joplin note rather than committed. The folder is self-contained for a LaTeX/Overleaf upload with the usual package dependencies. Its style is not evidence of journal quartile suitability; choose and check a target venue independently.

See [codex-tools](../codex-tools/README.md) for common-source regeneration, provenance and checks. The Markdown copy in Joplin embeds all four figures and includes the complete formatted references, with both compiled layouts as companions.

## Before submission

Human confirmation is still required for author affiliation, funding/conflicts, ethics/waiver, data-reuse permissions, authorship and AI-assistance disclosure. The article explicitly distinguishes stored hand-labelled development outcomes from historical camera-label results and from future prospective/user studies. Missing current event counts, exposure and latency are not filled with another experiment's numbers. No new training or physical validation was performed for this manuscript.
