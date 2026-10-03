# Desktop application structure

The desktop application is a Tauri 2 shell: a React/TypeScript frontend (`src/`) and a Rust backend (`src-tauri/`). The root command remains `npm start`. For how it fits with the watch, the tracker and the trainer, see
[Components and deployment](../../docs/architecture/components-and-deployment.md); for what it will and will not do to the system volume, see
[Safety and fail-closed behavior](../../docs/architecture/safety-and-fail-closed-behavior.md).

## Frontend (`src/`)

```text
src/
├── app/                         # Composition root, window-mode selection, Tauri subscriptions
│   └── components/              # App-level chrome (sidebar navigation)
├── components/
│   ├── ui/                      # shadcn/ui primitives
│   └── app/                     # Shared app widgets (async buttons, help tooltips, operation feedback)
├── features/
│   ├── dashboard/components/    # Connection, calibration, and watch controls
│   ├── model-lab/               # Dataset import, training, lifecycle, replay, and deployment UI
│   │   ├── components/
│   │   └── hooks/
│   ├── overlay/components/      # Volume gesture overlay
│   ├── settings/components/     # Validated live controls and reset-to-defaults UI
│   └── telemetry/               # Bounded store, charts, recorder, annotations, quality summary, CSV export
│       ├── annotations/  components/  hooks/  quality/  store/
├── hooks/  lib/  test/          # Small shared hooks, utilities, and test setup
├── shared/
│   ├── protocol/events.ts       # Typed Tauri/watch event contracts and event-name constants
│   ├── tauri/                   # Typed wrappers over Tauri commands (CSV export, recording bundles)
│   └── hooks/                   # Cross-feature hooks
├── main.tsx                     # React bootstrap only
└── styles.css                   # Shared application theme
```

Rules:
- Feature components may depend on `shared`, but not on another feature's implementation.
- `app/` composes features and owns application-wide Tauri listeners.
- Event payload shapes and event **names** live in `shared/protocol/events.ts`; do not duplicate wire types or event-name literals in components. A Rust test (`inference::ppg_window_tests::event_names_match_the_frontend_protocol`) fails if the backend's `GESTURE_POLICY_EVENT` or `OVERLAY_STATE_EVENT` drifts from the frontend's declaration.
- Runtime settings are validated and atomically persisted by Tauri as `settings.json`
  in the platform app-config directory; React applies graph/recording rates locally
  while Tauri replays Watch controls after reconnection.
- The Samsung PPG rate controls the Watch's existing `HealthTracker.flush()`
  schedule. Heart-rate, skin-temperature, and EDA rates are desktop acceptance
  limits. Samsung remains authoritative for physical sampling and callback cadence.
- Keep tests colocated with the component or composition root they verify.
- The webview is **not trusted to authorize actions**. It displays state and
  requests operations; the backend decides whether a request is permitted (see
  *Trust boundary* below).

## Backend (`src-tauri/src/`)

| Module | Responsibility |
| --- | --- |
| `lib.rs` | Builds the Tauri app, registers state and commands, runs the watch event loop and the policy watchdog, bounds window-close teardown |
| `head_pose.rs` | Selects and runs the Sony provider (in-process native, or the external UDP bridge); head-tracker diagnostics |
| `calibration.rs` | Center/top-right calibration state, dwell, target entered/exited events; the optional corner-demo start |
| `watch.rs` | Watch connection status, latest orientation, and the typed watch events forwarded to the frontend |
| `overlay.rs` | The overlay window and `OverlayState`; grab ownership (`GrabOwner`), the wrist-rotation transaction, write and haptic throttling, native volume reads and writes |
| `settings.rs` | Validated, atomically persisted `settings.json`, watch settings replay, transport switching |
| `inference.rs` | The live path: PPG ordering watermark, quality and window checks, fusion, model load, the gesture policy runtime, `apply_decision` |
| `model_registry.rs` | Model lifecycle, thresholds, quality gates, intent bindings, the bundle contract (`load_and_verify_bundle`), activation and rollback, inference-mode handling |
| `model_lab.rs` | Dataset import and validation, training and replay subprocesses (`uv run`), model listing |
| `training_label_mapping.rs` | The explicit label-to-training-role mapping (mirrors the Python `LabelMapping`) |
| `label_registry.rs` | The label catalogue (stable ids, roles, archive state) |
| `recording_bundle.rs` | Immutable recording bundles (`raw.csv`, `recording.json`, `annotations.json`), imports, quality summary, save-request validation |
| `environment.rs` | Desktop-readiness checks (uv, classifier project, LiteRT availability, volume backend) |

### Inference modes and the gesture policy

`inference.rs` is the only path by which a classified transition reaches the
gesture policy (`interaction_engine::GesturePolicy`, wrapped by
`GesturePolicyRuntime`). The policy has three modes:

- **Off:** no window reaches a model.
- **Monitor:** windows are classified and decisions reported, but nothing actuates.
- **Live:** only the intent bound to the active model's class actuates
  (`VolumeGrab` / `VolumeRelease`); a window that does not match the model's
  training window is refused.

A persisted `Live` is capped to `Monitor` at startup
(`model_registry::reconcile_inference_mode_at_startup`), and a mode change applies to
the policy before it is persisted. Every rejected window, mode downgrade, model swap
or disconnect force-releases an active grab. The desktop owns all inference and
policy; the watch and headphones are sensor sources only.

### Trust boundary

Commands are callable by the webview, so each one that could cause an effect checks
a backend-owned fact rather than the caller's claim:

- `show_overlay` requires the backend's calibration state to show the top-right target active;
- `adjust_system_volume` requires a visible overlay;
- there is no command that injects a gesture transition;
- `report_model_runtime_failure` can only force a release.

### On-disk state

See [Components and deployment §3](../../docs/architecture/components-and-deployment.md#3-data-at-rest) for the files each module owns. Two rules apply to all of them: writes are atomic (stage, then rename), and an unreadable `registry.json` is an error that leaves the file untouched, never an empty registry.

### Tests

`cargo test -p spatial-gesture-desktop` runs the backend's unit tests (they construct no Tauri `AppHandle`, so logic that needs one is factored into pure functions). Frontend tests run with `npm test`.
