//! The WIFI UAV wire format: frames sent to the drone, and the video packets that come back.
//!
//! Every control frame also asks for video: its records name the frame just received and the next one wanted, and the
//! drone sends nothing further until asked.

use std::collections::{BTreeMap, BTreeSet};

/// Stick centre. The app's trims offset this, but the drone's own centre is here.
pub const NEUTRAL: u8 = 0x80;
/// Asks for the video stream; the first control exchange of a session.
pub const VIDEO_START: [u8; 4] = [0xEF, 0x00, 0x04, 0x00];
/// Asks for the firmware name, which comes back as a `93 04` packet.
pub const VERSION_QUERY: [u8; 6] = [0xEF, 0x20, 0x06, 0x00, 0x01, 0x65];

const COMMON_HEADER: [u8; 4] = [0x02, 0x02, 0x00, 0x01];
const CONTROL_RECORD_HEADER: [u8; 3] = [0x08, 0x00, 0x66];
const CONTROL_RECORD_END: u8 = 0x99;
const TRAILER: [u8; 6] = [0x32, 0x4B, 0x14, 0x2D, 0x00, 0x00];
const BASE_LENGTH: usize = 88;
const SETUP_LENGTH: usize = 108;
const REQUEST_LENGTH: usize = 124;

const VIDEO_MAGIC: [u8; 2] = [0x93, 0x01];
const VIDEO_HEADER_LENGTH: usize = 56;
const VIDEO_FRAME_OFFSET: usize = 16;
const VIDEO_PART_OFFSET: usize = 32;
const VIDEO_TOTAL_OFFSET: usize = 36;
/// More parts than this is corruption: a whole frame is a few dozen.
const MAX_VIDEO_PARTS: u32 = 1024;
/// Unfinished frames worth remembering, so corrupt frame numbers cannot grow the tracker without limit.
const MAX_TRACKED_FRAMES: usize = 16;

/// The four stick positions, each 0 to 255 around [`NEUTRAL`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sticks {
    pub aileron: u8,
    pub elevator: u8,
    pub throttle: u8,
    pub rudder: u8,
}

impl Sticks {
    pub const CENTRED: Self = Self {
        aileron: NEUTRAL,
        elevator: NEUTRAL,
        throttle: NEUTRAL,
        rudder: NEUTRAL,
    };
}

/// The app's momentary buttons, by the name its code gives them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    /// Takeoff: started the motors on the bench.
    Up,
    /// Landing: stopped the motors on the bench. What it does in the air is not yet known.
    Down,
    /// Named Stop in the app, and presumably the emergency motor cut. Not yet tried on the drone.
    Stop,
    /// Gyro calibration.
    GyroCheck,
}

impl Button {
    const fn bit(self) -> u8 {
        match self {
            Button::Up => 0x01,
            Button::Down => 0x02,
            Button::Stop => 0x04,
            Button::GyroCheck => 0x80,
        }
    }
}

/// Always set by the app's control screen. The code calls it `Hl`, and it centres the throttle stick.
const FLAG_HL: u8 = 0x40;

/// What one control frame says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Control {
    pub sticks: Sticks,
    pub flags: u8,
}

impl Control {
    pub const IDLE: Self = Self {
        sticks: Sticks::CENTRED,
        flags: FLAG_HL,
    };

    pub const fn pressing(sticks: Sticks, button: Button) -> Self {
        Self {
            sticks,
            flags: FLAG_HL | button.bit(),
        }
    }
}

fn base(records: u32, length: u16, control: Option<(u16, Control)>) -> [u8; BASE_LENGTH] {
    let mut frame = [0; BASE_LENGTH];
    frame[..2].copy_from_slice(&[0xEF, 0x02]);
    frame[2..4].copy_from_slice(&length.to_le_bytes());
    frame[4..8].copy_from_slice(&COMMON_HEADER);
    frame[8..12].copy_from_slice(&records.to_le_bytes());
    if let Some((sequence, control)) = control {
        let body = [
            control.sticks.aileron,
            control.sticks.elevator,
            control.sticks.throttle,
            control.sticks.rudder,
            control.flags,
        ];
        frame[12..14].copy_from_slice(&sequence.to_le_bytes());
        frame[16..19].copy_from_slice(&CONTROL_RECORD_HEADER);
        frame[19..24].copy_from_slice(&body);
        frame[24] = body.iter().fold(0, |checksum, byte| checksum ^ byte);
        frame[25] = CONTROL_RECORD_END;
    }
    frame[82..].copy_from_slice(&TRAILER);
    frame
}

/// A frame with no control in it, which the app sends while opening a session.
pub fn empty_frame() -> [u8; BASE_LENGTH] {
    base(0, BASE_LENGTH as u16, None)
}

