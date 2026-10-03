# Troubleshooting the watch link

The watch talks to the desktop over Bluetooth LE (the default) or Wi-Fi. Both transports report
into the same place: the **Link health** card on the Watch tab, and on the watch the **Show
details** panel. Start there; each entry below says what you will see and what it means.

## Reading Link health

| Field | Meaning |
| --- | --- |
| Phase | `Searching`, `Connecting`, `Waiting for approval`, `Streaming`, `Retrying` (a failed attempt, with the reason and a countdown), or `Waiting for the watch` (Wi-Fi listening) |
| Connected for | Time since this session started |
| Drops / sessions | Sessions that ended without the desktop asking, out of all sessions since the app started |
| Write latency (last / worst) | How long a desktop-to-watch command took to be acknowledged. Anything over about a second means a busy radio |
| Longest silence | The longest gap between two watch messages this session |
| MTU | Negotiated Bluetooth packet size; 23 bytes means it was never raised and throughput will be poor |
| Rejected | Messages dropped as unparseable or out of sequence |
| Last disconnect | Why the previous session ended and how long it lasted |

**Copy diagnostics** puts the whole snapshot, including the event history, on the clipboard.

## Why a link ends

| Last disconnect says | What it means | What to check |
| --- | --- | --- |
| The watch went silent | Nothing arrived, and no command write completed, for the silence limit (3 s on Wi-Fi, 6 s on Bluetooth) | Is the watch app in the foreground or its service alive? Samsung's battery manager can freeze a backgrounded app. Is the radio busy (next section)? |
| The link closed | The transport reported the connection closed | On the watch's log: `disconnected (status N)`: 8 is a supervision timeout (out of range or interference), 19 means the desktop hung up |
| A command write failed | A write to the watch was refused | The watch app may have crashed or been killed; reopen it |
| Stopped by this app | You switched transport or stopped it | Nothing |

## Known causes, in the order they were found

- **A session ending after exactly 30 seconds, every time.** The desktop's Bluetooth stack
  sends a Service Changed indication on connecting and drops the link 30 s later if it is not
  confirmed. The watch confirms it (`desktop reported Service Changed; confirming` in its log).
  If it recurs, remove the computer from the watch's Bluetooth settings so the pairing is rebuilt.
- **Long write latency and gaps in the data, with `Sony head tracker disconnected` repeating.**
  The Sony tracker searches for a headset that is not there, using the same radio. Start with
  `SONY_HEAD_TRACKER_PROVIDER=off` when the headset is not in use.
- **Wi-Fi stuck on "Searching for desktop".** The watch's app may be frozen by the battery manager
  (its pairing port times out), or macOS is blocking local-network access for the app that launched
  the desktop (System Settings, Privacy & Security, Local Network). The Link health events show
  `watch found at ..., but its pairing server did not answer` when it is the former.
- **Bluetooth off.** The desktop keeps checking for an adapter every 3 s and the watch rebuilds its
  server when Bluetooth returns; the phase reads `Retrying` with `is Bluetooth on?` until then.

## What the watch shows

The Details panel lists the link's own events, newest first, for example `desktop …D7:37 connected`,
`MTU 517 (514 bytes per notification)`, `desktop …D7:37 disconnected (status 19)`, `advertising:
waiting for a desktop to find this watch`, and on Wi-Fi `wifi: retrying in 4.0 s (attempt 3)`. The
same lines go to logcat under `LinkLog`, so `adb logcat -s LinkLog` gives the full history.
The Wi-Fi transport never gives up: it retries with a backoff capped at 30 s, and a ping every 15 s
notices a connection that died without telling anyone.
