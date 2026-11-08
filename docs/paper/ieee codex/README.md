# Codex manuscript: IEEE journal format

New manuscript, 8 November 2026:

**Failure-Aware Spatial Interaction with Consumer Wearables: A Source-Audited Study of Head Targeting and Smartwatch Pinch Detection**

This is an evidence-qualified working paper, not a claim of Q2 acceptance or completed prospective validation. It contains a full abstract, introduction, related work, system, annotation/source audit, causal methods, evidence-qualified results, discussion, proposed confirmatory study, limitations and references. Author affiliation, ethics/waiver and submission declarations require human confirmation. Existing manuscripts are untouched.

## Contents

- `main.tex`: IEEE journal wrapper.
- `abstract.tex`, `body.tex`, `refs.bib`: complete generated scientific content and verified references.
- `manuscript-source.md`: canonical editable source with citation keys.
- `manuscript.md`: readable Markdown with a rendered reference section and relative figure links; the Joplin note uses resource links for those same images.
- `figures/`: four images, including the new implementation schematic and three evidence-qualified audit/protocol figures.
- `IEEEtran.cls`, `IEEEtran.bst`: unmodified official IEEEtran files downloaded from CTAN; their embedded copyright/licence notices apply.

## Build

```bash
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
```

Build from this folder. `main.pdf` and temporary TeX outputs are ignored by Git. The compiled PDF stays local and is attached to the Joplin note; it is not committed as a manuscript binary. The folder is self-contained for LaTeX/Overleaf, subject to the usual TeX package dependencies.

For shared-source regeneration, figure provenance and checks, see [codex-tools](../codex-tools/README.md). The scientific content matches [Springer Codex](../springer%20codex/README.md); only wrapper/layout and bibliography presentation differ.

## Scientific scope

Current hand-labelled evidence takes priority, but incomplete event/exposure/latency logs remain explicitly incomplete. Historical camera-label experiments are identified by cohort and are not relabelled as new results. The proposed study is future work, not a fabricated experiment. No new model training, data relabelling or physical trial was performed to write this manuscript.
