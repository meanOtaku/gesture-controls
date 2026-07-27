# Sony Head Tracking

Python receiver for head-orientation data from Sony WH-1000XM5 headphones.
This is the first project in the Spatial Gesture Volume Controller monorepo.

The headphones are read by
[`sony-head-tracker`](https://github.com/NicholasSlattery/sony-head-tracker).
That application sends one JSON sample per UDP datagram to
`127.0.0.1:4243`. This project consumes those samples; it does not communicate
with the headphones directly.

The Samsung Health Sensor SDK is reserved for the Galaxy Watch gesture project
and is not a dependency of this project.

## Requirements

- Python 3.11 or newer
- Sony Head Tracker running in GUI or bridge mode

## Run

From this directory:

```bash
python3 -m venv .venv
.venv/bin/pip install --editable .
.venv/bin/sony-head-tracking
```

The terminal updates with the headset name, yaw, pitch, roll, sample rate, and
receive latency. Stop it with `Ctrl+C`.

To use a different host or port:

```bash
.venv/bin/sony-head-tracking --host 127.0.0.1 --port 4243
```

## Test without headphones

Terminal 1:

```bash
.venv/bin/sony-head-tracking
```

Terminal 2:

```bash
python3 scripts/send_sample.py
```

## Tests

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

## Next milestones

- Store center and screen-corner calibration poses
- Detect top-right activation using quaternion similarity
- Publish normalized head-pose events to the desktop coordinator
