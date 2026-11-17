# Codex paper assets

Reproducible assets for the paper-improvement guide. **These are collected existing recordings/results, reanalysis and original schematics—not newly conducted participant or interaction studies.** The manuscript, active models, original recordings and the old global recording manifest are unchanged.

## Start here: one local command

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), clone this repository normally (including its binary files), then run from the repository root:

```bash
cd docs/paper/codex-assets
uv sync --locked --python 3.13
uv run --locked python build.py
```

This command runs the small regression checks, recomputes the classification metrics and validation thresholds from bundled prediction vectors, renders every figure, creates the gallery and verifies file hashes/dimensions. It needs **no GPU, watch, Joplin service, external experiment folder, API key or training run**. Internet is needed for the initial Python/dependency installation; subsequent runs use the installed environment and local evidence.

Open **[index.html](index.html)** in a browser for a local full-size gallery, or view **[OVERVIEW.png](OVERVIEW.png)**. GitHub displays HTML as source; download/open it locally. Every gallery entry links PNG, SVG and PDF and displays its evidence status and caption.

**To also re-execute continuous event accounting against the original repository recordings:**

```bash
uv run --locked python build.py --replay
```

This remains CPU-only, performs no fitting, and uses the **archived trainer**, not today's evolving trainer. It checks the original raw file identities and delayed annotation targets before reproducing all three seeds' event counts, exposure, FAR and median latency. It needs the full repository's matching `data/recordings/Hand labeled/` inputs; an isolated copy of this asset folder is sufficient only for the default figure/classification rebuild.

## What was actually executed and verified

The preparation run completed:

- A read-only collection of 101 provenance-listed evidence files, including an exact recorded telemetry excerpt, original saved prediction vectors, three archived checkpoints and 14 frozen trainer modules.
- Verification of all 135 corresponding original raw stream/clock files against the multiclass snapshot. The hand-labelled cohort is absent from the older global recording manifest; this package records its own hashes without editing that baseline manifest.
- Classification recomputation for three seeds on validation and test, including exact integer confusion matrices, accuracy, balanced accuracy and macro-F1.
- Reproduction of each validation-selected multiclass confidence threshold using validation labels only.
- Reproduction of the two final CNNv2 operating points from saved training out-of-fold budget tables, rather than choosing a favourable test cutoff.
- Frozen-source event replay for all three seeds and all three gesture classes: delayed labels, integer event outcomes, eligible negative time, FAR and latency agree with the archived results.
- Five runnable regression tests for effective-label overrides, interval boundaries, metric arithmetic, background dominance and invalid probabilities.
- Same-environment clean-directory regeneration with identical numeric metrics and all 16 PNGs byte-identical; no external experiment directory or repository raw data was used for that default rebuild.
- Staging of all 149 original training input/source files into a new scratch directory and execution of the original runner's annotation self-test, without starting GPU training.
- Validation of 16 figure triplets: PNG at 300 dpi, editable-text SVG and print-vector PDF, with input hashes, file signatures, dimensions and self-contained SVG resource links checked.
- A read-only current inventory: **60 exported recording folders, 45 distinct exact PPG/IMU stream pairs**, kept separate from the historical **37 exports / 28 pairs** audit.

The seed-17 multiclass held-out result reproduced from 103,347 decisions is **95.73% accuracy, 77.09% balanced accuracy and 77.84% macro-F1**. These are different metrics, not three estimates of the same quantity. Background dominates the decision count. The delayed-state experiment is not a directly matched test of the production binary onset detectors.

See [BUILD.json](BUILD.json) for package versions, script/output hashes and the recorded source commit, [sources.json](sources.json) for original-source mappings, and [derived/event-replay-verification.json](derived/event-replay-verification.json) for the frozen-source event results. A copied previous replay report is not a newly executed replay: use `--replay` to perform it again on your local raw data.

## Figure selection for your manuscript

The exact captions, alternative text, data transformations and evidence status are in **[CAPTIONS.md](CAPTIONS.md)** and machine-readable **[figure-catalog.json](figure-catalog.json)**.

