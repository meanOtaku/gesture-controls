# UI consistency contract and surface inventory (M0)

**Status:** Accepted as the target contract for `.hermes/plans/ui-consistency-remediation.md` milestones M1–M5.
**Scope:** `apps/desktop` visual layer only — typography, spacing, card, button, toggle/select/radio alignment. No behavior, telemetry flow, or accessibility-label changes implied by this document.

This document is the M0 deliverable: it does not change source. It records (1) the current-state findings that motivate the migration, (2) the target token/primitive contract that M1–M5 must converge on, and (3) a categorized inventory of bespoke desktop surfaces.

## 1. Current-state findings

### 1.1 Duplicate/conflicting theme layers in `styles.css`

`apps/desktop/src/styles.css` (217 lines) defines the shadcn/Tailwind CSS variable contract three separate times, each overriding the last at cascade order, not through the `@theme`/`.dark` mechanism the shadcn primitives expect:

- Line 7: an original shadcn scaffold `:root` block (`oklch(...)` light-theme values — `--background:oklch(1 0 0)` etc.) that no longer reflects the shipped dark UI at all.
- Line 158: a second `:root` block (`GC-007`) overriding the same variables with the real dark-theme hex values.
- Line 188: a `.dark { ... }` block (mostly) restating the same GC-007 values a third time.
- Line 214: a fourth partial override (`GC-008`) forcing `--border`/`--input`/`--ring`/`--sidebar-border`/`--sidebar-ring` to one flat `--electric-blue` value on both `:root` and `.dark`.

Net effect: four sources of truth for the same handful of CSS custom properties, in a file that also carries ~120 bespoke class selectors. `--radius` is likewise declared three times (`0.625rem` at line 7, then two conflicting `@theme inline` recomputations at lines 184 and 186 — the second entirely supersedes the first without removing it).

### 1.2 Typography is split across two systems with no single hierarchy

- **Global CSS declares raw sizes per element/class**: `h1 { font-size:clamp(2rem,5vw,4.3rem) }` (line 13), `.overview-card strong { font-size:1.35rem }` (line 14), `.device-card .rate span { font:500 2.4rem/1 DM Mono }` (line 16), `.metric strong { font:500 1.8rem DM Mono }` (line 17), `.volume-knob__value strong { font:600 3.4rem/1 DM Mono }` (line 22), `.lab-summary strong { font-size:1.8rem }` (line 116), `.signal-heading h2 { font-size:1.65rem }` (line 82), `.telemetry-chart-heading h2 { font-size:1.08rem }` (line 89), `.model-lab-shell .calibration-heading h2 { font-size:1.35rem }` (line 124).
- **shadcn primitives declare their own scale independently**: `CardTitle` is `text-base` (1rem) `font-medium` (`card.tsx:40`); `Button` text is `text-sm` (`button.tsx:6`); `CardDescription` is `text-sm text-muted-foreground` (`card.tsx:52`).
- No shared semantic role (page title, section title, card title, body, label, metadata, numeric/telemetry) is expressed as a reusable utility or token. The same semantic role (e.g. "card title") renders at four unrelated sizes depending on whether the surrounding markup is a bespoke `.overview-card`/`.metric`/`.lab-summary` div or a shadcn `<CardTitle>`.
- Font family is declared per-rule instead of inherited: `Manrope,system-ui` for UI chrome, `DM Mono,monospace` for numeric/telemetry values, both hardcoded string literals repeated at least 9 times across `styles.css` rather than referencing the single `--font-sans` custom property already defined at line 184.
- `.label`/`.eyebrow` (line 13) apply a bespoke uppercase/letter-spaced treatment with its own `.72rem`/`700` weight that has no shadcn counterpart (`Label` in `components/ui/label.tsx` is plain, un-uppercased).

### 1.3 Spacing has no shared scale

Card/section padding values found in `styles.css` alone: `20px 24px`, `22px 24px`, `24px`, `26px`, `22px`, `20px`, `18px`, `16px`, `12px`, `9px 13px`, `10px 15px`, `9px 12px`, `10px 12px`. Gaps: `32px`, `24px`, `20px`, `18px`, `16px`, `14px`, `12px`, `10px`, `8px`, `6px`, `4px`. None of these derive from a declared scale; each selector picks its own pixel value. Meanwhile the shadcn `Card` primitive already exposes a spacing token — `--card-spacing` (`card.tsx:14`, `4` = 1rem default, `3` = 0.75rem for `size="sm"`) — that none of the bespoke `.recording-card`/`.overview-card`/`.calibration-card`/`.lab-summary>div`/`.metric` selectors reference.