/// The one setup frame the app sends while opening a session.
pub fn setup_frame() -> [u8; SETUP_LENGTH] {
    let mut frame = [0; SETUP_LENGTH];
    frame[..BASE_LENGTH].copy_from_slice(&base(1, SETUP_LENGTH as u16, None));
    frame[88..92].copy_from_slice(&1u32.to_le_bytes());
    frame[100..104].copy_from_slice(&0x14u32.to_le_bytes());
    frame[106..108].copy_from_slice(&[0xFE, 0xFF]);
    frame
}

fn with_video_request(first: [u8; BASE_LENGTH], received: u32) -> [u8; REQUEST_LENGTH] {
    let mut frame = [0; REQUEST_LENGTH];
    frame[..BASE_LENGTH].copy_from_slice(&first);
    frame[88..92].copy_from_slice(&received.to_le_bytes());
    frame[96..100].copy_from_slice(&1u32.to_le_bytes());
    frame[100..104].copy_from_slice(&0x14u32.to_le_bytes());
    frame[104..108].copy_from_slice(&[0xFF; 4]);
    frame[108..112].copy_from_slice(&received.wrapping_add(1).to_le_bytes());
    frame[116..120].copy_from_slice(&3u32.to_le_bytes());
    frame[120..124].copy_from_slice(&0x10u32.to_le_bytes());
    frame
}

/// The first video request of a session, which carries no control.
pub fn opening_request_frame(received: u32) -> [u8; REQUEST_LENGTH] {
    with_video_request(base(2, REQUEST_LENGTH as u16, None), received)
}

/// A control frame that also says video frame `received` arrived and asks for the next one.
pub fn control_frame(sequence: u16, control: Control, received: u32) -> [u8; REQUEST_LENGTH] {
    with_video_request(
        base(2, REQUEST_LENGTH as u16, Some((sequence, control))),
        received,
    )
}

/// Works out which video frames have fully arrived. Parts can arrive out of order, and more than once.
#[derive(Debug, Default)]
pub struct VideoTracker {
    pending: BTreeMap<u32, (u32, BTreeSet<u32>)>,
    completed: u32,
}

impl VideoTracker {
    /// The highest frame number fully received, or 0 before the first.
    pub fn completed(&self) -> u32 {
        self.completed
    }

    /// Takes in a packet from the drone, and returns true when it finished a new frame.
    pub fn observe(&mut self, packet: &[u8]) -> bool {
        let Some((frame, part, total)) = parse_video(packet) else {
            return false;
        };
        if frame <= self.completed {
            return false;
        }
        let (_, parts) = self
            .pending
            .entry(frame)
            .or_insert_with(|| (total, BTreeSet::new()));
        parts.insert(part);
        if parts.len() as u32 >= total {
            self.completed = frame;
            self.pending = self.pending.split_off(&(frame + 1));
            return true;
        }
        while self.pending.len() > MAX_TRACKED_FRAMES {
            self.pending.pop_first();
        }
        false
    }
}

