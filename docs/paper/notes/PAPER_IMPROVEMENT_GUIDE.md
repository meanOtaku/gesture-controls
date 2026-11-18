# Paper improvement guide: contributions, missing evidence and next studies

**Prepared:** 17 November 2026

**Original evidence-review snapshot:** `2010e2837c65854275a58933e3836e28f5cafe62`

**Revision status reviewed against:** `a052f7b`, followed by the local shared-manuscript correction pass documented below. The status and follow-up checklist supersede the original future-tense suggestions where the manuscript now incorporates them. Historical evidence links remain pinned to their original snapshot.

**Purpose:** An editable revision companion for the IEEE paper, LNCS paper and project report—not a replacement manuscript, a new experiment, or a claim of research priority.

## Revision status — start here

A checked item means the manuscript now addresses the writing/reporting recommendation, not that a proposed experiment has been performed or a capability physically validated. Unchecked items remain open. R1–R7 have now been applied to the shared manuscript and rebuilt in all three formats. The dissertation's registered title is unchanged. Empty inventory/user-guide appendices were replaced with documented content; missing institutional dates and prescribed certificate wording remain explicit placeholders.

### Incorporated in the revised manuscript

- [x] **§1 — Prior-work positioning:** distinguish μDPad's custom spatial-PPG hardware from the commercial watch while acknowledging interaction overlap and commercial-watch precedents (`sections/02-related-work.tex`).
- [x] **§2.1 — Systems contribution:** describe recognition, sustained control and cancellation separately; distinguish head targeting from eye tracking and camera-assisted annotation from camera-independent use (`sections/01-introduction.tex`, `03-system-design.tex`). The abstract's remaining guarantee is tracked below.
- [x] **§2.2 — Offline-to-live investigation:** include motion-contaminated scaling, representative training data and context-dependent failures (`05-detection-method.tex`, `06-results.tex`, `07-discussion.tex`). Interpretation still needs the wording corrections below.
- [x] **§2.3 — Evidence-aware evaluation:** retain effective-label rules, exact-source duplicate audit and the finding of no shared stream in the original split; distinguish leakage risk from demonstrated score inflation (`04-annotation-audit.tex`).
- [x] **§3.1 — Motion-history intervention:** add the mechanism, parameters, recovery counts and explicit splice/peak-window limitations. The detailed figure is report-only; the conference text gives a condensed account.
- [x] **§3.2 — CNNv2:** add architecture, input grid, jerk channel/gate, augmentation, context-specific counts and reused-benchmark limitations. Detailed architecture/component discussion is report-only.
- [x] **§3.3 — Paired detectors:** report both transitions separately and disclose that only an archived summary was recovered. Full provenance recovery remains open.
- [x] **§3.4 — Four-class experiment:** include accuracy versus balanced accuracy/event reliability, delayed-state target, weak hold recall and fixed-split seed limitations. The decision confusion figure appears in LNCS/report, not IEEE.
- [x] **§3.6 — Haptic confound:** discuss the feedback-loop hypothesis and disclose that no motor-aligned causal study has been completed (`07-discussion.tex`, `08-prospective-protocol.tex`).
- [x] **§4 — Protocol distinctions:** explicitly separate 300–900 ms paper replay from 100–900 ms application accounting and distinguish onset, delayed-state and interaction outcomes. Add the same-cohort current-model comparison without merging generations.
- [x] **§5 — Future-study plans:** describe matched modalities/preprocessing, physical motion/haptics, prospective participants/refits, complete tasks/faults and headset comparisons as planned, not measured (`08-prospective-protocol.tex`). Execution remains unchecked below.
- [x] **Reproducibility assets:** add `../codex-assets/` and `../replay-assets/` with saved evidence and regeneration/replay instructions. The newer application model's Model Lab files are not bundled, so this is not complete independent reproduction of that model.

### Applied manuscript corrections from the revision review

