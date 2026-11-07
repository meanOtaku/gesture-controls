# Revision assets: provenance and reproduction

These assets accompany the [evidence audit](../EVIDENCE_AUDIT.md) and [research plan](../Q2_RESEARCH_PLAN.md). They do not change original manuscripts, datasets, labels, model artifacts or runtime settings.

## Files and intended use

- `audit_evidence.py`: read-only stdlib inventory, effective-label scan, sensor-column deduplication, model-hash and role audit. It writes the two derived evidence files below. It scans 37 current exports; it is not a model evaluator.
- `evidence-audit.json`: full per-export row counts, hashes, model metadata and source-role resolution. `sensor_alias_check_complete = false` means unresolved, not safe. `audited_commit` records the checkout when generated; rerunning later records a later snapshot.
- `hand-labelled-inventory.csv`: human-readable per-export PPG counts. Run counts are sampled contiguous label runs, **not eligible model-event denominators**. Durations are spans, not negative exposure or independence claims.
- `make_figures.py`: real telemetry/historical-result figures and explicitly labelled audit/proposed-study schematics. It does not train or run inference.
- `figure-provenance.json`: exact illustrated session, clock origin, interval, display scaling and historical artifact/configuration.
- `literature-sources.json`: primary/full-text versus metadata-only retrieval scope and claim boundaries; no invented bibliographic records or exhaustive-search claim.
- `verify.py`: small snapshot-specific runnable publication check; local links, paired source equality, file formats/dimensions, model hashes and audited invariants. Update its expected inventory only after a new audit, not to hide a failed check.

## Available figures

Each has `.png` (300 dpi for viewing), `.pdf` (vector print) and `.svg` (editable vector text):

1. **`annotation-telemetry`** — actual saved signals and original/effective labels. Optical traces use displayed-window median centring and **unscaled** MAD division for visibility, not inference. Gyroscope norm is in rad/s. No interpolation, time shifting or model output is invented.
2. **`historical-day-transfer`** — historical camera-label LODO, selected no-still-hand-gate configuration, parsed directly from `docs/research/artifacts/cnn-all-days-2026-11/results.md`. This is not a rerun or a new-model result.
3. **`evidence-lineage`** — audit schematic distinguishing old/current evidence and outstanding verification. Current-model percentages are stored manifest metrics, not a matched comparison.
4. **`prospective-protocol`** — explicitly proposed future study, not a description of a completed experiment.

Caption text and scientific qualifications are supplied in the audit and per-format guides. Shared assets use repository-relative paths; copy the chosen assets into an individual paper folder before a standalone Overleaf upload.

## Reproduce from repository root

The audit and validation use Python stdlib. Figure generation was exercised with Python 3.14, matplotlib 3.11.2 and numpy 2.5.4 in an isolated uv environment; no application dependency was added.

```bash
python3 docs/paper/revision-assets/audit_evidence.py
uv run --isolated --no-project \
  --with matplotlib==3.11.2 --with numpy==2.5.4 \
  python docs/paper/revision-assets/make_figures.py
python3 docs/paper/revision-assets/verify.py
```

Existing effective-label loader tests, separately exercised for the audit:

```bash
PYTHONPATH=tools/label-trainer/src \
uv run --isolated --no-project --with numpy==2.5.4 --with pytest \
  python -m pytest tools/label-trainer/tests/test_manual_label.py -q
```

The first pytest attempt lacked `PYTHONPATH` and stopped during import; the corrected command above passed all three tests. This is a focused check, not a full application/training suite. No GPU training, prospective test, manuscript rebuild or live deployment was needed for these documentation-only changes.

## Important limitations

- Sensor-column hashes exclude label columns, include saved timestamp/sample fields, and identify exact complete-stream equivalence. They do not detect all overlapping partial crops or establish independent participants/days.
- Source IDs from filenames and available recording UUIDs resolve the hand-labelled pinch-in cohort. Older UUID-only manifests need their original import inventory; their role resolution remains incomplete.
- A nonempty manual field overrides an original label. Absence of an override does not prove absence of human review. Manual labels are not independently verified physical contact times.
- No current hand-labelled event log/exposure/latency artifact accompanies that model bundle in this checkout. Manifest metrics must remain labelled stored development evidence.
- Candidate future plots requiring model predictions, participant outcomes or motion trials were deliberately not manufactured.