| Figure | Suggested use | Evidence boundary |
| --- | --- | --- |
| 01 — System architecture | System Design | Implemented architecture schematic; no physical validation claim |
| 02 — Interaction policy | System Design / cancellation | Conceptual implemented policy, not measured fault tolerance |
| 03 — Hardware positioning | Related Work | Custom μDPad versus commercial-watch distinction; not product photos or performance ranking |
| 04 — Annotation telemetry | Dataset / annotation | Exact recorded rows; named gesture bands; display-only scaling |
| 05 — Historical score timeline | Historical results | Stored old-model replay, not newly inferred CNNv2 scores |
| 06 — Sensor delivery timing | Methods / reproducibility | Native timestamp gaps; not inference-grid frequency |
| 07 — Dataset identity | Dataset audit | Historical and current inventories shown as separate snapshots |
| 08 — Historical day transfer | Generalisation limitations | Historical camera-label cohort, not newer manually corrected test results |
| 09 — Motion recovery | Robustness investigation | Programmatically transcribed synthetic-splice summary, not recovered raw per-event traces |
| 10 — CNNv2 operating points | Model development | Stored operating points and training-OOF selection; reused historical benchmark, not an isolated component ablation |
| 11 — Multiclass confusion | Joint-model experiment | Recomputed from original prediction vectors; annotated state delayed by 500 ms |
| 12 — Multiclass seed variation | Joint-model reproducibility | Three independent models, not an ensemble or confidence interval |
| 13 — Multiclass continuous events | Operational errors | Frozen-source replay verified; hold entry is not physical hold-duration accuracy |
| 14 — Prospective protocol | Future Work | Explicitly proposed; no outcome values |
| 15 — Paired detector summary | Supplement / development history | Archived rounded summary; corresponding complete raw run not recovered |
| 16 — CNNv2 branch architecture | Methods / report | Conceptual branch diagram, not a layer-exact specification |

Use a small relevant subset in the conference paper; use the rest in the report/supplement. Do not add all figures merely because they exist. Figures 05, 08, 09, 10, 11 and 15 do **not** describe one interchangeable model/cohort/protocol.

### Ready for LaTeX

From `docs/paper/manuscript/`, for example:

```latex
\begin{widefigure}
\centering
\includegraphics[width=\linewidth]{../codex-assets/figures/11-multiclass-confusion.pdf}
\caption{Use the evidence-qualified caption in codex-assets/CAPTIONS.md.}
\label{fig:multiclass-confusion}
\end{widefigure}
```

Use `pagewidefigure` if the shared manuscript wrapper requires both columns. PNGs work in Joplin/Markdown; SVGs are editable in Inkscape or another vector editor. No images have been inserted into manuscript sections automatically. Figure PDFs are intentional source assets, not compiled manuscript PDFs.

## Reproduction levels: what each command does

### A. Verify the distributed package without regeneration

```bash
uv run --locked python verify.py
```

Checks original evidence hashes and the recorded output hashes, image formats/dimensions, SVG self-containment and numerical invariants. This is an integrity check, not a rerun of inference or training.

### B. Recompute metrics and regenerate figures

```bash
uv run --locked python build.py
```

A portable local rebuild. Uses the 60 saved validation/test prediction files from three seeds, not stored aggregate confusion matrices as its sole evidence. It independently checks those aggregates. It never optimises a threshold on test data.

`build.py` deliberately writes a new `BUILD.json` after rendering. The locked environment and DejaVu Sans reduce differences, but cross-OS font/rendering libraries may change output bytes. Require identical numerical metrics; do not equate a cross-platform raster/PDF byte difference with a scientific disagreement. The preparation run also exercises same-environment clean-directory regeneration separately.

### C. Recompute continuous events with the original trainer

```bash
uv run --locked python replay.py
# If this folder is outside your checkout:
uv run --locked python replay.py --repo-root /path/to/gesture-controls
```

This validates exact raw PPG/IMU file hashes, constructs the effective raw labels with the original loader, verifies delayed decision targets and replays exclusive winning-class scores using the original temporal detector. It compares integer catches/misses-related counts, late/repeated events, negative exposure, FAR and median latency with the saved experiment.

Do not substitute the newest trainer: the project changed temporal acceptance windows and other preprocessing over time. The frozen modules are hash-checked against `data/multiclass/snapshot.json`.

### D. Stage the original training experiment, without starting it

```bash
uv run --locked python prepare_training.py --check-only
uv run --locked python prepare_training.py --output /path/to/NEW-empty-training-directory
```

The output directory must not already exist. Staging copies the exact frozen trainer source, original runner, raw inputs and original snapshot. It does not modify this asset folder or activate models. All 149 original snapshot input/source identities are checked first.

**Full retraining is separate, optional and was not performed to make these figures.** The archived runner uses CUDA explicitly. The original experiment records a GTX 1050 Ti and PyTorch `2.5.1+cu124`; CPU/macOS figure regeneration does not imply the original GPU training runner works on those systems.