### 1.4 Two parallel card systems

- **shadcn `Card`** (`components/ui/card.tsx`): `rounded-xl`, `ring-1 ring-foreground/10`, `bg-card`, `py-(--card-spacing)`, used directly by `CalibrationPanel.tsx`, `DatasetCaptureCard.tsx`, `WatchSensorControls.tsx`, `ModelLab.tsx` (partially — see 3.4).
- **Bespoke hand-rolled "cards"**: `.recording-card`, `.overview-card`, `.device-card`, `.settings`, `.calibration-card`, `.watch-card`, `.setup-card`, `.connection-help`, `.lab-summary>div`, `.preview-notice` (`styles.css` lines 12, 14, 16, 20, 30, 109, 114) each independently declare `border`, `border-radius` (`16px`–`22px`, never `var(--radius)`), and background gradient/flat-fill, so radius and border-color drift per surface even after the GC-008 flat electric-blue border unification (line 215) patched *colors* but not radius/padding.

### 1.5 Buttons: three competing implementations

1. **shadcn `Button`** (`components/ui/button.tsx`): `h-8` default / `h-9` (`lg`) / `h-7` (`sm`) / `h-6` (`xs`), `rounded-lg`, variant-driven color. Used in `CalibrationPanel.tsx`, `DatasetCaptureCard.tsx`, `ModelLab.tsx` (label-mapping/inference-mode rows).
2. **`.recording-actions button`** (`styles.css:11`, `78`): custom `border-radius:10px`, `padding:9px 14px`, `font:600 .8rem Manrope`, `min-height:40px` — visually close to but numerically distinct from shadcn `Button lg` (`h-9` = 36px vs. this `min-height:40px`).
3. **`.model-lab-shell button` / `.model-lab-lifecycle-actions button` / `.calibration-actions button` / `.setup-steps button` / `.signal-filters button`** (`styles.css:20, 21, 39, 84, 127`): four more independent button rulesets, each with its own radius (`9px`–`14px`), padding, min-height (`38px`/`82px`/none), and font-weight, none referencing the shadcn `buttonVariants` scale.

`CalibrationPanel.tsx` additionally nests a `<small>` status line *inside* a shadcn `<Button>` (lines 69–70, 78–79 of `CalibrationPanel.tsx`), stretching the button's height past its `h-8` variant and breaking the standard button baseline — a concrete instance of the "misaligned buttons" symptom.

### 1.6 Toggle/switch alignment

`WatchSensorControls.tsx` composes the shadcn `Switch` (fixed `18.4px`×`32px` track) inside the bespoke `.vector-row.sensor-toggle-row` flex container (`styles.css:18`), next to a bespoke `.label` (uppercase, `.72rem`) and a plain unstyled `<span>` status. There is no shared "label + status + control" row primitive — each surface (`sensor-toggle-row`, `model-lab-backend-select>label` radio rows at `styles.css:140`, `.model-lab-label-row` at `styles.css:21`) reimplements label/control alignment with different `align-items`/`gap` values (`center`/`12px` vs. `flex-start`/none vs. `flex-wrap`).

### 1.7 Selects/inputs bypass the shadcn primitive entirely

`Dashboard.tsx`'s "Connection details" section and the calibration threshold/dwell inputs use the shadcn `Input` component, but `.telemetry-shell select` / `.model-lab-shell select` (`styles.css:76`) and `.dataset-card select` (`styles.css:77`) style raw `<select>` elements with hand-rolled `border`/`radius`/`min-height:40px`, never importing `components/ui/select.tsx` (`SelectTrigger` is `h-8`/`h-7`). No inventoried surface below currently uses the shadcn `Select`, `RadioGroup`, or `RadioGroupItem` for its literal form controls except `ModelLab.tsx`'s backend picker, which uses raw `<input type="radio">` styled by `.model-lab-backend-select` rather than `RadioGroup`/`RadioGroupItem`.

## 2. Target contract

This is the fixed reference M1 (tokens), M2 (layout/card rhythm), and M3 (controls) implement against. M0 defines it; it does not yet exist in source.

### 2.1 Semantic typography roles

