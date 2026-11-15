# Desktop UI audit, November 2026: "sometimes less is more"

Scope: every page and panel of the desktop app (`apps/desktop/src`), against the daily flow it serves:
record (Recorder) → label (Labelling) → train (Model Lab) → activate → use pinch-turn volume in Monitor/Live.

How it was done: the code of every page, plus the real screens in the browser preview (`localhost:1420`, the `tauri dev`
Vite server). The preview has no desktop data, so the pages that list recordings, models and labels (Labelling,
Datasets, Model Lab lists, Recordings) were judged from their code. "Used most" and "rarely used" come from the daily
flow above and the project notes, not from usage counts; the app logs none.

Nothing in the code has been changed. Each item below is a proposal to agree or drop.

## What the screens weigh today

Measured in the preview at 1440 × 900 (the fold is at 900 px):

| Page | Height (px) | Words | Buttons | Inputs | Note |
|---|---:|---:|---:|---:|---|
| Settings | 5,734 | 1,063 | 52 | 56 | Gestures group alone is 2,580 px |
| Watch | 2,953 | 290 | 11 | 8 | sensor switches repeat Settings |
| Model Lab | 1,857 | 468 | 12 | 2 | runtime switch is in the third card |
| Drone | 1,722 | 294 | 25 | 4 | |
| Recorder | 1,665 | 381 | 19 | 13 | the noise and gesture Start buttons are below the fold |
| Network lab | 1,582 | 624 | 3 | 0 | mostly explanation, repeated from Model Lab |
| Live signals | 1,220 | 165 | 5 | 0 | |

The sidebar has 17 entries. Cmd+1…0 reach the first ten in sidebar order, which are Overview, Gestures, Recipes, Virtual
devices, Watch, Headphones, Drone, Live signals, Recorder and Recordings. Labelling and Model Lab, two of the three
pages used every day, have no shortcut.

## Ranked list

Effort: S = under an hour, M = a few hours, L = a day or more. Ranked by value for the effort, highest first.

### Tier 1: high value, small change

**1. Move: put the model runtime switch (Off / Monitor / Live) where it is used.** *Improve, S–M*
- Files: `features/model-lab/components/LabelModelsPanel.tsx` (the control today), `features/model-lab/components/ModelLab.tsx`
  (the "Runtime" stat card), `app/components/AppNav.tsx` (sidebar footer, next to `ReadinessLight`),
  `features/dashboard/components/Dashboard.tsx` (Overview).
- Why: switching between Monitor and Live is the most frequent action when the app is in use, and it sits in the third
  card of Model Lab, under the Train form. Make the Model Lab "Runtime" card the control itself (it shows the mode but
  cannot change it), and add a small Off / Monitor / Live switch to the sidebar footer where the readiness light already
  shows. Keep the Live confirmation.

**2. Remove: the duplicate watch sensor switches on the Watch page.** *Remove, S*
- Files: `features/dashboard/components/Dashboard.tsx` (`WatchSensorControls`), `features/dashboard/components/WatchSensorControls.tsx`;
  Settings keeps `features/settings/components/WatchSensorSwitchSection.tsx`.
- Why: the same seven switches ("Orientation", "Accelerometer" … "EDA") appear in full on both Watch and Settings → Watch.
  Keep them in Settings. On the Watch page, show one line only when a sensor is off ("Pulse (PPG) is off, change in
  Settings").

**3. Remove: "Connection details" on Overview.** *Remove, S*
- Files: `features/dashboard/components/Dashboard.tsx` (the `<details className="connection-details">` block).
- Why: three read-only fields with hard-coded values (`127.0.0.1`, `4243`, `0.0.0.0:8766/ws/watch`). The watch
  WebSocket address is also misleading now that Bluetooth is the default transport. It is developer information; it
  belongs in `docs/`, not on the home page.

**4. Improve: re-map Cmd+1…9 to the daily pages.** *Improve, S*
- Files: `app/components/AppNav.tsx` (`NAV_ORDER`, `shortcutFor`), `app/components/ShortcutsSheet.tsx`.
- Why: today the shortcuts follow sidebar order, so Drone and Virtual devices have one but Labelling and Model Lab do not.
  Proposal: ⌘1 Overview, ⌘2 Recorder, ⌘3 Labelling, ⌘4 Model Lab, ⌘5 Datasets, ⌘6 Gestures, ⌘7 Recipes, ⌘8 Watch,
  ⌘9 Headphones, ⌘, Settings. This decouples shortcuts from sidebar order.

**5. Improve: one-line page headers.** *Improve, S*
- Files: every page's `<header className="hero">` (Dashboard, ModelLab, RecorderPage, LiveSignalsPage, RecordingsPage,
  DatasetsPage, LabellingPage, LabelsPage, GestureLibraryPage, NetworkLab, RecipesPage, GesturesPage,
  VirtualDevicesPage, DronePage, Settings); `styles.css` / `neo-theme.css` for `.hero`.
