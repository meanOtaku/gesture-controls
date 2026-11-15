# Rewrite: `report/intro-extra.tex`

Rewrite any block below in your own words. See [the guide](README.md) for the few things to keep (citations, references, maths). Blocks left empty keep their current text.

## Objectives

<!-- block intro-extra/p001 -->
#### ¶ p001

**Current:**

> The project set out to:

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/p001 -->

🖼️ *[enumerate, kept as it is]*

<!-- block intro-extra/i002 -->
#### • list item i002

**Current:**

> build a complete sensing-to-action pipeline in which head orientation from consumer headphones selects an on-screen target and smartwatch signals detect when the user pinches;

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/i002 -->

<!-- block intro-extra/i003 -->
#### • list item i003

**Current:**

> design an interaction that keeps brief gesture events separate from sustained control, so that a missed or false detection cannot leave the system changing the volume on its own;

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/i003 -->

<!-- block intro-extra/i004 -->
#### • list item i004

**Current:**

> record and label a dataset of pinches and everyday activity, including manually corrected labels and camera-based reference labels;

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/i004 -->

<!-- block intro-extra/i005 -->
#### • list item i005

**Current:**

> train a causal pinch detector that runs on the laptop in real time, and evaluate it over whole recordings with event-level measures: catches, misses, latency and false activations per hour;

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/i005 -->

<!-- block intro-extra/i006 -->
#### • list item i006

**Current:**

> check the dataset and the stored results for reproducibility, including duplicate recordings and changing label versions;

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/i006 -->

<!-- block intro-extra/i007 -->
#### • list item i007

**Current:**

> identify what further studies are needed to support stronger claims, including use in AR/VR headsets.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/i007 -->

## Scope

<!-- block intro-extra/p008 -->
#### ¶ p008 — In scope.

**Current:**

> The report covers hands-free control of laptop volume by one user, the author, using Sony WH-1000XM5 headphones for head tracking, a Samsung Galaxy Watch4 for PPG and inertial sensing, and an Apple MacBook Air (M3) running the desktop application. It describes the full system as built and evaluates the pinch-in detector on recorded data.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/p008 -->

<!-- block intro-extra/p009 -->
#### ¶ p009 — Out of scope.

**Current:**

> Several things are deliberately left out:

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/p009 -->

🖼️ *[itemize, kept as it is]*

<!-- block intro-extra/i010 -->
#### • list item i010

**Current:**

> **Other users.** No multi-participant study has been run, so the results do not describe how the system performs for other people.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/i010 -->

<!-- block intro-extra/i011 -->
#### • list item i011

**Current:**

> **A user study of the interaction.** Task time, error and workload for look–pinch–turn have not yet been measured against a conventional volume control.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/i011 -->

<!-- block intro-extra/i012 -->
#### • list item i012

**Current:**

> **Pinch-out evaluation.** No matched model for pinch release was available for evaluation.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/i012 -->

<!-- block intro-extra/i013 -->
#### • list item i013

**Current:**

> **AR/VR headsets.** Use in a headset is discussed as a prospect only; it was not tested.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/i013 -->

<!-- block intro-extra/i014 -->
#### • list item i014

**Current:**

> **Inference on the watch.** All models run on the laptop; the watch only streams data.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/i014 -->

<!-- block intro-extra/i015 -->
#### • list item i015

**Current:**

> **Other actions.** The codebase also contains a gesture-recipe engine for brightness, scrolling and media keys, and a separate drone-control experiment. Neither is evaluated in this report.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/i015 -->

## Organisation of the Report

<!-- block intro-extra/p016 -->
#### ¶ p016

**Current:**

> Chapter [ref:related-work-and-evaluation-context] reviews related work on wrist-based gesture sensing and look-then-act interaction. Chapter [ref:ch:requirements] lists the requirements and the hardware and software platform. Chapter [ref:system-design] presents the system design, and Chapter [ref:ch:implementation] describes how each component is implemented. Chapter [ref:reference-annotations-and-source-audit] explains how the reference labels were produced and audits the dataset. Chapter [ref:causal-detection-and-event-accounting] describes the detector and the event-level metrics, and Chapter [ref:results] reports the results, including software testing. Chapter [ref:discussion] discusses what the results show, including prospects for AR and VR, and Chapter [ref:limitations-and-reproducibility] sets out the limitations. Chapter [ref:prospective-validation-protocol] proposes the studies that should follow, and Chapter [ref:conclusion] concludes. The appendices give the dataset inventory and a short user guide.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end intro-extra/p016 -->