| Role | Target | Rationale |
|---|---|---|
| Page title (`h1`, e.g. "Control center") | `text-3xl md:text-4xl font-semibold tracking-tight` (single non-`clamp` responsive step, `font-sans`) | Replaces the unbounded `clamp(2rem,5vw,4.3rem)` with a predictable two-breakpoint scale |
| Section title (`h2`, panel/dialog headings) | `text-lg font-semibold tracking-tight` | Collapses `1.08rem`–`1.65rem` scatter into one size |
| Card title (`CardTitle`) | shadcn default: `text-base font-medium` (`card.tsx:40`) — adopt as-is, stop overriding per-surface | Already correct; the fix is everyone else converging on it |
| Body | `text-sm text-foreground` | Matches `Button`/`CardDescription` existing `text-sm` |
| Label (form/field label, uppercase eyebrow retained only for the page eyebrow) | `text-xs font-medium text-muted-foreground`, no forced uppercase outside `.eyebrow` | `.label`'s uppercase treatment is folded into a single `Eyebrow` role, not reused for every inline label |
| Metadata (`<small>`, counts, timestamps) | `text-xs text-muted-foreground` | Removes ad hoc `.72rem`–`.85rem` spread |
| Numeric/telemetry value | `font-mono text-2xl font-medium tabular-nums`, one size regardless of surface | Replaces the `1.8rem`/`2.4rem`/`3.4rem` per-surface spread; large hero numerics (volume knob) are a documented exception (2.4) |

Font stack: keep `--font-sans` (`Manrope, "Avenir Next", Avenir, "Segoe UI", system-ui, sans-serif`, already declared at `styles.css:184`) as the only sans source; keep one monospace stack (`"DM Mono", monospace`) exposed as `--font-mono` instead of the 9 inline repetitions. M1 removes the raw `Manrope`/`DM Mono` string literals from every selector except the two token declarations.

### 2.2 Spacing scale

One scale, expressed as Tailwind spacing utilities / the existing `--spacing()` custom-property function, reused everywhere instead of ad hoc pixel values:

| Token | Value | Applies to |
|---|---|---|
| `page` | `space-y-8` (32px) between major page sections (hero → content) |
| `section` | `space-y-4` (16px) between cards within a section/grid |
| `card` (external gap in grids) | `gap-4` (16px), matching shadcn `--card-spacing` default |
| `card-internal` (padding) | shadcn `--card-spacing` (`4` default / `3` for `size="sm"`) — bespoke cards adopt the `Card` primitive instead of redeclaring padding |
| `control-row` (label+control row internal gap) | `gap-3` (12px) |
| `inline-control` (button/icon/tooltip gap within one control cluster) | `gap-2` (8px) |

Every bespoke `padding:`/`gap:` declaration enumerated in 1.3 is a candidate for replacement with one of these six tokens; M2/M3 pick the nearest token rather than preserving the original bespoke value.

### 2.3 Card variants

- **`Card` (default)**: standard content card — dashboard overview cards, telemetry capture cards, Model Lab panels. `rounded-xl`, `ring-1 ring-foreground/10`, `bg-card`, default `--card-spacing`.
- **`Card size="sm"`**: compact card for dense grids (e.g. per-sensor rows, small metric tiles) — reduced `--card-spacing` (`3`).
- **Inline/no-chrome section** (e.g. `fieldset.lab-workspace`, `<details>` disclosure bodies): no border/background of its own; relies on child `Card`s for chrome. Not a new primitive — a documented "cards may sit directly on the page background" rule.
- Bespoke gradient backgrounds (`linear-gradient(120deg,#121a2acc,#101321dd)` etc., still present at `styles.css:12,14,16,20,30`) are retired in favor of flat `bg-card`, matching the GC-007/GC-008 direction the codebase has already been moving toward (flat, opaque surfaces per the `styles.css:157` comment).

### 2.4 Documented intentional exceptions (not migrated)

- **Overlay volume knob** (`.volume-knob*`, `styles.css:22`): circular, animated, transparent-window chrome. Per plan M4.4, preserved as deliberate visual design; only its typography *role* (numeric/telemetry) should align in scale intent, not its literal 3.4rem size.
- **Telemetry chart SVG grid/plot styling**: signal visualization, not a control or text surface: out of scope for token migration beyond using shared border/background tokens.

### 2.5 Standard row patterns