- [x] **R1 — Abstract: remove the unwanted-command guarantee.** In both branches of `../manuscript/abstract.tex`, replace “stop a missed or spurious detection from becoming an unwanted command.” Suggested wording: “Separate pinch-start and pinch-release detectors and explicit cancellation paths separate recognition from sustained actuation and provide ways to terminate a grab.” A spurious eligible start can still initiate an unwanted grab; cancellation is not guaranteed prevention.
- [x] **R2 — Limitations: identify models and source eras explicitly.** In `sections/09-limitations.tex`, attribute reconstructed specifications/missing original provenance to `pinch_in-ae0a22bf`, rather than ambiguously to the “latest/current” model. Separately describe the newer application's stored run specification and any remaining missing files. Scope snapshot `6709b2a` to the original audit, not all later experiments. Check the Results and conference branches for the same distinction.
- [x] **R3 — Results: correct the zero-false-activation threshold wording.** In `sections/06-results.tex`, the strictest swept threshold, 0.999, gives 39/57 pinch-ins, 52/59 pinch-outs and **30/56** hold entries. Hold entry reaches **35/56 at 0.995**, also with zero observed false activations. If retaining 39/57, 52/59 and 35/56 together, describe them as the highest catches among the swept zero-observed-FA thresholds, not one strictest threshold. These are descriptive evaluation sweeps, not deployment selections (`../replay-assets/replay-sweeps.json`).
- [x] **R4 — Results: locate threshold-sensitivity false events accurately.** The everyday-activity recording peaks at about 0.970, but the additional event at 0.98 occurs in an **unlabelled interval elsewhere in the cohort**. At 0.95, one event occurs in everyday noise and one in an unlabelled interval. Clarify this in both Results branches so a 0.970 maximum is not implied to cross 0.98 (`../revision-assets/hand-labelled-replay.json`, `thresholdSweep.rows`).
- [x] **R5 — Title: align with the demonstrated scope.** Suggested `preamble-common.tex` title: **“Look, Pinch, Turn: Continuous Desktop Control with Unmodified Consumer Wearables.”** The present “from the Desktop to AR/VR” implies a demonstrated headset extension; “hands-free” is ambiguous when finger/wrist movement is required. The paper title has been applied; the registered dissertation title is preserved separately.
- [x] **R6 — Results/Discussion: qualify exploratory interpretations.** Replace “compare methods but are not results” with “exploratory development results rather than independent performance estimates.” Replace “differences of one to three pinches are within chance” with a statement that the small single-session sample does not support a confident ranking, unless a suitable uncertainty analysis is supplied. Scope claims that representative data mattered more than architecture to the explored configurations on the reused benchmark, including the shortened conference text.
- [x] **R7 — Build documentation and figure placement.** Update `../manuscript/README.md`'s stale approximate page counts: the corrected build produced **6 IEEE pages, 16 LNCS pages and 65 report PDF pages**, including references/front matter as applicable. Check the selected venue's actual limit. Keep LNCS confusion figures nearer their Results discussion rather than floating into the bibliography's page sequence; rebuild after changes. Page counts alone do not verify visual layout.

### Verification already completed for this review

- [x] Built the IEEE and LNCS papers in scratch from `a052f7b`: 6 and 15 pages respectively; no unresolved references or overfull boxes were reported. Missing template files were supplied in scratch, not added to the repository.
- [x] Independently replayed the original model with its historical trainer: 47/57 catches, zero false activations, median 441.999872 ms; threshold 0.98 adds one false event and 0.95 adds two.
- [x] Checked the newer model's committed threshold sweep and event-confusion implementation against the reported figures.
- [ ] Independently replay the newer application model with its actual weights and run files. The documented Model Lab location was absent on this host; checking committed outputs is not an independent weight replay.
- [x] Rebuilt all three corrected variants: IEEE 6 pages, LNCS 16 pages, report 65 physical PDF pages. No unresolved references or overfull boxes were reported. Verified that LNCS event confusion appears on page 11, before Discussion on page 12. LNCS retains its template's amsmath vector-accent warning. This is build/text/float-order verification, not a claim of exhaustive visual inspection.
- [ ] Supply the report's submission month/year, declaration date and any prescribed institutional certificate wording. Do not invent these details.
- [ ] Confirm the actual selected venues' page limits and submission requirements.

## Reading order

```text
Establish the closest prior work and hardware differences
                         ↓
Separate supported contributions from engineering capabilities
                         ↓
Add completed findings with their original protocols and limitations
                         ↓
Run matched ablations and complete-interaction studies
                         ↓
Freeze the system, collect prospective data, revise the claims
```

The central recommendation is to tell a story about **implementing and evaluating reliable continuous control on unmodified consumer wearables**, not about inventing PPG gesture recognition or the pinch–rotate interaction.

Evidence in this document has three statuses:

- **Established in the current manuscript:** already reported, subject to its stated limitations.
- **Implemented or explored:** source code or saved results exist; this does not automatically mean a validated research contribution or a deployed model.
- **Proposed:** requires new measurements. No proposed experiment below was performed to prepare this guide.

