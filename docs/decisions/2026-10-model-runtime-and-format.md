# Model format and inference runtime for per-label binary models

**Status:** Accepted, as the basis for the Model Lab refactor (step 0). Nothing here changes runtime behaviour yet; later steps implement it.
**Scope:** `crates/pinch-inference`, `apps/desktop/src-tauri` (inference, model registry), `tools/label-trainer`.

## Context

Model Lab is moving from one three-class pinch model to **one binary model per label** (output 0 = absent, 1 = present), several of them active at once, trained by interchangeable backends, and fed from inputs the user chooses.

Inference does not work today under `npm start`. The only real backend is LiteRT, behind the cargo feature `litert-inference`, which a normal dev build does not compile in; without it every window fails closed (`load_model_backend` in `inference.rs`). The first draft of the plan answered that with a managed Python sidecar.

The network is tiny (about 55 inputs, 32 and 16 hidden units, one binary output, roughly 2,400 parameters). At that size, process hops, scheduling and feature extraction cost more than the model.

## Decision

| Concern | Choice |
| --- | --- |
| Training framework | Any: scikit-learn first, then Keras and PyTorch as adapters. Not part of the deployed app. |
| Portable interchange format | **ONNX**, FP32 reference. |
| Inference runtime | **In-process, Rust-native, `tract-onnx`**, compiled into every build. |
| Hardware acceleration | None for now. Optional later through ONNX Runtime execution providers if a model ever needs it. |
| Python at runtime | **None.** Python is for training and conversion only. |

Consequences of choosing in-process inference:

- It works under `npm start` with no sidecar, because `tract` is an ordinary cargo dependency with no runtime library to ship or find. (Its `tract-linalg` crate does run a build script that needs a C compiler and assembler on the build machine. A Tauri build already requires the platform toolchain, but this has been confirmed only on macOS arm64; see the correction below.)
- The managed-sidecar protocol (NDJSON, readiness handshake, restart policy, orphan handling) is not built. A runtime fault becomes an in-process error handled by the existing fail-closed path.
- One telemetry-ingestion and quality-gating path feeds all active models; there is no per-model process.

## Evidence

**Spike (run for this record, not part of the repo).** A scikit-learn `MLPClassifier` with the real shape (55 → 32 → 16 → 2) was exported with `skl2onnx` (opset 15, no ZipMap, 10.7 KB) and run with `tract-onnx` 0.21 in a release build on Apple Silicon:

- Outputs agreed with scikit-learn's `predict_proba` to **1.2e-7** (and with ONNX Runtime to the same).
- **6.3 µs** per inference, single-threaded, including tensor construction.
- The crate built with a plain `cargo build` on macOS; no runtime library was needed.

This is one model on one platform. Windows and Linux builds, and a model from the Keras and PyTorch exporters, are still to be checked when those adapters land.

**Sources read for this record** (the rest of the table below is from each project's own documentation and was not re-read in full for this record; treat it as the starting point for review, not a benchmark):

- tract: <https://github.com/sonos/tract>. Loads ONNX and NNEF, written in Rust with its own CPU kernels, runs on Linux, macOS and Windows and on ARM and x86; its page says TensorFlow 2 must be converted to ONNX first, and gives no operator-coverage figures, so operator support is checked per model by the bundle validator.
- ONNX Runtime execution providers: <https://onnxruntime.ai/docs/execution-providers/>. One runtime fronting CPU, CUDA, TensorRT, DirectML, OpenVINO, CoreML (preview), XNNPACK and others, which is why ONNX as a *format* keeps the acceleration door open without a second runtime.
- ONNX specification: <https://onnx.ai/onnx/>.
- Exporters: scikit-learn <https://onnx.ai/sklearn-onnx/>, PyTorch <https://pytorch.org/docs/stable/onnx.html>, TensorFlow/Keras <https://github.com/onnx/tensorflow-onnx>.

## Alternatives considered

| Option | Verdict |
| --- | --- |
| **Python ONNX Runtime sidecar** (the first plan) | Works, but adds a process to start, supervise, time out and shut down, and an IPC hop that costs more than the 6 µs model. Kept as a *fallback* only for a model `tract` cannot run. |
| **ONNX Runtime in-process via the `ort` crate** | Capable, and the way to reach execution providers, but it needs a native runtime library at build or run time. Reserved for when acceleration is needed. |
| **LiteRT/TFLite** (today) | Optional cargo feature with a native library; the reason `npm start` has no inference. Kept as a documented legacy path (below). Its tooling is tied to TensorFlow, and scikit-learn and PyTorch reach it only indirectly. |
| **OpenVINO, TensorRT, Core ML, ExecuTorch, ncnn, TVM** | Each is a hardware- or platform-specific path, a toolchain of its own, or aimed at much larger models. None is justified for a 2,400-parameter MLP and each would be a permanent extra runtime. Several (OpenVINO, TensorRT, Core ML, TVM) are already reachable later as ONNX Runtime execution providers. Not adopted. |
| **Hand-written Rust MLP evaluator** | Fastest and smallest, but only fits one architecture and bypasses the "any trainer" goal. Rejected. |

## Quantization

Not built. For a model this small, quantization is unlikely to change latency and is more likely to cost accuracy. The model manifest keeps room for variant files and the acceptance gates, so FP16 or INT8 can be added later behind measured gates. Until then the FP32 reference is the only deployable variant.

## Legacy TFLite path

The existing three-class TFLite model and the `litert-inference` feature stay as they are until the new path is verified end to end on real recordings. **Removal condition:** a binary pinch model trained and replayed through the new runtime meets the recorded acceptance numbers, and the old registry entry has been migrated or quarantined by the registry-migration step. At that point the LiteRT backend, the `litert-inference` feature and `train_tflite.py` are deleted.

## Risks and how they are contained

- **Operator coverage.** `tract` may not support an operator an exporter emits. The bundle validator loads and test-runs every model at import and training time and refuses one that fails, with the operator named.
- **Numerical drift between exporter and runtime.** The parity report compares runtime output against the training framework on a fixed set of inputs, and a failure blocks deployment.
- **One runtime means one point of failure.** A runtime fault clears every active label's detection state and force-releases dependent interactions, the same fail-closed rule as today.

## Correction after building step 2

The spike note above said `tract` needs "no native library". More precisely: nothing has to be shipped or located at run time, but `tract-linalg`'s build script invokes a C compiler to build its kernels, so a build needs the platform's usual toolchain (Xcode command line tools, MSVC build tools, gcc). The desktop app already needs these. A cross-compile check from macOS to Windows and Linux failed only because those cross toolchains are not installed on the development machine, so **Windows and Linux builds of `crates/label-inference` are unverified** and should be confirmed in CI.

Another detail found against a real exporter's model: `tract` names an output after the operation that produces it, not after the ONNX tensor, so the bundle validator reads the ONNX graph's own output labels to find the output the manifest names.
