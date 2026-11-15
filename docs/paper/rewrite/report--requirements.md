# Rewrite: `report/requirements.tex`

Rewrite any block below in your own words. See [the guide](README.md) for the few things to keep (citations, references, maths). Blocks left empty keep their current text.

## Requirements and Platform

<!-- block requirements/p001 -->
#### ¶ p001

**Current:**

> This chapter sets out what the system has to do, the constraints it has to respect, and the hardware and software it runs on. The requirements come from the project brief written at the start of the work and were refined as the prototype developed.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/p001 -->

## Functional Requirements

🖼️ *[description, kept as it is]*

<!-- block requirements/i002 -->
#### • list item i002 — FR1 Head-directed targeting.

**Current:**

> The system shall map head orientation to on-screen targets. The user calibrates by facing the screen centre and then the volume target, and each target is stored as a quaternion. At run time the nearest target is found by quaternion angular distance, $2\arccos(|\langle q, q_t\rangle|)$, rather than fixed yaw and pitch limits. A target becomes active when the head stays within 12° of it for 400\,ms; both values are configurable.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i002 -->

<!-- block requirements/i003 -->
#### • list item i003 — FR2 Pinch detection.

**Current:**

> The system shall detect the start of a pinch (pinch-in) and its release (pinch-out) from smartwatch PPG and inertial signals, as separate events.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i003 -->

<!-- block requirements/i004 -->
#### • list item i004 — FR3 Grab and release.

**Current:**

> A pinch-in while the volume target is active shall start a grab; a pinch-out, or any cancellation condition, shall end it.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i004 -->

<!-- block requirements/i005 -->
#### • list item i005 — FR4 Wrist-rotation control.

**Current:**

> During a grab, wrist roll relative to the angle at grab time shall set the system volume.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i005 -->

<!-- block requirements/i006 -->
#### • list item i006 — FR5 Operating modes.

**Current:**

> The user shall be able to switch between Off (no inference), Monitor (inference and feedback without any effect on the system) and Live (inference that can change the volume).

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i006 -->

<!-- block requirements/i007 -->
#### • list item i007 — FR6 Recording.

**Current:**

> The system shall record synchronised watch, head-tracker and optional camera data as immutable recording bundles.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i007 -->

<!-- block requirements/i008 -->
#### • list item i008 — FR7 Labelling.

**Current:**

> The user shall be able to label recordings by hand, or from camera hand landmarks, while keeping the original labels.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i008 -->

<!-- block requirements/i009 -->
#### • list item i009 — FR8 Training and model management.

**Current:**

> The user shall be able to train per-label models from recordings, inspect their evaluation, and activate, monitor or roll back a model.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i009 -->

<!-- block requirements/i010 -->
#### • list item i010 — FR9 Watch transport.

**Current:**

> The watch shall connect over Bluetooth Low Energy by default, with Wi-Fi as an alternative selectable on both sides.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i010 -->

## Non-functional Requirements

🖼️ *[description, kept as it is]*

<!-- block requirements/i011 -->
#### • list item i011 — NFR1 Fail closed.

**Current:**

> Any stage that rejects input (out-of-order data, poor signal quality, stale orientation, an unloadable model, a non-probability output) shall end an open grab rather than let it continue. A held grab whose model data have been silent for 750\,ms shall be released.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i011 -->

<!-- block requirements/i012 -->
#### • list item i012 — NFR2 No surprise actuation.

**Current:**

> The system shall never start in Live mode: a saved Live setting is lowered to Monitor at startup.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i012 -->

<!-- block requirements/i013 -->
#### • list item i013 — NFR3 Bounded output.

**Current:**

> Volume shall change only through the interaction policy, within its valid range and at a bounded rate.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i013 -->

<!-- block requirements/i014 -->
#### • list item i014 — NFR4 Responsiveness.

**Current:**

> A pinch should be recognised within roughly half a second, and volume changes should follow the wrist smoothly.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i014 -->

<!-- block requirements/i015 -->
#### • list item i015 — NFR5 Low false activation.

**Current:**

> The detector should rarely fire during ordinary activity such as typing or using a mouse.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i015 -->

<!-- block requirements/i016 -->
#### • list item i016 — NFR6 Local processing and privacy.

**Current:**

> All processing shall run on the user's own computer. Camera frames are never stored, only hand landmarks, and nothing is sent over the network.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i016 -->

<!-- block requirements/i017 -->
#### • list item i017 — NFR7 Integrity.

**Current:**

> A model shall be loaded only if its file matches the hash in its manifest and its declared input contract matches the runtime's.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i017 -->

<!-- block requirements/i018 -->
#### • list item i018 — NFR8 Watch battery.

**Current:**

> The watch app should release its sensors and wake lock whenever no desktop is receiving data.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i018 -->

<!-- block requirements/i019 -->
#### • list item i019 — NFR9 Portability.

**Current:**

> The desktop application should run on macOS and Windows, with Linux supported for development.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/i019 -->

## Hardware

🖼️ *[table tab:hardware, kept as it is]*

<!-- block requirements/c020 -->
#### 🏷️ caption c020

**Current:**

> Hardware used in the prototype.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/c020 -->

<!-- block requirements/p021 -->
#### ¶ p021

**Current:**

> Both wearables act only as sensors. Nothing is trained or inferred on the watch or the headphones, which keeps the watch app simple and lets models be changed without reinstalling it.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/p021 -->

## Software Stack

🖼️ *[table tab:stack, kept as it is]*

<!-- block requirements/c022 -->
#### 🏷️ caption c022

**Current:**

> Main software components and the technologies they use.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/c022 -->

<!-- block requirements/p023 -->
#### ¶ p023

**Current:**

> The desktop application targets macOS 14 or later and Windows 11 (x64), with Linux used for development. The watch application requires Wear OS 3 (API level 30) or later, and a Galaxy Watch4 or newer for raw PPG.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end requirements/p023 -->