The positioning is based on the closest works checked, not an exhaustive literature search or proof that no earlier system has a particular capability.

## 1. The μDPad distinction: overlap does not mean identical hardware

### What μDPad actually uses

Hauptmann et al.'s **μDPad** is a purpose-built wrist-worn prototype, not an off-the-shelf smartwatch. Section 3.1, “Sensing Hardware,” describes a QMI8658 six-axis IMU on a Waveshare ESP32-S3-LCD board and a second XIAO ESP32-S3 microcontroller. The paper describes an eight-channel **spatial** PPG configuration [P1].

Our system uses the built-in IMU and green/red/infrared PPG streams of a commercial Samsung Galaxy Watch, accessed through software, without adding a custom optical sensing assembly. This does not mean every commercial watch exposes equivalent raw data: supported devices, SDK access, actual delivered sample rates and transport limitations must be stated [E1].

**Eight spatial optical channels are not the same thing as three wavelength channels.** Do not compare channel counts as though the sensing geometries and information content were interchangeable. Likewise, a 100 Hz model grid does not prove that every physical sensor delivered independent samples at 100 Hz.

### What overlaps

μDPad explicitly includes pinch close/open and wrist rotation for continuous control during a pinch. It also describes continuous recognition and interactive prototypes [P1]. Gaze + Pinch already separates looking for target selection from hand gestures for manipulation [P2].

Therefore:

- The pinch–grab–rotate–release concept alone is not our invention.
- The optical/inertial sensor combination alone is not our invention.
- Continuous recognition alone is not a sufficient distinction from μDPad.
- Implementing related interaction with an **unmodified commercial watch** is a meaningful hardware/deployability distinction **against μDPad**.
- That distinction does not establish first use of commercial-watch PPG for gestures: FinDroidHR and OpenWatch must also be considered [P3, P4].

### Suggested Related Work wording

> μDPad investigates optical–inertial microgesture recognition using a purpose-built wrist-worn prototype with spatial PPG sensing, including pinch close/open and wrist rotation for continuous control. We investigate related interaction using the built-in optical and inertial sensors of an unmodified commercial smartwatch, integrated with consumer headphone head tracking and laptop-side inference. Our distinction is the consumer-device implementation and its continuous sensing-to-action evaluation, rather than the underlying pinch–rotate interaction concept.

This is proposed positioning, not evidence that our system outperforms μDPad. Their sensing hardware, participant pool, data and endpoints differ; their reported accuracy or false-positive percentage cannot be ranked directly against our event recall and false activations per negative hour.

## 2. What we can credibly contribute

### 2.1 An integrated consumer-device sensing-to-action system

The implemented pipeline combines headphone head orientation, watch PPG/IMU, laptop inference, target selection and bounded actuation [E1, E2]. Its design separates brief recognition events from sustained interaction state:

- A fresh pinch-in starts a grab only in an eligible target context.
- Wrist rotation changes the controlled value relative to the grab reference.
- A separate release ends the grab; classifier silence is not treated as release.
- Explicit cancellation handles stale/rejected input, leaving the target, mode changes and model replacement.
- Monitor mode does not actuate; saved Live mode is lowered to Monitor on startup.

These are meaningful systems decisions. They are not a safety certification, a guarantee of zero unwanted actions, or a substitute for physical fault trials. Complete-task measurements are needed to demonstrate their practical value.

Use **head-directed selection**, not eye tracking. Use **camera-independent normal operation**, not camera-free data collection: the project uses camera-assisted reference annotation.

### 2.2 An empirical investigation of the offline-to-live gap

The most promising explanatory contribution is identifying why good-looking classifier results fail during actual interaction:

- Movement contaminates normalisation history and suppresses later pinches.
- Training gestures differ from pinch–hold–turn–release use.
- Brief pinches and unfamiliar wrist contexts create misses.
- Everyday motion and actuator vibrations can resemble gesture signals.
- Missing or insufficient input creates periods when the detector cannot score.

The scientific value lies in demonstrating these failure mechanisms, measuring their effects and validating the remedies—not merely listing robustness features.

### 2.3 Evidence-aware evaluation and dataset provenance

The current manuscript already audits effective labels and duplicate exports and evaluates whole recordings [E3, E4]. Retain that contribution, but describe it accurately:

- The historical audit found 37 exports representing 28 distinct sensor-stream pairs.
- The audited hand-labelled pinch-in split did **not** share a stream between its 20 training and 8 evaluation recordings.
- The discovery therefore demonstrates a leakage risk and the need for source grouping; it does not demonstrate that those duplicates inflated that particular reported result.
- These are historical snapshot counts, not automatically the inventory of today's expanded dataset.