- **Label + control** (e.g. sensor toggle, radio option): `flex items-center justify-between gap-3` (uses `control-row` token); label uses the Label typography role; control is the shadcn primitive (`Switch`, `RadioGroupItem`) at its default size — no bespoke wrapper restyles the primitive's own height.
- **Action group** (button clusters: recording actions, lifecycle actions, deployment actions): `flex flex-wrap items-center gap-2` (uses `inline-control` token); every button is a shadcn `Button` at one shared `size` per row (default `size="default"`, `h-8`, unless the row is explicitly compact, in which case the whole row uses `size="sm"`, `h-7` — never mixed within one row).
- **Status + action** (e.g. calibration target state + capture button, dataset session status + start/stop): status text/pill precedes the action(s), `flex items-center justify-between gap-3`; status text uses `Badge` (`components/ui/badge.tsx`) instead of the bespoke `.target-state`/`.model-lab-chip` pill classes.
- **Responsive wrapping**: any action group or row that can overflow on compact width uses `flex-wrap` with the row's own gap token (never a `@media` override that changes the gap value, as `styles.css:23,49,146,150` currently do per-breakpoint).

### 2.6 Minimum control heights and baseline alignment

| Control | Target height | Source |
|---|---|---|
| `Button` (default row) | `h-8` (32px) | `button.tsx:23` |
| `Button` (compact row) | `h-7` (28px), `size="sm"` | `button.tsx:25` |
| `Switch` | `18.4px` track (default) | `switch.tsx:15` |
| `Select` (`SelectTrigger`) | `h-8` default / `h-7` `size="sm"` | `select.tsx:43` |
| `RadioGroupItem` | `size-4` (16px) | `radio-group.tsx:23` |
| `Input` | matches `Button` default (`h-8`) for same-row alignment | existing `components/ui/input.tsx` (verify in M1) |

