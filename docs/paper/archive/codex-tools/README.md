# Codex manuscript generation and evidence record

## Canonical source and scope

Edit `../ieee codex/manuscript-source.md` and `../ieee codex/refs.bib`, then run the renderer below. It produces identical `body.tex`, `abstract.tex`, readable `manuscript.md` and canonical-source copies in both new paper folders. The wrappers differ only in journal formatting. The four original paper variants, sensor recordings, annotations and trained models are unchanged.

The manuscript reports the implemented prototype and previously checked evidence. It is not a new training run or participant study. Stored current-model metrics, explored historical camera-label results and proposed studies remain separate. Author review/affiliation, ethics, data permissions and submission declarations remain unresolved rather than invented.

## Generate and compile

```bash
uv run --isolated --no-project --with pypandoc_binary==1.17 \
  python docs/paper/codex-tools/render.py

(cd 'docs/paper/ieee codex' && latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex)
(cd 'docs/paper/springer codex' && latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex)

uv run --isolated --no-project --with pymupdf \
  python docs/paper/codex-tools/verify.py
```

The renderer uses bundled Pandoc 3.9, converts tables to column-safe `tabularx`, merges complete captions into actual figure floats, preserves mathematical notation, and gives long identifiers breakable TeX formatting. The output Markdown uses standard image links, dollar-delimited mathematics and a full rendered reference section, not unexpanded citation keys or Pandoc-specific reference spans.

PDF outputs stay local/ignored and are attached to Joplin rather than committed. No application dependency was added. The initial GFM conversion and figure-AST handling were corrected before publication; final builds have no unresolved citations or overfull boxes. Springer retains normal underfull-page diagnostics from its class.

## Evidence and figure provenance

- Source snapshot for scientific claims: repository commit `6709b2a`, especially [the evidence audit](../../EVIDENCE_AUDIT.md), [research plan](../../Q2_RESEARCH_PLAN.md) and `revision-assets/evidence-audit.json`.
- The manuscript does not reassign the historical 161/372 result to manual labels or infer missing current event counts/exposure/latency from a rounded rate.
- `system_figure.py` generates a new **schematic**, grounded in `docs/architecture/components-and-deployment.md`, `safety-and-fail-closed-behavior.md`, the paired gesture policy and desktop volume-writer design. It is not a measured performance chart.
- `annotation-telemetry.png`, `historical-day-transfer.png`, `prospective-protocol.png` are byte-identical copies from `revision-assets/`. Their exact session, display scaling, historical source/configuration and proposed-study boundaries are in [figure-provenance.json](../../revision-assets/figure-provenance.json). Their captions carry those limitations into the paper.
- Optional schematic regeneration:

```bash
uv run --isolated --no-project --with matplotlib==3.11.2 \
  python docs/paper/codex-tools/system_figure.py
```

## Bibliography and third-party files

Six fully rendered references appear in the manuscript. FinDroidHR and Tsunoda metadata were checked against their Crossref DOI records; ViWatch's full author/title/DOI were read from its author-hosted primary PDF after Crossref returned HTTP 429. OpenWatch and Scientific Agent Skills metadata were read from their arXiv records. The repository reference names the exact evidence snapshot. The original sources are linked through DOI/URL fields in the BibTeX files; no incomplete author/title placeholders were carried over.

Official IEEEtran class and bibliography files were downloaded from CTAN. The Springer class/style were copied byte-for-byte from the existing project template. `ieee.csl` is the IEEE citation style from the Citation Style Language styles repository; its embedded attribution and licence are retained. `.gitattributes` disables whitespace lint only for unmodified vendored `.cls`/`.bst` files, preserving their original bytes and licence notices.

## Joplin copy

The new note is saved in the existing **Conference Papers** notebook:

**Failure-Aware Spatial Interaction — Codex manuscript (IEEE + Springer)**

It contains the complete editable manuscript and bibliography, four embedded image resources, both compiled PDF companions and a downloadable `.md` version with Joplin image links. Existing notes were not overwritten. The exact note body, seven resource metadata records and all downloaded resource hashes were verified; the bridge profile then synced successfully to Joplin Server. After restart, the same body/resources were read back and all eight items had enabled target-9 sync records covering the note update. Credentials and Joplin internal IDs remain outside the repository.