The strongest methodology result would quantify how source grouping, annotation versions, availability accounting or temporal rules change a conclusion. Implementing standard safeguards is not itself proof of a novel evaluation method.

## 3. Completed work to add or develop in the paper

### 3.1 Motion-aware normalisation

**Status:** Implemented and supported by exploratory replay studies [E5].

The manuscript discusses median/MAD scaling and movement-related limitations, but underdevelops the later intervention: excluding fast-wrist-motion history from the statistics used to scale subsequent inputs. This is not the same as dropping the current input window or suppressing all decisions during motion.

The saved study identifies long post-motion blind spots with rolling scaling. Median scaling improves shorter bursts, while excluding contaminated history improves recovery after longer bursts. Quiet evaluation replays remain unchanged in the reported before/after comparison.

**Add:**

1. A diagram showing movement contaminating the history, shrinking the normalised pinch, and the corrected history selection.
2. A matched comparison: rolling statistics, median/MAD, and motion-filtered median/MAD.
3. Detection versus time since movement ended, together with false activations during ordinary movement.

**Limitations:** The reported perturbation experiments splice recorded motion into recordings. They are not equivalent to physically moving the watch, changing strap pressure and immediately pinching. Several parameter values were explored, so the exploratory recordings cannot become an untouched confirmatory test. Pinch-out does not have the same full splice study as pinch-in. Robust statistics and movement rejection are not novel in isolation.

### 3.2 CNNv2 and the component studies

**Status:** A newer implementation exists; offline experiments compare components [E6, E7].

The historical manuscript describes a nine-channel, 50 Hz, single-stack CNN. The newer implementation uses a 100 Hz input grid, an additional acceleration-jerk-envelope channel, accelerometer/gyroscope/PPG branches, shared processing, augmentation and a jerk-based activation gate. The saved research also investigates MiniRocket, InceptionTime, input variants and ensembles.

A useful result is that making training examples representative of actual use was a larger lever than simply increasing the input-grid rate. One recorded CNNv2 configuration, at its training-selected operating point, caught:

- 13 of 20 live-style pinches.
- 80 of 102 moving pinches.
- 44 of 57 resting pinches.
- No everyday false activations in that benchmark's limited exposure.

**Add:** A small ablation with a clear question for each component: signal-rate representation, branch fusion, jerk envelope, augmentation and gate. Report both misses and unintended events; do not hide classifier weaknesses behind a gate.

**Limitations:** Some research tables use thresholds selected with test recordings. Those are exploratory operating-point analyses, not held-out headline scores. Repeated architectural exploration on one test cohort also makes it development evidence, even when a particular final threshold was selected without test labels. Do not claim zero long-run risk from zero events in a short replay.

### 3.3 Later paired pinch-in and pinch-out evidence

**Status:** Saved later results exist under a different training/evaluation loop [E8].

The later artifact reports:

- Pinch-in: 95/120 caught, 3.6 false activations/hour, median delay approximately 451 ms.
- Pinch-out: 96/127 caught, 3.4 false activations/hour, median delay approximately 434 ms.
- Both cut-offs were selected by the trainer under its training-side budget procedure.

**Add:** A separately versioned subsection reporting both transitions, with exact source groups, eligible exposure, event rules and model identities recovered from the underlying artifacts.

**Limitations:** Do not overwrite the manuscript's historical 47/57 result as though these were the same experiment. A trainer's “deployable” status means its configured checks passed; it does not establish general readiness for live use. Separate success on start and release does not establish successful complete grab–adjust–release cycles.

### 3.4 One four-class network

**Status:** An exploratory experiment exists outside the main repository [E9]. The application also has newer multi-gesture training/runtime support; do not assume the exploratory checkpoint is the model selected live.

The experiment predicts background, pinch-in, pinch-out and pinch-hold. Primary seed 17 reports:

- Overall accuracy: 95.73%.
- Balanced accuracy: 77.09%.
- Macro-F1: 77.84%.
- Pinch-hold recall: 49.93%.

Continuous replay reports approximately 13.31 false activations/hour for pinch-in, 21.75/hour for pinch-out and 46.30/hour for pinch-hold. Three independent seeds provide a stability check on this fixed split, not population confidence intervals.

**Add:** The confusion matrix and the discrepancy between high background-dominated accuracy and weaker operational behaviour. This is a useful finding even if the joint classifier is not the preferred controller.

