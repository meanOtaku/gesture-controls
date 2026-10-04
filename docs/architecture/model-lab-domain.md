# Model Lab domain model (per-label binary models)

**Status:** step 1 of the Model Lab refactor is delivered as a pure crate, `crates/model-lab-core`. It is **not wired into the desktop app yet**: the running app still uses the single-model registry in `apps/desktop/src-tauri/src/model_registry.rs`. The runtime that evaluates these models and the UI are later steps (see [`../decisions/2026-10-model-runtime-and-format.md`](../decisions/2026-10-model-runtime-and-format.md)).

## The idea

Every deployable model detects **one label** (output 0 = absent, 1 = present). Several labels can have an active model at once, each independently. A label can exist with no project and no model at all.

```
shared recording store (not copied)
        |
   Label Project  ----------------  owns the work for one target label
        |
   Dataset Snapshot  --------------  immutable: mapping + contract + recordings by hash
        |
   Training Run  ------------------  one trainer, one snapshot, immutable once finished
        |
   Model Version  -----------------  one candidate binary model: Draft > Evaluated > Approved > Active, or Archived
        |
   Active slot  -------------------  at most one per label
```

## What the crate enforces

| Rule | Where |
| --- | --- |
| Ids are validated slugs (labels use the catalogue's `pinch_start` form); path characters never get in | `ids.rs` |
| One project per label; a project's target must be marked **positive** in its mapping | `project.rs`, `registry.rs` |
| An **input contract** names the streams a model reads (watch orientation, acceleration, gyroscope, PPG, head pose), the ordered features, window, stride, maximum gap and minimum samples | `contract.rs` |
| Thresholds: release may not exceed activation (the hysteresis), plus debounce and cooldown | `contract.rs` |
| A snapshot lists every label's role explicitly (positive, negative or excluded). A label found in the data but missing from the mapping, an unknown label, a missing or changed recording, an empty split, or a recording used to both train and evaluate is **rejected** | `snapshot.rs` |
| A snapshot is sealed with a SHA-256 over its contents; editing a label, mapping or recording hash afterwards is detected, so an old model's data cannot change meaning | `snapshot.rs` |
| A run goes queued, running, finished and never changes again; it ends **deployable**, **evaluation-only** or **failed** (a failure must say why; deployable needs a hashed model artifact) | `run.rs` |
| A version belongs to exactly one label (its project's), starts as a Draft, and an **evaluation-only** version can be reviewed but never approved or activated | `version.rs`, `registry.rs` |
| Only an approved, deployable model can be activated. Activating replaces **that label's** active model only, demotes it to Approved and remembers it for **per-label rollback** (rolling back twice goes forward again). The call reports the replaced model so the runtime can clear its detection state and release what it was holding before the new one takes over | `registry.rs` |
| An active model is pinned: it cannot be archived or moved without deactivating or replacing it. Archiving a rollback target removes it as the target | `registry.rs` |
| A remembered **Live** mode restarts as **Monitor** | `registry.rs` |
| `validate()` checks every invariant (one active per label, slots point at the right label and state, no evaluation-only model approved, no dangling run or project, snapshots intact). A registry that breaks one is **refused on load** | `registry.rs` |

## Persistence

`RegistryStore::mutate` makes each change on a copy, validates it, saves it, and only then adopts it. A save failure is returned and **leaves memory unchanged**, so memory and disk never disagree. `FileStore` writes a temporary file, flushes it and renames it over the real one. A missing file is a fresh install; a file that cannot be read, parsed, validated or is from another schema version is an error and is **never replaced by an empty registry**.

The file is `registry-v2.json` in the model-lab directory, beside the old `registry.json`.

## Migration from the old registry

`open_registry` reads `registry-v2.json` if there is one. Otherwise, if the old `registry.json` exists, it is migrated **once**, the result is saved, and the old file is left exactly as it was.

Every model in the old registry is a **three-class pinch classifier**, which cannot be a binary one-label model. So migration does not carry any of them over as working models, and does not drop them: each is kept whole in the new registry's `quarantined` list, with its state, thresholds, quality gate, history, intent bindings, whether it was imported, whether it was the active or previous model, and a message saying what to do (train a binary model for each of `pinch_start` and `pinch_release`). The old model directories are untouched.

- Deterministic: the same old file always gives the same result (ordered by id, no clock).
- Fails closed: an old file that cannot be parsed, repeats an id, or names an active or previous model that is not listed is refused, and nothing is written.
- The inference mode is carried over.
- A test serialises the old registry's real types and migrates that, so a change to the old format cannot quietly break migration.

No old registry existed on the development machine, so migration has been exercised against fixtures and that real-serialiser test, not against a trained registry.

## Not done yet (later steps)

Wiring this registry into the app and its commands; dataset snapshots built from real recordings; the ONNX bundle validator and external import; the `tract` runtime and shared window/feature pipeline; temporal detection; the recipe step for model labels; trainer adapters; the Label Project UI. The old registry, the TFLite path and the three-class pinch model keep working until they are replaced (removal condition in the decision record).
