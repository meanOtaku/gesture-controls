# Desktop application structure

The desktop application is a Tauri + React feature-oriented frontend. The root command remains `npm start`.

```text
src/
├── app/                         # Composition root, window-mode selection, Tauri subscriptions
├── features/
│   ├── dashboard/components/     # Connection, calibration, and watch controls
│   ├── overlay/components/       # Volume gesture overlay
│   └── telemetry/components/     # Charts, bounded history, CSV export
├── shared/protocol/              # Typed Tauri/WebSocket event contracts and math helpers
├── main.tsx                      # React bootstrap only
└── styles.css                    # Shared application theme
```

Rules:
- Feature components may depend on `shared`, but not on another feature's implementation.
- `app/` composes features and owns application-wide Tauri listeners.
- Event payload shapes live in `shared/protocol/events.ts`; do not duplicate wire types in components.
- Keep tests colocated with the component or composition root they verify.