**Limitations:** The experiment learns a deliberately delayed state target; the production binary models learn onset targets. It is not a matched binary-versus-multiclass superiority test. Entry into the hold class does not validate hold-duration accuracy. The cohort has been used in earlier project research, so it is not a newly collected untouched release test.

### 3.5 Research tooling, annotation and provenance

**Status:** Implemented capabilities, not automatically demonstrated scientific outcomes [E10, E11].

Describe the useful parts in the report or reproducibility supplement:

- Camera-assisted, reviewable intervals while retaining raw sensor data.
- Effective-label override/fallback/exclusion semantics.
- Miss capture with telemetry and scores.
- Dataset/model snapshots and source identities.
- Model continuation and parent-run provenance.
- Sealed-test support and a log of previous accesses.
- Threshold reset and inspecting model outputs.

Do not turn ordinary UI improvements into a scientific contribution list. A software seal does not make previously inspected recordings statistically untouched. Continued training does not establish successful continual learning or absence of catastrophic forgetting.

### 3.6 Haptic feedback as a closed-loop sensing confound

**Status:** Haptic-noise recording support and a new negative recording exist; a controlled causal study does not [E11, E12].

The newest reviewed commit adds an everyday-noise export described as “active, with knob-like buzzes.” The recording code supports preserving vibration timings because the watch actuator shakes the same device that supplies recognition inputs.

The question worth testing is:

> Can the system's own feedback cause a false detection and another action, and can we prevent that without masking a real release?

**Add now:** The rationale for representative negative collection, clearly labelled as implementation/data collection.

**Measure next:** Haptics-on versus haptics-off, exposure around each vibration, event timing and unintended actuation.

**Limitations:** The newly committed export has dataset metadata, PPG, IMU and clock files, not an explicit haptic-event file. Locate the original event log before claiming a time-aligned haptic analysis; the context description alone is insufficient. Do not describe actuator vibration affecting inertial sensing as an unprecedented phenomenon—ViBand and related bio-acoustic work make vibration an obvious prior consideration [P5].

## 4. Protocol differences to resolve before changing headline results

### 4.1 Temporal matching changed

The manuscript's historical matching window is 300–900 ms after a reference onset. A later code change uses 100–900 ms for CNN catches (`2317ef3`). This changes which emissions count as successful detections.

Either retain each historical result with its original protocol or replay compared methods under a common frozen protocol. A higher catch rate after changing the acceptance window is not automatically a better model.

### 4.2 Preserve the distinction between targets

Keep these separate:

- Classification of preselected windows.
- Continuous emission of onset events.
- Classification of a deliberately delayed gesture state.
- Entry into a hold state.
- Accuracy of physical hold duration.
- Successful completion of an interaction.

None can be substituted for another without explicit evidence.

### 4.3 Preserve the distinction between evidence eras

The manuscript describes a historical source snapshot. The current code and newer results need not invalidate it. For every added result, record:

- Model/checkpoint hash and source revision.
- Native stream characteristics and model-grid rate.
- Source-grouped train/validation/test assignments.
- Label version and loader semantics.
- Target definition and exclusions.
- Threshold/gate/persistence selection procedure.
- Matching window and refractory rules.
- Eligible gesture counts, scored negative exposure and unavailable time.
- Whether the data influenced earlier model or threshold choices.

Do not borrow one model's exposure or event denominator to explain another model's rounded percentages.

## 5. Prioritised studies: what would strengthen the paper most?

These are proposals, not completed studies. Start with the smallest experiment that answers the stated question; set participant and exposure requirements from precision goals and pilot variation rather than inventing a convenient sample size.

### Priority 1 — Complete interaction, not detector output alone

**Question:** Can a person deliberately select, grab, adjust and release a target without unacceptable unintended actions?

**Protocol:** Freeze the model and policy. Use repeated target-value tasks with fixed practice, timeout and success rules. Compare with a conventional control in counterbalanced order. Preserve detector, policy and operating-system output timestamps.

**Outcomes:** Successful complete cycles, missed grabs/releases, unintended adjustments, completion time, final-value error, retries and workload. Break latency into sensing, transport, scoring, policy acceptance and completed actuation. Distinguish event latency from completed-action latency.

**Fault trials:** Stream dropout, reconnect, target exit, model replacement and release during queued output. Measure cancellation; do not assume the implementation proves physical behaviour.

**What it establishes:** Practical value and limitations of the integrated system, which is currently more strongly claimed than directly measured.

