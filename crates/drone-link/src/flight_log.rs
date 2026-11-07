//! Records every control frame of a flight to a CSV file, which is the only way to tune hold from real data.
//!
//! Rows go to their own thread, so a slow disk cannot delay a command. Nothing here affects flight: a failed write
//! just ends the recording.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::mpsc::{Sender, channel};
use std::time::Instant;

use crate::frame::Control;
use crate::hold::{Correction, HoldPhase};
use crate::link::LinkStatus;

pub const HEADER: &str = "seconds,aileron,elevator,throttle,rudder,flags,armed,hold,video_frames,\
flow_dx,flow_dy,flow_zoom,confidence,drift_x,drift_y,zoom_total,correction_aileron,correction_elevator";

fn phase_name(phase: HoldPhase) -> &'static str {
    match phase {
        HoldPhase::Off => "off",
        HoldPhase::Calibrating => "calibrating",
        HoldPhase::Holding => "holding",
        HoldPhase::Failed(_) => "failed",
    }
}

fn row(seconds: f32, control: Control, status: &LinkStatus) -> String {
    let sticks = control.sticks;
    let (dx, dy, zoom, confidence) = status.flow.map_or((0.0, 0.0, 0.0, 0.0), |(_, flow)| {
        (flow.dx, flow.dy, flow.zoom, flow.confidence)
    });
    let Correction { aileron, elevator } = status.correction.unwrap_or_default();
    format!(
        "{seconds:.3},{},{},{},{},{},{},{},{},{dx:.3},{dy:.3},{zoom:.5},{confidence:.2},{:.2},{:.2},{:.4},{aileron},{elevator}",
        sticks.aileron,
        sticks.elevator,
        sticks.throttle,
        sticks.rudder,
        control.flags,
        u8::from(status.armed),
        phase_name(status.hold),
        status.video_frames,
        status.drift.0,
        status.drift.1,
        status.zoom_total,
    )
}

#[derive(Debug)]
pub struct FlightLog {
    rows: Sender<String>,
    started: Instant,
}

impl FlightLog {
    pub fn create(path: &Path) -> std::io::Result<Self> {
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder)?;
        }
        let mut file = BufWriter::new(File::create(path)?);
        writeln!(file, "{HEADER}")?;
        let (rows, incoming) = channel::<String>();
        std::thread::Builder::new()
            .name("drone-flight-log".into())
            .spawn(move || {
                for row in incoming {
                    if writeln!(file, "{row}").is_err() {
                        return;
                    }
                }
                let _ = file.flush();
            })?;
        Ok(Self {
            rows,
            started: Instant::now(),
        })
    }

    pub fn record(&self, control: Control, status: &LinkStatus) {
        let seconds = self.started.elapsed().as_secs_f32();
        let _ = self.rows.send(row(seconds, control, status));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::Sticks;
    use crate::link::LinkPhase;

    fn status() -> LinkStatus {
        LinkStatus {
            phase: LinkPhase::Open,
            armed: true,
            failsafe_tripped: false,
            took_off: true,
            headless: false,
            returning: false,
            frames_sent: 1,
            video_frames: 7,
            video_skipped: 0,
            video_damaged: 0,
            video_restarts: 0,
            video_repeats: 0,
            send_errors: 0,
            flow: None,
            drift: (1.5, -2.0),
            zoom_total: 0.01,
            hold: HoldPhase::Calibrating,
            correction: Some(Correction {
                aileron: 3,
                elevator: -2,
            }),
            unknown_packets: 0,
            drone_status: None,
            status_messages: 0,
        }
    }

    #[test]
    fn a_row_has_a_value_for_every_column() {
        let line = row(1.5, Control::IDLE, &status());
        assert_eq!(line.split(',').count(), HEADER.split(',').count());
        assert!(line.starts_with("1.500,128,128,128,128,64,1,calibrating,7,"));
        assert!(line.ends_with(",3,-2"));
    }

    #[test]
    fn a_flight_ends_up_in_the_file() {
        let path = std::env::temp_dir().join(format!("drone-log-test-{}.csv", std::process::id()));
        let log = FlightLog::create(&path).unwrap();
        log.record(
            Control {
                sticks: Sticks::CENTRED,
                flags: 0x41,
            },
            &status(),
        );
        drop(log);
        let deadline = Instant::now() + std::time::Duration::from_secs(2);
        let text = loop {
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            if text.lines().count() == 2 || Instant::now() > deadline {
                break text;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        std::fs::remove_file(&path).ok();
        assert_eq!(text.lines().next(), Some(HEADER));
        assert!(text.lines().nth(1).unwrap().contains(",65,1,calibrating,"));
    }
}
