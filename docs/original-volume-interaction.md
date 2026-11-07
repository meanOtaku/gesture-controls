# Return to the original volume interaction

Updated: 2026-11-07. Product direction supplied by the user: Pinch In and Pinch Out are now working; focus next on the original spatial-control application. This is a report of user-observed progress, not an independent model evaluation. Do not retrain, replace, or activate models as part of planning this integration.

## Implemented interaction

The paired-event recipe, editor and setup preset are implemented in the current working tree.
The user can now choose **Recipes → Set up pinch volume knob**, confirm the right-corner
location and the actual start/end model label IDs, save, and enable the recipe. Disable the
STEM/other volume recipe first to avoid the existing resource-conflict gate. The preset is
saved disabled; it does not activate models or change inference mode automatically.

Use approved, deployable Pinch In and Pinch Out models in Live for real control. Both need
to be loaded and healthy; a Monitor-only release model cannot safely complete the pair and
blocks the grab. Existing held-label and STEM recipes retain their behavior.

The knob uses continuous quaternion-derived roll, fractional volume deltas, a 1° preset
dead zone and about one volume point per 3° rotation. **Sensitivity** changes that ratio;
**Reverse direction** compensates for watch/arm orientation if the physical direction is
opposite. Pinch In anchors the wrist position; duplicate starts do not re-anchor it. Pinch
Out retains the last applied volume and returns the knob to Ready while the head remains
at the target. A fresh Pinch In grabs again from the current wrist angle.

Smoothness changes: stationary wrist updates allow a rate-limited target to catch up;
200 Hz input no longer multiplies the allowed volume slew rate; the rendered dial keeps
fractional progress even though its percentage text is rounded. Existing native writer
pacing and interaction epochs remain in place. Actual audio output resolution/latency is
platform dependent, and direction/feel still require the user's watch/headset trial.

Volume tuning (2026-11-07): in `overlay.rs::RecipeDrive`, accumulate wrist movement but
only accept a new target once it differs by 0.5 volume points (always allow 0 and 100).
This rejects small back-and-forth jitter without losing a slow turn. Ease toward that
target with a 150 ms exponential time constant, then apply the existing speed limit.
The filter starts at the current volume on each grab and stops receiving updates on release.
These defaults apply to volume recipes only; they do not change watch data or pinch detection.
To check the feel, hold still after grabbing, turn slowly in each direction, then release
mid-turn. Listen for a steady level while still, a gradual change while turning, and no
continued ramp after release. The knob should remain ready while looking at the corner.

Files: `crates/automation/src/{recipe,runner}.rs`, desktop `automation.rs`,
`label_runtime.rs`, `overlay.rs`, label-inference `runtime.rs`, recipe UI/types and
`VolumeKnob.tsx`. Fresh edges are consumed once, separate from cached one-shot pulses.
Runtime faults invalidate latched actions even when the individual detectors are inactive.

Validation (2026-11-06): `npm test` passed 909 frontend tests across 147 files,
plus launcher/configuration/icon checks. `cargo test --workspace --locked --offline`
passed 708 tests with 14 ignored. `npm run build`, workspace clippy with warnings denied,
`cargo fmt --all -- --check`, and `git diff --check` passed. Native hardware feel and
left/right direction have not been verified on the user's watch. Existing frontend build
chunk-size warning remains. No model was retrained or activated and no saved recipe was
automatically enabled.

## Target experience

1. Look toward the calibrated top-right location and dwell: the volume knob appears ready.
2. Pinch In: grab the knob, record the current wrist orientation and volume, and show grabbed feedback.
3. Rotate the wrist: adjust volume relative to that grab point, retaining the existing dead zone and rate limits.
4. Pinch Out: end the grab, retain the last applied volume, and keep the knob visible in Ready.
5. Begin a new interaction deliberately; an old detection must not regrab the knob.

This is the primary interaction in `architecture/project-brief.md`. Keep the existing sensor transport, head calibration, volume adapters and recipe engine. Research tools remain available, but building more research tooling is not this milestone's objective.

## Current implementation and the missing connection

- `apps/desktop/src-tauri/src/automation.rs::default_recipes` already has the top-right → pinch → wrist-roll volume recipe. It is disabled by default and expects `Stage::Model { label: "pinch", hold: ModelHold::Held }`.
- `crates/automation/src/recipe.rs` supports held or one-shot model stages, not a pair of start/end model labels defining a sustained interaction.
- The current model runtime supplies actionable detections to the automation engine. Preserve its Off/Monitor/Live and deployability gates.
- The knob overlay, native volume adapters, head-target dwell and wrist mapping already exist. Extend them rather than adding a second control pipeline.