### Priority 2 — Does PPG earn its place?

**Question:** Does PPG improve this system under its actual deployment constraints?

**Protocol:** Compare IMU-only, PPG-only and fused models on identical grouped data, with equivalent tuning allowances and threshold-selection rules. Then compare preprocessing choices without changing the split or event definition. Choose operating points on development data only.

**Outcomes:** Recall/latency at a common false-activation budget, per-context errors, compute cost and scored-time coverage. Report conditional gains, such as after refitting or in particular gestures, rather than assuming a universal fusion benefit.

**What it establishes:** Whether our multimodal design is empirically justified. A well-supported simpler IMU-only design is preferable to an unsupported PPG contribution claim.

### Priority 3 — Physical post-motion recovery and self-generated feedback

**Question:** Do the motion-history remedy and negative collection survive physical perturbations?

**Protocol:** First compare scaling methods after predefined real wrist movements, with pinches at predefined delays. Separately compare matched haptics-on/off trials with the actual actuator log. Freeze parameters before the confirmatory recordings.

**Outcomes:** Recovery time, misses, false events during/after perturbations, physical-release detection and unintended repeated actions. Test whether blanking or suppressing feedback-adjacent input hides a legitimate release.

**What it establishes:** Whether the observed replay mechanisms explain and improve real closed-loop behaviour.

### Priority 4 — Prospective days, strap refits and participants

**Question:** Which claims generalise beyond the author's repeatedly examined recordings?

**Protocol:** Freeze the method before collecting new sessions. Hold out complete days/refits for personalised claims and complete participants for user-independent claims. If adaptation is allowed, define a separate calibration budget and later test period.

**Outcomes:** Per-participant and per-day results, false activations per eligible negative hour, missed/late/repeated events, availability and uncertainty. Keep still-hand and moving-hand conditions explicit.

**What it establishes:** The appropriate scope of generalisation, not just a larger recording count.

### Later — Headset or out-of-view interaction

Compare camera pinch, watch pinch and their combination, including deliberately out-of-view hand conditions. Use a real headset/task comparison before claiming an AR/VR advantage. Wrist sensing needing no visual line of sight is a plausible motivation, not evidence of superior recognition or usability.

### Optional directions after the core evidence

- Joint versus separate models under genuinely matched targets and compute/tuning budgets.
- Few-shot refit adaptation, with calibration effort and forgetting measured.
- Confidence-aware refusal and availability reporting, so abstention is not mistaken for accuracy.
- Battery/transport/reconnection measurements for long sessions.
- Public release of code, schemas and privacy-reviewed data or synthetic fixtures. Physiological recordings require explicit sharing decisions.

A larger network, foundation model or another gesture vocabulary should follow a demonstrated limitation, not replace these validation priorities.

## 6. Section-by-section revision map

### Abstract and Introduction

- Foreground unmodified consumer hardware and the complete sensing-to-action problem.
- Use a small number of defensible contributions, not a catalogue of UI features.
- Select one coherent headline experiment and state its participant/cohort scope.
- Do not mix historical binary outcomes with newer delayed-state results.

### Related Work

- Add an explicit μDPad comparison covering both interaction overlap and custom hardware.
- Position against commercial-watch work as well as custom prototypes.
- Explain spatial PPG versus wavelength channels and incompatible evaluation endpoints.
- Avoid claims of priority that this focused review has not established.

### System Design and Methods

- Keep the distinction between recognition, interaction state and cancellation.
- If reporting CNNv2, document its actual channels, grid, branches, scaling and gate.
- Identify which models use which preprocessing; do not rewrite the old experiment's methods to describe a different model.
- State real sensor delivery rates separately from resampling and inference rates.

### Dataset and Annotation

- Retain historical audit counts with their snapshot date.
- Add an updated inventory only after regenerating the source-grouped audit.
- Explain camera/manual label roles, exclusions and any timing uncertainty.
- Add physical onset/offset reliability checks; optical/motion morphology is not independent ground truth for itself.

### Results

- Separate historical replay, newer binary models, synthetic robustness, multiclass state exploration and prospective interaction measurements.
- Add matched ablations and per-context errors where supported.
- Report negative exposure and unavailable time, not just window accuracy or a single AUC.
- Keep failed or inconclusive comparisons when they explain the chosen design.

### Discussion and Limitations

