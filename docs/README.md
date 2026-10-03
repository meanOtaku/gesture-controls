# Documentation

## Using and running

- [Using the application](using-the-application.md): setup, every tab, and the safe workflow from raw telemetry to a desktop-controlled volume gesture
- [Running the project](development/running-project.md): prerequisites, one-command launch, tracker setup, tests and CI

## Architecture

- [Components and deployment](architecture/components-and-deployment.md): what runs where, how the pieces communicate, data at rest, build, packaging and CI
- [Performance review](performance.md): what was measured, what changed because of it, what was deliberately left alone, and how to reproduce the numbers
- [Safety and fail-closed behavior](architecture/safety-and-fail-closed-behavior.md): the invariants that bound what the desktop can do, and what is not guaranteed
- [Project brief](architecture/project-brief.md): the original design specification and milestone plan (see its status note for where the implementation differs)
- Per-app structure: [desktop](../apps/desktop/ARCHITECTURE.md), [watch](../apps/watch/ARCHITECTURE.md), [Sony tracker](../tools/sony-head-tracker/ARCHITECTURE.md)
- Training tooling: [pinch-classifier](../tools/pinch-classifier/README.md)

## Protocols

- [Watch WebSocket protocol](protocols/watch-websocket-protocol.md): the message envelope and every message, shared by both transports; the Wi-Fi transport
- [Watch Bluetooth LE transport](protocols/watch-ble-transport.md): the default transport, framing, trust model and failure states

## Decisions

- [Dataset capture and recording contract](decisions/2026-09-dataset-capture-recording-contract.md)
- [UI consistency contract](decisions/2026-09-ui-consistency-contract.md)
- [Wi-Fi vs BLE watch transport](decisions/2026-09-24-wifi-vs-ble-transport.md) (superseded: Bluetooth is now the default)

## Release

- [Release-readiness acceptance checklist](release-readiness.md): the real-device gate
- [LiteRT desktop runtime packaging](release/litert-runtime-packaging.md)

## Records

- [Review remediation](review-remediation.md): the status of every finding in the four engineering reviews, with commits
- [GC-036 optimization and documentation pass](optimization-2026-09-gc-036.md)
- The reviews themselves (historical, not edited): [`.hermes/reviews/`](../.hermes/reviews/)
- Task and checkpoint logs: [`TASKS.md`](../TASKS.md), [`CHECKPOINT.md`](../CHECKPOINT.md)