- Why: each page opens with "SPATIAL GESTURE CONTROL" (already in the sidebar), a large title and a one-to-three-line
  subtitle: 129–158 px, about a sixth of the screen, before anything usable. Drop the eyebrow and cut each subtitle to
  one short line (or none). Several subtitles are out of date too: Recorder says "add it to the training data from
  Model Lab", but recordings join Datasets by themselves.

**6. Improve: long section descriptions become a "?" tooltip.** *Improve, S–M*
- Files: `features/labelling/LabellingPage.tsx` ("Signals", "Check the model", "Label timing", "Keep it"),
  `features/telemetry/components/*Card.tsx`, `features/model-lab/components/*Card.tsx`.
- Why: many cards open with a 40–80-word paragraph that is read once and then skipped every day after. `SectionHeader`
  already has a `help` prop that shows a "?" tooltip. Keep one short sentence in `description`, and move the rest into
  `help`. Labelling alone has about 250 words of such text.

**7. Improve: the two "Whole recording" buttons on Labelling.** *Improve, S*
- Files: `features/labelling/LabellingPage.tsx` (lines ~787 and ~1004).
- Why: "Whole recording" is both a zoom button (show the whole time span) and a Scale option (same y-scale throughout,
  vs "Fit to view"). They sit close together and mean different things. Rename the scale options "Fixed scale" and
  "Fit to view".

**8. Remove: the Recordings and Labels link cards inside Model Lab.** *Remove, S*
- Files: `features/model-lab/components/ModelLab.tsx` (`#lab-dataset` card, `#lab-coverage` card), the `lab-workflow`
  jump links.
- Why: both are a sentence and an "Open …" button for pages already in the sidebar, and the "Recordings" figure is
  already in the stat cards above. Removing them also drops one entry from the jump links.

### Tier 2: bigger merges that remove pages

**9. Merge: Network lab into Model Lab.** *Merge, M*
- Files: `features/model-lab/components/NetworkLab.tsx`, `ModelInspector.tsx`, `ModelStages.tsx`, `ModelLab.tsx`,
  `LabelModelsPanel.tsx` (the More → Inspect action), `app/App.tsx`, `app/components/AppNav.tsx`.
- Why: Network lab is two things: "The models", about 450 words of pipeline explanation that repeats the Train card's
  model descriptions word for word, and "Look inside a model", which is what Model Lab's Inspect button opens. Make
  Inspect open the inspector inside Model Lab (a panel or a sheet), put "How the models work" behind a disclosure there
  (or in `docs/`), and drop the sidebar entry. 17 → 16 entries.

**10. Merge: Recordings into Datasets, and use one word for one thing.** *Merge, M*
- Files: `features/telemetry/components/RecordingsPage.tsx` (`CameraProposalsPanel` + `RawImageViewerPanel`),
  `features/model-lab/components/DatasetsPage.tsx` / `DatasetManager.tsx`, `app/components/AppNav.tsx`, `App.tsx`.
- Why: the same things are called "Recordings" (sidebar page), "Datasets" (sidebar page), "Recordings" (the card on
  the Datasets page), "Recordings" (Model Lab card) and "Dataset" (the Labelling picker inside a card titled
  "Recording"). The Recordings page is a raw-signal image viewer and camera proposals for one saved session, so it works
  as a "Look inside" action on a Datasets row. Proposal: call them recordings everywhere, rename the Datasets page
  "Recordings", and open the image viewer from a row. 16 → 15 entries.

**11. Move: Live signals into the Recorder (and the Watch page).** *Merge, M*
- Files: `features/telemetry/components/LiveSignalsPage.tsx`, `SignalMonitor.tsx`, `WellnessCapturePanel.tsx`,
  `RecorderPage.tsx`, `features/dashboard/components/Dashboard.tsx`.
- Why: Live signals and the Recorder open with the same status strip, and the graphs are mostly wanted while recording
  ("is the pulse sensor in contact?"). Put the signal graphs on the Recorder as a folded "Live graphs" panel (folded by
  default: the graphs redraw 15 times a second), and the on-demand wellness captures (SpO₂, ECG, BIA) under the Watch
  page's health section. 15 → 14 entries.

**12. Improve: the Recorder shows one session type at a time.** *Improve, M*
- Files: `features/telemetry/components/RecorderPage.tsx`, `PinchSessionCard.tsx`, `EverydayNoiseCard.tsx`,
  `GestureRecordingCard.tsx`, `SessionDetailsCard.tsx`.