- Explain the hardware/deployability distinction without claiming an invented interaction.
- Retain single-participant, repeated-selection, synthetic-perturbation and annotation limitations.
- Discuss haptic feedback, normalisation recovery, calibration cost and the consequence of missed release.
- Keep headsets and population-level claims prospective until measured.

### Report or supplement

Put detailed model architecture, complete sweeps, provenance manifests, failure cases, UI/tooling and reproducibility instructions here. Keep the conference paper focused. Neither manuscript should imply that a feature has been validated just because the software supports it.

## 7. Suggested positioning and contribution wording

### Positioning statement

> We investigate camera-independent continuous computer control using unmodified consumer wearables. A commercial smartwatch supplies optical and inertial signals, consumer headphones supply head-directed targeting, and a laptop separates gesture recognition from bounded, cancellable interaction. We study the gap between offline recognition and continuous use through source-aware replay, failure analysis and explicitly scoped interaction evidence.

### Contributions supportable without inventing new studies

1. An implemented consumer-device sensing-to-action architecture, with recognition, sustained control and cancellation explicitly separated.
2. A source- and annotation-aware continuous evaluation of the available development recordings, with historical and newer evidence kept distinct.
3. Exploratory analysis of post-motion normalisation failures and candidate remedies, labelled as replay evidence rather than physical prospective validation.

Only add “demonstrates improved task performance,” “generalises across users,” “reduces all-day errors,” or equivalent claims after the corresponding experiments support them. Whether the above constitutes sufficient novelty for a venue depends on the quality of the evidence and comparison, not this proposed wording.

## 8. Author checklist

- [x] Choose explicitly separated model generations, retaining the original 47/57 replay as the headline development result.
- [x] Correct the μDPad comparison without removing its interaction overlap.
- [x] Identify the consumer headphones/watch, Samsung raw-sensor SDK and laptop-side computation. This does not establish compatibility with every commercial watch.
- [x] State the original headline cohort and 300–900 ms replay protocol; distinguish later application accounting.
- [ ] Freeze a prospective protocol before new confirmatory data collection; stating the historical protocol is not a prospective freeze.
- [x] Audit the available paired-detector evidence sufficiently to label it as an archived summary only, rather than a fully recovered run.
- [ ] Recover the paired-detector run artifacts, exact source groups and complete event logs for independent reproduction.
- [x] Include the multiclass findings in Results, with the decision confusion figure in LNCS/report and detailed evidence in the asset package.
- [x] Add the motion-history mechanism and its synthetic/live boundary.
- [x] Discuss haptic confounds as a hypothesis and specify a motor-logged physical study, without claiming that study was performed.
- [ ] Recover haptic timings before attempting event-aligned haptic claims.
- [ ] Run matched modality/preprocessing comparisons before claiming PPG or architecture gains.
- [ ] Measure complete interactions and physical fault behaviour (Priority 1).
- [ ] Run matched IMU-only, PPG-only and fused comparisons (Priority 2).
- [ ] Test physical post-motion recovery and haptics-on/off behaviour (Priority 3).
- [ ] Collect an explicitly prospective test across days/refits/participants after freezing the method (Priority 4).
- [ ] Run the later headset/out-of-view comparison before claiming an AR/VR advantage.
- [x] Apply the reviewed abstract, model-identity, threshold, exposure and exploratory-wording corrections (R1–R4 and R6). This does not close the missing-artifact and future-experiment items above.
- [x] Apply the revised paper title, build documentation and Results float placement (R5 and R7).
- [x] Rebuild IEEE, LNCS and report after the shared corrections; verify the reported counts and absence of unresolved references/overfull boxes. Institutional placeholders and unperformed validation remain open.

## 9. Evidence and primary references

Project links below are pinned to the reviewed snapshot so later code changes do not silently change this guide's evidence. The editable manuscript remains the source of truth; this guide itself does not modify it.

### Project evidence

