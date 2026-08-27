# Watch application structure

The Wear OS application uses package boundaries that reflect runtime responsibility.

```text
app/                    # Activity composition, permissions, lifecycle, and UI binding
data/
├── connection/         # WebSocket transport and wire serialization
├── discovery/          # mDNS/LAN desktop discovery and pairing endpoint
└── preferences/        # Persisted trusted endpoint state
feature/
├── health/             # Samsung Health Sensor SDK trackers and medical sample models
└── motion/             # Android IMU collection and orientation sample models
platform/service/       # Android foreground-service and wake-lock lifecycle
```

Rules:
- `app` composes dependencies; it must not implement transport or sensor algorithms.
- `data` owns networking, discovery, and persistence boundaries.
- `feature` owns sensor-specific orchestration and data translation.
- `platform` contains Android OS integration that does not belong to a feature.
- The application ID remains `com.gesturecontrols.wearwatch`; package moves are internal only.