- Why: three session cards (pinch, everyday noise, other gesture), each with its own options, sit in a stack, with the
  noise and gesture Start buttons below the fold. Only one is used per recording. A segmented choice at the top
  ("Pinch session | Everyday noise | Other gesture", remembered) showing that one card halves the page. Session details
  (wrist, arm, strap, pinch) rarely change between sessions: show them as one summary line ("Left wrist, crown right,
  sitting · Edit") that opens the form.

**13. Improve: Settings shows the everyday settings, and folds the rest away.** *Improve, M*
- Files: `features/settings/components/Settings.tsx`, `WatchRateSettingsSection.tsx`,
  `WatchHealthDeliverySettingsSection.tsx`, `WristRotationSettings.tsx`, `HeadphonesSettingsSection.tsx`,
  `RecordingGraphSettingsSection.tsx`, the six `*Settings.tsx` gesture sensitivity files; `components/app/AdvancedSection.tsx`
  (already used by Model Lab) for the folding.
- Why: 5,734 px, 56 inputs. Under "Advanced", folded: IMU sampling rates, Samsung health delivery controls, wrist
  rotation limits, headphone acceptance rate, recording and graph rates. These are rarely changed after setup. Also:
  - IMU rates allow 1–200 Hz but a Galaxy Watch4 delivers at most 100 Hz, as each hint says. Cap the fields at 100 and
    drop the sentence.
  - The six gesture-sensitivity cards (shake, swipe, tap, wiggle and hammer, roll, pitch) each hold one or two fields
    and a "recognised since…" counter that the Gestures page also shows. Put them into one compact "Sensitivity" table
    (gesture, field, default), without the counters. Gestures group goes from about 2,600 px to about 900.
  - Headphones "Acceptance rate" shows "Enabled / Click to disable; takes effect immediately" as a switch label. Call
    the switch "Use headphones" and the field "Headphone sample rate".

**14. Improve: Watch page shows status first, diagnostics folded.** *Improve, S–M*
- Files: `features/dashboard/components/Dashboard.tsx`, `WatchTelemetryPanel.tsx`, `LinkHealthCard.tsx`,
  `WatchPowerCard.tsx`, `WatchWellnessPanel.tsx`.
- Why: 2,953 px. What is checked daily is connected, battery, on wrist, and the link. Keep that in view. Fold "Link
  health", "Watch power" (a 30-minute measurement procedure) and "Health sensors / PPG" under "Diagnostics", and drop
  the raw quaternion / accelerometer / gyroscope readouts, which the live graphs show better (item 11).

**15. Improve: model activation takes one click, not three.** *Improve, M (check the backend first)*
- Files: `features/model-lab/labelModels.ts` (`actionsFor`), `features/model-lab/components/LabelModelsPanel.tsx`;
  possibly `crates/label-inference` (off limits until the CNN v2 work is committed).
- Why: a model you just trained goes Draft → "Mark as evaluated" → "Approve" → "Activate", three clicks with a re-render
  between each, although the app has already tested it on held-out recordings. For a single user that is ceremony.
  Proposal: show "Activate" as the next step on any evaluated model (and on drafts trained in the app), doing the steps
  in one go. The individual moves stay under More, for imported models. Whether the registry allows the jump, or the
  front end has to chain the three calls, has to be checked first.

### Tier 3: worth doing, lower value or needs a decision

**16. Improve: Overview shows what is in use, not first-run setup.** *Improve, S–M*
- Files: `features/dashboard/components/Dashboard.tsx`, `OverviewSection.tsx`, `ModelWorkflowCard.tsx`, `RecipesCard.tsx`.
- Why: Overview opens with "Get your devices ready" (three steps and a paragraph) every time, even when they are done.
  The "Making a model" checklist below repeats the sidebar's "Make a model" group. Proposal: when the devices step is
  complete, collapse it to one line ("Watch and headphones ready ✓"). Put a "Pinch control" card in its place: runtime
  mode, active models, readiness, last detection. Keep "Making a model" as a single "Next: label recording 12 →" line.

**17. Merge: Virtual devices into Recipes.** *Merge, M*
- Files: `features/devices/components/VirtualDevicesPage.tsx`, `features/recipes/components/RecipesPage.tsx`,
  `RecipeEditor.tsx`, `AppNav.tsx`.
- Why: the four virtual devices (knob, two faders, step knob) exist to be picked inside a recipe, and each card ends in
  "Make a recipe with this". They show their sensitivity and a "try it" readout. Put them in the recipe editor's device
  step (with the try-it readout) or under a "Devices" disclosure on Recipes. 14 → 13 entries.

**18. Improve: Labelling toolbar and save row.** *Improve, M*
- Files: `features/labelling/LabellingPage.tsx`.
- Why:
  - "Open CSV…" and "Open folder…" sit next to the recording picker every day, but they are for files from elsewhere,
    which Datasets already imports. Move them into a "More ▾" menu.
  - The view options row (graph height ×3, snap, scale ×2, one checkbox per column) is set once. Put them under a
    "View ▾" popover.
  - "Keep it" has four buttons plus the export settings card. Keep "Save" as the primary button; put "Save as new
    recording", "Export" and "Export to a folder…" (with the export setting) into an "Export ▾" menu.

**19. Merge: Gesture library's "Model against camera" with Model Lab's Activity.** *Merge, M*
- Files: `features/gestureLibrary/AgreementPanel.tsx`, `features/model-lab/components/DetectionActivity.tsx`.
- Why: both compare what the active models detect against the camera. Activity has the camera view and miss-marking;
  AgreementPanel has the counts and delay. One panel with both would leave the Gesture library about defining camera
  gestures only.

**20. Improve: Drone page groups flying and options.** *Improve, M*
- Files: `features/drone/DronePage.tsx`.
- Why: 25 buttons and four caution paragraphs on one screen. Keep in view: Connect, Arm, Take off, Land, and a large
  Stop. Fold under "Flight options": trim, headless mode, return home, axis reversals, hold-after-takeoff. Keep each
  caution to one sentence beside its control; the rest goes to `help`. It stays in the sidebar as the demo goal.

**21. Decide: three themes.** *Remove, M (needs your call)*
- Files: `shared/theme/theme.ts`, `features/settings/components/AppearanceSection.tsx`, `nerv-theme.css` (764 lines),
  `app/components/NervBars.tsx`, `NervSelectMenu.tsx`, `features/dashboard/components/NervTelemetryPanel.tsx`.
- Why: Neo-brutalism, Electric and NERV each need every new screen checked three times, and NERV adds its own bars,
  select menu and telemetry panel. If you use only one, keeping the other two costs time with every UI change. This is
  your choice; nothing is proposed without your answer.

### Train panel (report only: the CNN v2 work in progress is not touched)

`features/model-lab/components/TrainPanel.tsx` and `training.ts` have uncommitted CNN v2 changes, so they are not part
of this round. To do once that work is committed:

- **T1.** Each model option shows a 90–130-word research paragraph (the same text as Network lab). Show one line ("Fires
  ~0.5 s after a pinch starts; catches more than the trees") and put the figures behind "Details".
- **T2.** "Learn from its own false alarms", "Also run research checks", "Train in stages" and Label timing are options
  you set rarely. Put them under one "Options" disclosure, with a one-line summary when any is on.
- **T3.** "Add a label first (see Labels below)": Labels is not below; it is a sidebar page (and inside Advanced). Say
  "Add a label on the Labels page."
- **T4.** The help text says the result "is a Draft: it does nothing until you approve and activate it". Update it when
  item 15 lands.
- **T5.** Once CNN v2 has proved itself live, consider dropping the trees from the menu, or listing them under
  "Older models", so the choice is between two.

## What to leave alone

- The "Make a model" fold in the sidebar, the readiness light and the miss marker: small, and used.
- Labelling's keyboard-first review (Enter / X / N / P, `[` `]` for problems): the fastest part of the app.
- The Live confirmation and "a restart comes back in Monitor": a safety rule, not clutter.
- Model Lab's Advanced section: already folded, and holds the research tools (history, mistakes, threshold, compare,
  sealed test).
- Gestures page: long, but it is a try-it page that is read when needed.

## If all of Tier 1 and 2 are done

- Sidebar: 17 entries → 14 (Network lab, Recordings, Live signals go; with item 17, 13).
- Settings: about 5,700 px → about 2,500 px, with rarely changed fields folded.
- Watch: about 2,950 px → about 1,200 px.
- Recorder: one session card at a time; every Start button above the fold.
- Daily pages (Recorder, Labelling, Model Lab) on ⌘2–⌘4, and the runtime switch one click from any page.

## Suggested order

1. Tier 1 (items 1–8), on one branch, one commit per item. Mostly removals and wording, low risk to tests.
2. Items 13 and 14 (Settings, Watch): folding only, no behaviour change.
3. Items 9–12 (merging pages). Each changes navigation, so one at a time.
4. Item 15 after the CNN v2 work is committed (it may touch `crates/label-inference`).
5. Tier 3 as wanted; item 21 only on your answer.
6. T1–T5 once `TrainPanel.tsx` is free.