- **E1 — System description:** [manuscript System Design](https://github.com/meanOtaku/gesture-controls/blob/2010e28/docs/paper/manuscript/sections/03-system-design.tex).
- **E2 — Runtime architecture:** [label inference](https://github.com/meanOtaku/gesture-controls/blob/2010e28/docs/architecture/label-inference.md).
- **E3 — Historical annotations and stream audit:** [Reference Annotations and Source Audit](https://github.com/meanOtaku/gesture-controls/blob/2010e28/docs/paper/manuscript/sections/04-annotation-audit.tex).
- **E4 — Historical results and limitations:** [Results](https://github.com/meanOtaku/gesture-controls/blob/2010e28/docs/paper/manuscript/sections/06-results.tex) and [Limitations](https://github.com/meanOtaku/gesture-controls/blob/2010e28/docs/paper/manuscript/sections/09-limitations.tex).
- **E5 — Motion-history diagnosis and remedies:** [CNN motion hangover study](https://github.com/meanOtaku/gesture-controls/blob/2010e28/docs/research/cnn-motion-hangover-2026-11.md).
- **E6 — CNNv2 findings:** [FINDINGS.md](https://github.com/meanOtaku/gesture-controls/blob/2010e28/docs/research/artifacts/pinch-cnn-v2-2026-11/FINDINGS.md) and [benchmark protocol](https://github.com/meanOtaku/gesture-controls/blob/2010e28/docs/research/artifacts/pinch-cnn-v2-2026-11/README.md).
- **E7 — Executable newer implementation:** [CNNv2 trainer](https://github.com/meanOtaku/gesture-controls/blob/2010e28/tools/label-trainer/src/label_trainer/cnn_v2.py) and [Rust input pipeline](https://github.com/meanOtaku/gesture-controls/blob/2010e28/crates/pinch-inference/src/cnn_input.rs).
- **E8 — Later paired detector outcomes:** [final models](https://github.com/meanOtaku/gesture-controls/blob/2010e28/docs/research/artifacts/training-improvements-2026-11/final-models.md).
- **E9 — External multiclass experiment:** `gesture-controls-experiments/cnnv2-multiclass-20261116/REPORT.md`, `results.json`, `verification.json` and the saved prediction/checkpoint artifacts. These live outside the `gesture-controls` repository at the reviewed point; do not claim they are distributed with this guide or that its checkpoint is the active app model. Reported primary metrics were cross-checked against its machine-readable artifacts in the preceding review.
- **E10 — Sealed-test implementation:** [sealed_test.rs](https://github.com/meanOtaku/gesture-controls/blob/2010e28/apps/desktop/src-tauri/src/sealed_test.rs).
- **E11 — Application and recording capabilities:** [application guide](https://github.com/meanOtaku/gesture-controls/blob/2010e28/docs/using-the-application.md) and [recording bundles](https://github.com/meanOtaku/gesture-controls/blob/2010e28/apps/desktop/src-tauri/src/recording_bundle.rs).
- **E12 — Latest reviewed negative-data addition:** [commit 2010e28](https://github.com/meanOtaku/gesture-controls/commit/2010e2837c65854275a58933e3836e28f5cafe62).
- **E13 — Event-accounting change:** [commit 2317ef3](https://github.com/meanOtaku/gesture-controls/commit/2317ef3).
- **E14 — Live misses and data representativeness:** [live-miss investigation](https://github.com/meanOtaku/gesture-controls/blob/2010e28/docs/research/live-misses-2026-11.md).

### Closest primary papers

- **P1 — Hauptmann et al., 2026.** *μDPad: A Large-Scale Multimodal PPG and IMU Dataset for Wrist-Worn Microgesture Recognition.* [DOI: 10.1145/3776574.3831197](https://doi.org/10.1145/3776574.3831197). Especially Figure 1, Section 3.1 and the continuous recognition/interaction discussion.
- **P2 — Pfeuffer et al., 2017.** *Gaze + Pinch Interaction in Virtual Reality.* [DOI: 10.1145/3131277.3132180](https://doi.org/10.1145/3131277.3132180).
- **P3 — Zhang et al., 2018.** *FinDroidHR: Smartwatch Gesture Input with Optical Heartrate Monitor.* [DOI: 10.1145/3191788](https://doi.org/10.1145/3191788).
- **P4 — Bonazzi et al., 2026.** *OpenWatch: A Multimodal Benchmark for Hand Gesture Recognition on Smartwatches.* [arXiv:2605.04791v2](https://arxiv.org/abs/2605.04791v2). Its benchmark and reported fusion benefits are not direct substitutes for an ablation on our task.
- **P5 — Laput, Xiao and Harrison, 2016.** *ViBand: High-Fidelity Bio-Acoustic Sensing Using Commodity Smartwatch Accelerometers.* [DOI: 10.1145/2984511.2984582](https://doi.org/10.1145/2984511.2984582).

## 10. Revision notes

Use this space for your decisions and planned paper changes. Editing a Joplin copy of this guide does not automatically change the repository or the manuscript.

- Chosen paper scope:
- Primary result and protocol:
- Contribution wording to retain:
- Evidence additions selected:
- Experiments to run first:
- Claims removed or deferred:
