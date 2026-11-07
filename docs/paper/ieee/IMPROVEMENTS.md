# IEEE conference manuscript: evidence corrections and revision guide

**Applies to:** `main.tex`, `body.tex`, `refs.bib`, `architecture.png` in this folder. The current committed PDF has six pages. A future conference's actual page/reference rules—not this observed length—determine the final budget. Journal Q1–Q4 labels do not directly rank conference papers.

**Goal:** a concise systems paper that could support a later Q2-target journal extension. A template change alone is not an extension. This document supplies proposed additions; the existing LaTeX/PDF has not been silently rewritten.

## Read first

- [Full evidence and old-versus-hand-labelled audit](../EVIDENCE_AUDIT.md).
- [Detailed Q2 study plan, completed capabilities and primary literature](../Q2_RESEARCH_PLAN.md).
- [Springer conference counterpart](../springer/IMPROVEMENTS.md). Keep the two conference `body.tex` files identical when applying scientific edits; wrappers, float placement and citations can be format-specific.

## 1. Immediate corrections, in editing order

### Abstract in `main.tex`

Remove the broad claim that the CNN caught about two thirds of pinches on unseen sessions. The historical pooled no-gate LODO configuration caught **161/372 (43.3%)**; its November subsets did better. Do not replace this with the newer hand-labelled model's **82.46%** without disclosing the new cohort and development-only evidence boundary.

Suggested replacement for the results/conclusion portion:

> Historical camera-labelled leave-one-day-out evaluation exposed substantial cross-day variation: the selected configuration caught 161 of 372 pinch starts, with distinct false-activation rates on noise and pinch recordings. A later manually revised development cohort is tracked separately and is not treated as a prospective test. The contribution is a continuous sensing-to-action pipeline and an analysis of the annotation, temporal evaluation and failure-handling choices needed for dependable interaction.

This is intentionally less promotional. If current event logs and a frozen prospective study become available, replace the historical headline with the verified current result and its denominator, operating point and population—not both percentages merged into a single claim.

### Data and labels in `body.tex`

Add a concise cohort paragraph and one compact table. Distinguish cue labels, automatic camera labels and saved manual overrides. The hand-labelled directory has 37 exports but 28 unique complete PPG+IMU stream pairs. Fourteen exports contain nonempty manual PPG overrides; not all exports are demonstrated to be manually labelled. Do not present duplicate exports as extra independent sessions.

Suggested text:

> We preserve original labels and apply explicit manual overrides during loading. Blank override fields retain the original annotation. Exports with identical sensor columns are grouped as one source recording before splitting. Historical camera-labelled studies and the later hand-labelled development model use different evidence cohorts and are reported separately; manual revision is not assumed to establish error-free contact timing.

Table columns: **cohort/version; unique source groups; participant/day coverage; reference-label method; development/evaluation role; eligible negative duration**. Leave unverified counts visibly pending in drafts; do not submit placeholders.

### Methods and evaluation