An example NVIDIA/CUDA environment for the staged original runner is:

```bash
# Run from the NEW training directory, not codex-assets.
uv venv --python 3.12 .venv-train
uv pip install --python .venv-train/bin/python numpy==2.2.6 scikit-learn==1.6.1
uv pip install --python .venv-train/bin/python torch==2.5.1 --index-url https://download.pytorch.org/whl/cu124
.venv-train/bin/python run.py --self-test
# Explicit opt-in: trains all three original seeds and writes new checkpoints/results.
.venv-train/bin/python run.py
```

On Windows, use the environment's `Scripts/python.exe` rather than `bin/python`. The training-environment recipe is not an assertion that all original transitive package versions were recovered or that this exact installation was exercised here. The original trainer/runner and raw inputs are archived; the **analysis/figure** environment is fully resolved in `uv.lock` and exercised.

The original GPU time-warp augmentation contains a CUDA cumulative-sum operation without a deterministic kernel. Therefore **bitwise identical retrained weights or identical new-run scores are not promised**, even with the same seeds. New training results must be labelled new results; do not overwrite the archived results and pretend the numbers were exactly reproduced. No checkpoint loading occurs in the default analysis workflow; if you choose to load archived PyTorch checkpoints, use the verified hashes and `weights_only=True`.

### E. Original evidence collection, not needed on your machine for A–C

```bash
uv run --locked python collect.py --multiclass-dir /path/to/cnnv2-multiclass-20261116
```

This was the initial collection step. It requires the original external experiment directory and its `inputs.tar.gz`, then snapshots the selected repository artifacts and audits the current raw recording tree. Re-running it against newer data intentionally creates a different input package and must be treated as a new evidence version. Keep the distributed snapshots if your purpose is reproducing these figures.

## Folder contents

```text
codex-assets/
  README.md, EVIDENCE_GAPS.md     Scope, instructions and missing studies
  pyproject.toml, uv.lock        Locked CPU analysis/rendering environment
  collect.py                    Read-only evidence collection
  common.py, analyze.py         Label/file rules and independent metric recomputation
  replay.py                     Original-source continuous event replay
  prepare_training.py           Optional original experiment staging; never starts training
  figures.py, gallery.py        Deterministic plot/schematic generation and offline gallery
  test_assets.py, verify.py     Runnable regressions and integrity/content checks
  build.py                      One-command local pipeline
  sources.json, BUILD.json      Source identities and executed-build provenance
  data/                         Bundled source snapshots, vectors, models and telemetry excerpt
  derived/                      Recomputed CSV/JSON metrics and event replay verification
  figures/                      PNG + SVG + PDF for every figure
  figure-catalog.json           Per-figure source, evidence, units/transformations and alt text
  CAPTIONS.md                   Ready-to-adapt, evidence-qualified captions
  index.html, OVERVIEW.png      Offline gallery and contact sheet
```

No personal video, new device capture, camera images, invented sensor traces or generated prediction curves were added. Device comparison pictures are original **schematics**, not manufacturer photos or copies of another paper's figures. Original model checkpoints are archived only as evidence and optional training/inference companions; they are not installed into the application.

## Important limitations before using the assets

- **Single-participant/development evidence remains single-participant/development evidence.** Reformatting a graph does not strengthen its generalisation claim.
- The multiclass experiment learns a 500 ms-delayed state target. Binary onset recall, delayed-state accuracy, hold entry and complete-task success are distinct endpoints.
- Zero observed false activations in a short negative exposure is not zero risk. Negative exposure denominators differ by class and cohort; keep them with their own event counts.
- A high four-class accuracy can coexist with weak hold recall and unacceptable false activations. Do not promote the background-dominated 95.73% into “95.73% reliable control.”
- Current source-tree duplicate counts are not the historical paper's counts. Exact hashes miss partial overlaps and session dependence.
- The haptic-noise export has context saying buzzes were present, but no exported actuator-event file. No fabricated haptic-on/off effect plot is supplied.
- The paired-model summary's similarly named runs elsewhere have different counts; they were not substituted for missing matching run artifacts.
- No modality-benefit, prospective multi-user, full interaction, physical-fault, battery-life or headset comparison has been invented. See [EVIDENCE_GAPS.md](EVIDENCE_GAPS.md).

Editing figures or captions does not update the manuscript or the Joplin copies automatically. Preserve the evidence-status qualifiers when moving an asset into either format.