fn parse_video(packet: &[u8]) -> Option<(u32, u32, u32)> {
    if packet.len() < VIDEO_HEADER_LENGTH || packet[..2] != VIDEO_MAGIC {
        return None;
    }
    let read = |offset: usize| {
        let bytes: [u8; 4] = packet[offset..offset + 4].try_into().ok()?;
        Some(u32::from_le_bytes(bytes))
    };
    let frame = read(VIDEO_FRAME_OFFSET)?;
    let part = read(VIDEO_PART_OFFSET)?;
    let total = read(VIDEO_TOTAL_OFFSET)?;
    (frame < u32::MAX && total > 0 && total <= MAX_VIDEO_PARTS && part < total)
        .then_some((frame, part, total))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decodes hex in a test fixture.
    fn bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
            .collect()
    }

    const RECORDS_ZERO: &str = "990000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000324b142d0000";

    /// Real frames from the phone app talking to a DM002HW.
    fn captured(head: &str, flags_and_sum: &str, sticks: &str, tail: &str) -> Vec<u8> {
        bytes(&format!(
            "ef027c000202000102000000{head}0000080066{sticks}{flags_and_sum}{RECORDS_ZERO}{tail}"
        ))
    }

    #[test]
    fn matches_captured_idle_frame() {
        let frame = captured(
            "9a05",
            "4040",
            "80808080",
            "930400000000000001000000140000\
             00ffffffff940400000000000003000000\
             10000000",
        );
        assert_eq!(control_frame(0x059A, Control::IDLE, 0x0493).to_vec(), frame);
    }

    #[test]
    fn matches_captured_up_press_with_trim() {
        let frame = captured(
            "0402",
            "41bf",
            "807e8080",
            "ca0100000000000001000000140000\
             00ffffffffcb0100000000000003000000\
             10000000",
        );
        let sticks = Sticks {
            elevator: 0x7E,
            ..Sticks::CENTRED
        };
        assert_eq!(
            control_frame(0x0204, Control::pressing(sticks, Button::Up), 0x01CA).to_vec(),
            frame
        );
    }

    #[test]
    fn matches_captured_stop_press() {
        let frame = captured(
            "4106",
            "4444",
            "80808080",
            "1c0500000000000001000000140000\
             00ffffffff1d0500000000000003000000\
             10000000",
        );
        assert_eq!(
            control_frame(
                0x0641,
                Control::pressing(Sticks::CENTRED, Button::Stop),
                0x051C
            )
            .to_vec(),
            frame
        );
    }

    #[test]
    fn matches_captured_trimmed_sticks() {
        let frame = captured(
            "2e04",
            "4044",
            "807a807e",
            "770300000000000001000000140000\
             00ffffffff780300000000000003000000\
             10000000",
        );
        let sticks = Sticks {
            elevator: 0x7A,
            rudder: 0x7E,
            ..Sticks::CENTRED
        };
        let control = Control {
            sticks,
            flags: FLAG_HL,
        };
        assert_eq!(control_frame(0x042E, control, 0x0377).to_vec(), frame);
    }

    #[test]
    fn opening_frames_have_their_captured_shape() {
        let empty = empty_frame();
        assert_eq!(&empty[..4], &[0xEF, 0x02, 0x58, 0x00]);
        assert!(empty[12..82].iter().all(|byte| *byte == 0));
        assert_eq!(&empty[82..], &TRAILER);

        let setup = setup_frame();
        assert_eq!(&setup[..4], &[0xEF, 0x02, 0x6C, 0x00]);
        assert_eq!(setup[8], 1);
        assert_eq!(&setup[88..92], &[1, 0, 0, 0]);
        assert_eq!(&setup[104..108], &[0, 0, 0xFE, 0xFF]);

        let request = opening_request_frame(1);
        assert_eq!(&request[..4], &[0xEF, 0x02, 0x7C, 0x00]);
        assert!(request[12..82].iter().all(|byte| *byte == 0));
        assert_eq!(request[88], 1);
        assert_eq!(request[108], 2);
    }

    fn part(frame: u32, part: u32, total: u32) -> Vec<u8> {
        let mut packet = vec![0; VIDEO_HEADER_LENGTH + 8];
        packet[..2].copy_from_slice(&VIDEO_MAGIC);
        packet[VIDEO_FRAME_OFFSET..VIDEO_FRAME_OFFSET + 4].copy_from_slice(&frame.to_le_bytes());
        packet[VIDEO_PART_OFFSET..VIDEO_PART_OFFSET + 4].copy_from_slice(&part.to_le_bytes());
        packet[VIDEO_TOTAL_OFFSET..VIDEO_TOTAL_OFFSET + 4].copy_from_slice(&total.to_le_bytes());
        packet
    }

    #[test]
    fn a_frame_completes_once_with_parts_out_of_order_and_repeated() {
        let mut tracker = VideoTracker::default();
        assert!(!tracker.observe(&part(1, 2, 3)));
        assert!(!tracker.observe(&part(1, 0, 3)));
        assert!(!tracker.observe(&part(1, 0, 3)));
        assert!(tracker.observe(&part(1, 1, 3)));
        assert!(!tracker.observe(&part(1, 1, 3)));
        assert_eq!(tracker.completed(), 1);
    }

    #[test]
    fn corrupt_packets_are_ignored() {
        let mut tracker = VideoTracker::default();
        assert!(!tracker.observe(&[0x93, 0x01]));
        assert!(!tracker.observe(&part(5, 0, 0)));
        assert!(!tracker.observe(&part(5, 3, 3)));
        assert!(!tracker.observe(&part(5, 0, MAX_VIDEO_PARTS + 1)));
        assert!(!tracker.observe(&part(u32::MAX, 0, 1)));
        let mut wrong_magic = part(5, 0, 1);
        wrong_magic[0] = 0x3F;
        assert!(!tracker.observe(&wrong_magic));
        assert_eq!(tracker.completed(), 0);
    }

    #[test]
    fn unfinished_frames_do_not_pile_up() {
        let mut tracker = VideoTracker::default();
        for frame in 1..1000 {
            tracker.observe(&part(frame, 0, 2));
        }
        assert!(tracker.pending.len() <= MAX_TRACKED_FRAMES);
    }

    #[test]
    fn a_finished_frame_forgets_older_ones() {
        let mut tracker = VideoTracker::default();
        tracker.observe(&part(3, 0, 2));
        assert!(tracker.observe(&part(4, 0, 1)));
        assert!(!tracker.observe(&part(3, 1, 2)));
        assert_eq!(tracker.completed(), 4);
    }
}
