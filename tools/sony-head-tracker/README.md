# Head-tracking reference and compatibility tooling

Production Sony acquisition is handled by the separate MIT-licensed [`sony-head-tracker`](https://github.com/NicholasSlattery/sony-head-tracker) process. Spatial Gesture Control receives its protocol-v2 JSON stream over loopback UDP port 4243.

Run the whole development system from the repository root with:

```bash
npm start
```

The launcher selects the committed upstream v2.2.0 CLI bridge prebuild for the current host, then starts it in the background with Tauri. The Tauri dashboard is the single user-facing tracker UI; it does not compile Sony HID code into the Tauri binary.

## Contents

- `scripts/send_sample.py` — sends a protocol-v2 compatibility packet to the Tauri UDP provider
- `src/sony_head_tracking/` — earlier Python protocol monitor and interoperability code
- `native-macos/` — earlier first-party Swift/IOHID investigation retained as reference material, not the production provider
- `tests/` — Python protocol compatibility tests
- `THIRD_PARTY_NOTICES.md` — upstream attribution and MIT notice

## Manual simulator

On systems without Sony Head Tracker hardware support, run Tauri and the simulator separately:

```bash
npm run tauri -- dev
python3 tools/sony-head-tracker/scripts/send_sample.py
```

The simulator is development-only. Real production samples come from the separate upstream CLI bridge process.

## Boundary

```text
Sony headset -> external sony-head-tracker -> UDP 127.0.0.1:4243 -> Tauri
```

Only Tauri binds the receiving JSON port. The external tracker owns HID discovery, permissions, recovery, recentering, and hardware-specific behavior.

This is an unofficial project and is not affiliated with or endorsed by Sony.