Rule: within one row, every interactive control uses the same size variant so their vertical centers align on `items-center`; text/labels next to a control use `leading-none` or the control's matching line-height so baselines don't drift (the `CalibrationPanel.tsx` pattern of a `<small>` stacked inside a `Button` is the concrete anti-pattern this rule forbids — status text belongs beside or below the button, not inside it, per 2.5's "status + action" pattern).

## 3. Surface inventory

Categories: **token-only** (visual values need remapping to the token scale, structure is fine), **layout-only** (container/spacing structure needs to change, not colors/type), **primitive-composition** (already uses shadcn primitives but wraps them in bespoke chrome that fights the primitive), **special** (intentionally distinct, documented exception, not migrated).

### 3.1 Global

| Surface | File | Category | Notes |
|---|---|---|---|
| Theme tokens | `src/styles.css:7,158,188,214` | token-only | Collapse 4 redundant `:root`/`.dark` blocks into 1; owned by M1 |
| Base typography (`h1`,`h2`,`.eyebrow`,`.label`,`.subtitle`) | `src/styles.css:13` | token-only | Replace with semantic roles (2.1) |
| `.app-tabs` (top nav) | `src/styles.css:11,27,50,161`, `src/app/components/AppNav.tsx` | layout-only | Keep sticky/scroll behavior; adopt `Tabs`/`TabsList` sizing if feasible in M3 |
| `.shell` page container | `src/styles.css:10,29` | layout-only | Candidate for the `page` spacing token (2.2) |

### 3.2 Dashboard / Setup (`src/features/dashboard/`)

| Surface | File | Category |
|---|---|---|
| Hero header, `.connection` pill, `.overview-grid`/`.overview-card` | `Dashboard.tsx`, `OverviewSection.tsx`, `styles.css:13,14,15` | token-only |
| `CalibrationPanel` card + `.calibration-actions` button/label grid | `CalibrationPanel.tsx`, `styles.css:20` | primitive-composition (shadcn `Card`/`Button`/`Label`/`Input` already used; bespoke `.calibration-actions` grid and in-button `<small>` fight the control-row/action-group patterns in 2.5–2.6) |
| `.target-state` pill | `CalibrationPanel.tsx:44`, `styles.css:20` | token-only (replace with `Badge`, 2.5) |
| `WatchSensorControls` (`.vectors`/`.vector-row.sensor-toggle-row`) | `WatchSensorControls.tsx`, `styles.css:18` | primitive-composition (shadcn `Card`/`Switch` used; row wrapper is bespoke — target: label+control pattern, 2.5) |
| `MetricRow`, `.metric-grid`/`.metric` | `MetricRow.tsx`, `styles.css:17` | token-only |
| `HeadphoneTelemetryPanel`, `WatchTelemetryPanel`, `WatchWellnessPanel` (`.vector-row`, `.vectors`) | respective `.tsx`, `styles.css:18` | token-only |
| `.setup-card`, `.setup-steps`, `.step-number`, `.connection-help` (Setup flow, rendered inside `Dashboard.tsx`'s "Connection details" `<details>`) | `Dashboard.tsx:142-151`, `styles.css:30-46` | layout-only + token-only (custom `<details>`/numbered-step layout has no shadcn equivalent; padding/radius/type should still adopt 2.1–2.3) |

### 3.3 Live Telemetry / Dataset Capture (`src/features/telemetry/`)

| Surface | File | Category |
|---|---|---|
| Hero + `.stream-status` | `LiveTelemetry.tsx`, `styles.css:66-70` | token-only |
| `CsvCaptureCard` (shadcn `Card`/`CardHeader`/`CardTitle`/`CardContent`/`Button`/`Progress` already used) | `CsvCaptureCard.tsx` | primitive-composition (cleanly composed; no bespoke chrome class found — verify against action-group button sizing in M3) |
| `DatasetCaptureCard` (`Card`/`CardHeader`/`Tabs`/`Button`/`AlertDialog` already shadcn) | `DatasetCaptureCard.tsx` | primitive-composition (mostly clean — already the best-aligned surface in the app; verify action-group button sizing consistency against 2.5 in M3) |
| `SignalMonitor` (`.signal-heading`, `.signal-filters`, `.signal-grid`, `.telemetry-chart*`, `.chart-*`) | `SignalMonitor.tsx`, `TimeChart.tsx`, `styles.css:80-101` | special (chart plot/grid) + token-only (heading/filter chrome) |
| `WellnessCapturePanel` (`.wellness-panel` disclosure) | `WellnessCapturePanel.tsx`, `styles.css:102-106` | layout-only |
| `RecordingTimelineEditor` | `RecordingTimelineEditor.tsx` | not yet inventoried in detail — defer to M4 slice 2 for a focused pass |

### 3.4 Model Lab (`src/features/model-lab/`)

| Surface | File | Category |
|---|---|---|
| Hero, `.preview-notice`, `.lab-summary`, `.lab-workflow`, `.lab-workspace`, `.lab-reference` | `ModelLab.tsx`, `styles.css:108-121,137-138` | token-only |
| Label-mapping / import-bundle / inference-diagnostics cards (shadcn `Card`/`CardHeader`/`CardContent`/`Button`/`Badge`/`Alert`) wrapping bespoke `.recording-actions`, `.vectors.model-lab-models`, `.vector-row.model-lab-label-row` | `ModelLab.tsx:512-624` | primitive-composition |
| `ModelLifecycleControls` (`.model-lab-lifecycle-row`, `.model-lab-lifecycle-actions`, `.model-lab-state`) | `ModelLifecycleControls.tsx`, `styles.css:21` | token-only + primitive-composition (buttons likely shadcn already — confirm in M3) |
| `ModelRegistryTable`, `ReadinessPanel`, `ReplayPanel`, `TrainingPanel`, `DatasetManager`, `LabelMappingEditor`, `IntentBindingEditor` | respective `.tsx` under `model-lab/components/` | not yet inventoried in detail — each references one or more of `model-lab-*`/`lab-*`/`vector-row` classes (confirmed via grep); defer per-file categorization to M4 slice 3 |
| `.model-lab-shell button`, `.model-lab-shell select`, `.model-lab-backend-select` (raw radio) | `styles.css:127-144` | token-only (buttons/selects) + primitive-composition (backend picker should become `RadioGroup`/`RadioGroupItem` per 1.7) |

### 3.5 Settings (referenced by the same global styles; not a named M0 target surface but shares the token/button system)

| Surface | File | Category |
|---|---|---|
| `ApplySettingsFooter`, `WatchSensorSwitchSection`, `HeadphonesSettingsSection`, `RecordingGraphSettingsSection`, `WatchHealthDeliverySettingsSection`, `WatchRateSettingsSection`, `WristRotationSettings` | `src/features/settings/components/*.tsx` | token-only / primitive-composition mix — out of M0's four named surfaces; flagged for a defined M4 slice since it shares `.settings`, `.recording-actions`, and label/switch patterns with the inventoried surfaces |

### 3.6 Special / do-not-migrate

| Surface | File | Category |
|---|---|---|
| `VolumeKnob` overlay | `src/features/overlay/components/VolumeKnob.tsx`, `styles.css:22` | special (documented exception, 2.4) |

## 4. Deferred gates

Per the standing task instructions, the following are explicitly deferred and not run as part of M0: automated tests, build, lint, type checks, and hardware/runtime validation. No such checks were executed to produce this document.