- Replace the MAD-only equation with `1.4826 × MAD + channel floor`, the clip/sigmoid and the decision-level 549-tick history definition from the [audit](../EVIDENCE_AUDIT.md#normalisation-correction).
- Describe peak-trigger emission at the **first decline after reaching threshold**, with cooldown after the active detection ends. Do not backdate event latency to a local maximum.
- Specify event-matching tolerance, warm-up, quality/gap rejection, exclusions and the false-activation denominator. Report per-label counts, negative hours, repeats/late errors and actual emitted-event latency.
- Distinguish the training-selected threshold in the hand-labelled manifest from the curriculum experiment whose reserved pair selected the threshold and supplied the validation result.
- Recover the exact evidence for “final” 15/20 and 18/21, or remove those figures. Do not attribute them to another model by resemblance.

### Results and conclusion

Retain the old fusion study only as historical motivation. A historical 0.789 → 0.837 AUC comparison is not a new PPG contribution measurement on reviewed labels. The “median removes blind spot” splice percentages are a **window-score sensitivity check**, not continuous event recall or a live movement study. Scope the conclusion to a one-person prototype until prospective/generalisation and usability evidence exists.

## 2. Figures that should be added

### Highest priority: real annotation/telemetry example

![Saved telemetry and annotation correction](../revision-assets/annotation-telemetry.png)

Proposed caption:

> Saved PPG and gyroscope data aligned to the watch clock, with original and effective annotations for one manually revised recording. Each PPG channel is centred and divided by its unscaled MAD over the displayed interval for visualisation only; gyroscope magnitude is in rad/s. Effective labels apply nonempty manual overrides. No model prediction or physical contact-time verification is implied.

Place this near data/label production; use full width only if the bands are unreadable at a single column. Do not shrink labels until illegible. Name the session in the accompanying text or artifact supplement; exact provenance is in [figure-provenance.json](../revision-assets/figure-provenance.json).

```tex
\begin{figure*}[t]
  \centering
  \includegraphics[width=0.94\textwidth]{../revision-assets/annotation-telemetry.pdf}
  \caption{Saved telemetry and original/effective annotations. PPG is
  median-centred and divided by displayed-window MAD for visualisation;
  gyroscope magnitude retains rad/s. This is not a model prediction.}
  \label{fig:annotation-revision}
\end{figure*}
```

The relative asset path works in this repository. Before an Overleaf upload, copy the selected asset into the self-contained paper folder and change the path; do not break the README's self-contained-upload promise.

### Historical transfer figure, if keeping historical results

![Historical transfer by day](../revision-assets/historical-day-transfer.png)

Use the precise caption in the audit. This figure exposes the variability hidden by the two-thirds phrase. It is more informative than another architecture diagram; trade it against a table if the page budget is tight. Its data are old explored camera-label results, not a manual-label rerun.

### Required later, only after measurements exist

A current-model event timeline and a matched modality/normalisation result figure. Neither can be honestly drawn from the current manifest alone. Keep the existing system architecture but check it shows **watch/headset as sensors, desktop as inference/action host**, with camera restricted to annotation.

## 3. Recommended six-page-style narrative

This is a planning allocation, not a venue rule:

1. Problem, deployment target and three concrete contributions; short related-work contrast.
2. System topology, paired interaction and the most important failure constraints.
3. Reference labels, manual overrides, source-group split and causal inference.
4. Continuous protocol and compact main results with counts/exposure.
5. Matched ablation and real interaction/failure evidence.
6. Limitations, reproducibility and references as allowed by venue policy.

Move the long history of unsuccessful preprocessing/architecture variations to a supplement. Preserve negative findings that explain a design decision; remove a laundry list that distracts from the central contribution.

## 4. Additional work that earns the stronger claim

Minimum priority: recover current hand-labelled event logs and pinch-out provenance; independently review labels; run matched IMU-only/PPG-only/fusion and rolling/median comparisons; collect a frozen new-day/refit test; measure actual interaction outcomes and false actions. The [research plan](../Q2_RESEARCH_PLAN.md) defines how to do these without leakage.

For a later journal extension, add substantive new participants/days and a clear new analysis—not just this paper in an eight-page journal template. Check conference copyright and target journal extension policy; cite/disclose the earlier publication and avoid simultaneous duplicate submission.

## 5. Submission gate

- [ ] Headline results belong to an identified model/annotation/split, not a mixture of eras.
- [ ] No statement calls a manifest-only metric an independently reproduced test.
- [ ] Both pinch directions, per-day failures, negative exposure and latency are reported.
- [ ] Literature titles/authors, affiliation and consent/ethics/access statements are complete.
- [ ] Conference bodies remain identical, figures/citations resolve, and PDF fits the chosen venue.
- [ ] If moving to a journal, current quartile/category and extension policy are verified separately.