Pinch In's detector returning inactive is not a physical Pinch Out. The interaction must remember a grab between the two event detections. Do not fake a long detector hold or extend one-shot timeouts to implement this.

## First implementation slice

Add an explicit paired-model stage to the existing recipe system, with selectable start/end labels (initial intended mapping: Pinch In → start, Pinch Out → end). Confirm the actual saved label IDs when wiring the user's recipe; do not assume display names equal IDs. Retain compatibility with existing held-model and STEM-button recipes.

The paired stage should:

- Consume fresh, actionable start/end events; a start seen before the head target is armed must not count later.
- Latch only after Pinch In while the required head stage is satisfied.
- Remain held between detection events while required source/runtime health remains valid.
- Release on Pinch Out. If start and end arrive together, release wins.
- Ignore repeated starts while grabbed; they must not reset the wrist baseline or jump volume.
- Clear on head-target exit, Escape, source loss/staleness, model replacement/unavailability, inference mode change out of Live, recipe edit/disable, or application shutdown.
- Never confuse quiet detectors between gestures with a dead sensor stream. Use existing source freshness/health signals for fail-closed cancellation.
- Require a new start event after release/cancellation; never reconstruct a grab after reconnect or restart.
- Retain the final applied volume on normal release. Safety cancellation stops further writes; it does not imply restoring an earlier volume.

Use the existing resource-conflict behavior so the paired-pinch and STEM recipes cannot simultaneously drive volume. Do not silently enable a new recipe or change the user's active models.

## UI and feedback

Extend the recipe editor with start/end label selectors and clear missing-model diagnostics. Display Ready / Grabbed / Released feedback in the existing knob. Reuse existing haptic support where appropriate, with bounded/rate-limited commands. The user should not need to interpret raw model scores to use the interaction.

Updated user preference (2026-11-06): after normal release, keep the knob visible while the head remains at the corner. A fresh Pinch In starts another grab without looking away, using the current wrist angle as the new reference. Looking away hides it. Escape and safety faults still cancel and latch hidden. This supersedes the original brief’s dismissal-on-release behavior.

## Acceptance tests

Automated tests must cover the complete head → start → rotate → end sequence and these cases:

- Head movement alone and wrist movement alone cannot adjust volume.
- A start before arming, an end without a grab, and duplicate start/end events do nothing unexpected.
- Volume continues between short start/end detection pulses; normal detector inactivity does not release it.
- End takes precedence over start in one update.
- Every cancellation path releases, clears pending writes, and prevents stale-event reactivation.
- Monitor/Off and non-deployable models cannot start the interaction.
- Existing saved recipes load unchanged, including the STEM fallback and held-label recipes.
- Conflicting recipes are blocked consistently and explained in the UI.

Then perform a user-led hardware session with the working Pinch In/Out models: calibrate center/top-right, test the recipe first with simulated volume, then on an isolated audio output. Record head-dwell-to-ready time, pinch-to-grab/release latency, wrist tracking smoothness, unintended grabs and missed releases. Software tests do not substitute for this session.

## Subsequent product work

After this single interaction is comfortable and dependable: refine the knob's presentation, tune wrist sensitivity for the user, simplify daily startup/calibration, and only then extend the same interaction to brightness, scrolling or other controls. General CI, signing and security work remains in `project-review-2026-11-06.md`; it is not the product roadmap for this milestone.

## Follow-up: corner preview hidden during model warm-up

The user reported an enabled, calibrated recipe with no visible knob. A regression test
confirmed that `Engine::set_models` cancelled and latched the recipe hidden even before a
grab, whenever a paired label was unavailable or rejected a warm-up window. The fix keeps
the head-target preview armed, suppresses a concurrent start while either paired label is
unavailable, and cancels/hides only an already-driving pair. Watch loss follows the same
distinction. A fresh valid pinch can grab after recovery without another head-target entry.

`model_warmup_keeps_corner_preview_visible_but_cannot_grab` failed before the fix and
passes after it, including fault cancellation after a successful grab. Desktop library
suite: 303 passed, 13 ignored. The development app automatically restarted during the fix;
its session-relative head calibration must be captured again. The user confirmed that the knob appears after recapturing calibration and looking at
Top right. Pinch/rotation/release feel still needs its own hardware trial.

Stay-visible release validation: paired-runner regression failed on the previous behavior and
passes after the change. Automation and desktop suites: 372 passed, 13 ignored; targeted
clippy and formatting pass. Coverage includes no adjustment while released, fresh-angle
regrab without a volume jump, release winning over simultaneous start, and Escape hiding.
