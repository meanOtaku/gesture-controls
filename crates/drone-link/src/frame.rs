//! The WIFI UAV wire format: frames sent to the drone, and the video packets that come back.
//!
//! Every control frame also asks for video: its records name the frame just received and the next one wanted, and the
//! drone sends nothing further until asked.

use std::collections::BTreeMap;

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
const TEXT_MAGIC: [u8; 2] = [0x93, 0x04];
const FIRMWARE_REPLY: [u8; 2] = [0x01, 0x65];
const FIRMWARE_MARKER_OFFSET: usize = 12;
const FIRMWARE_TEXT_OFFSET: usize = 14;
const MAX_FIRMWARE_CHARS: usize = 120;
const VIDEO_HEADER_LENGTH: usize = 56;
const VIDEO_FRAME_OFFSET: usize = 16;
const VIDEO_PART_OFFSET: usize = 32;
const VIDEO_TOTAL_OFFSET: usize = 36;
const VIDEO_SIZE_OFFSET: usize = 40;
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

/// Headless mode, while it is on: the drone steers by the direction it faced when the mode began, not by its nose.
/// The app's headless switch keeps this set in every frame for as long as the switch is on.
pub const FLAG_HEADLESS: u8 = 0x10;
/// Named Back in the app's code, and presumably the advertised one-key return. The app never sets it, so whether it
/// must be held or only pressed, and what the drone does, are not known. Sent here in every frame while returning.
pub const FLAG_RETURN: u8 = 0x20;

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

/// The firmware name, if this packet is the reply to [`VERSION_QUERY`].
const STATUS_START: u8 = 0x88;
const STATUS_TYPE: u8 = 0x00;
const STATUS_END: u8 = 0x55;
const STATUS_MIN_LENGTH: usize = 7;

/// The flight controller's status message, as the phone app reads it: `88 00 fly battery flags … xor 55`, where the
/// xor covers every byte from the type to just before itself. The app reads it but never shows it, so the meaning of
/// the fly state and battery numbers is not known, and they are kept raw. No DM002HW has been seen sending it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DroneStatus {
    pub fly_state: u8,
    pub battery: u8,
    /// The speed setting, 0 to 3.
    pub speed: u8,
    pub remote_control: bool,
    pub camera_tilt: bool,
    pub headless: bool,
    pub photo: bool,
    pub video: bool,
    pub light: bool,
}

/// Finds a status message anywhere in a packet. Where the drone puts it is not known: the phone's native code hands it
/// on after a source byte of 0 (flight controller), so it may sit inside a `93 04` text packet, or arrive bare.
/// Never call this on video, whose random bytes could pass the check by chance.
pub fn parse_status(packet: &[u8]) -> Option<DroneStatus> {
    (0..packet.len())
        .filter(|&start| packet[start] == STATUS_START)
        .find_map(|start| {
            (start + STATUS_MIN_LENGTH - 1..packet.len())
                .filter(|&end| packet[end] == STATUS_END)
                .find_map(|end| status_at(&packet[start..=end]))
        })
}

fn status_at(message: &[u8]) -> Option<DroneStatus> {
    let length = message.len();
    if length < STATUS_MIN_LENGTH || message[1] != STATUS_TYPE {
        return None;
    }
    let checksum = message[1..length - 2]
        .iter()
        .fold(0, |sum, byte| sum ^ byte);
    if checksum != message[length - 2] {
        return None;
    }
    let flags = message[4];
    let bit = |mask: u8| flags & mask == mask;
    Some(DroneStatus {
        fly_state: message[2],
        battery: message[3],
        speed: flags & 0x03,
        remote_control: bit(0x04),
        camera_tilt: bit(0x08),
        headless: bit(0x10),
        photo: bit(0x20),
        video: bit(0x40),
        light: bit(0x80),
    })
}

/// Whether a packet is a video part, even a damaged one.
pub fn is_video_packet(packet: &[u8]) -> bool {
    packet.len() >= 2 && packet[..2] == VIDEO_MAGIC
}

pub fn parse_firmware(packet: &[u8]) -> Option<String> {
    if packet.len() <= FIRMWARE_TEXT_OFFSET
        || packet[..2] != TEXT_MAGIC
        || packet[FIRMWARE_MARKER_OFFSET..FIRMWARE_TEXT_OFFSET] != FIRMWARE_REPLY
    {
        return None;
    }
    let text: String = packet[FIRMWARE_TEXT_OFFSET..]
        .iter()
        .take(MAX_FIRMWARE_CHARS)
        .take_while(|byte| (0x20..0x7F).contains(*byte))
        .map(|byte| char::from(*byte))
        .collect();
    (!text.is_empty()).then_some(text)
}

/// A whole video frame, still without its JPEG header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoFrame {
    pub number: u32,
    pub body: Vec<u8>,
}

#[derive(Debug)]
struct PendingFrame {
    total: u32,
    size: usize,
    parts: BTreeMap<u32, Vec<u8>>,
}

/// Rebuilds video frames from their parts, which can arrive out of order and more than once.
#[derive(Debug, Default)]
pub struct VideoTracker {
    pending: BTreeMap<u32, PendingFrame>,
    completed: u32,
    received: u32,
}

impl VideoTracker {
    /// The frame to acknowledge: the newest one finished or given up on, or 0 before the first.
    pub fn completed(&self) -> u32 {
        self.completed
    }

    /// How many frames have really arrived whole.
    pub fn received(&self) -> u32 {
        self.received
    }

    /// True while a frame has arrived in part and is still missing pieces.
    pub fn is_incomplete(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Gives up on the newest unfinished frame, so the drone is asked for the one after it. Returns true if there was
    /// one. With nothing part-received this does nothing: the frame number only ever comes from the drone, because
    /// counting past it would make every later frame look old, and freeze the picture for good.
    pub fn skip(&mut self) -> bool {
        let Some(newest) = self.pending.keys().next_back().copied() else {
            return false;
        };
        self.completed = newest;
        self.pending.clear();
        true
    }

    /// Takes in a packet from the drone, and returns the frame when it finishes one that adds up.
    pub fn observe(&mut self, packet: &[u8]) -> Option<VideoFrame> {
        let (number, part, total, size) = parse_video(packet)?;
        if number <= self.completed {
            return None;
        }
        let frame = self.pending.entry(number).or_insert_with(|| PendingFrame {
            total,
            size,
            parts: BTreeMap::new(),
        });
        frame
            .parts
            .insert(part, packet[VIDEO_HEADER_LENGTH..].to_vec());
        if (frame.parts.len() as u32) < frame.total {
            while self.pending.len() > MAX_TRACKED_FRAMES {
                self.pending.pop_first();
            }
            return None;
        }
        let frame = self.pending.remove(&number)?;
        self.completed = number;
        self.pending = self.pending.split_off(&(number + 1));
        let body: Vec<u8> = frame.parts.into_values().flatten().collect();
        // A frame that does not add up was damaged: acknowledged, but never decoded.
        if body.len() != frame.size {
            return None;
        }
        self.received = self.received.saturating_add(1);
        Some(VideoFrame { number, body })
    }
}

fn parse_video(packet: &[u8]) -> Option<(u32, u32, u32, usize)> {
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
    let size = read(VIDEO_SIZE_OFFSET)? as usize;
    (frame < u32::MAX && total > 0 && total <= MAX_VIDEO_PARTS && part < total)
        .then_some((frame, part, total, size))
}

#[cfg(test)]
mod tests {

    fn status_message(fly: u8, battery: u8, flags: u8) -> Vec<u8> {
        let body = [0x00, fly, battery, flags];
        let checksum = body.iter().fold(0, |sum, byte| sum ^ byte);
        let mut message = vec![0x88];
        message.extend_from_slice(&body);
        message.extend_from_slice(&[checksum, 0x55]);
        message
    }

    #[test]
    fn a_status_message_is_read_as_the_app_reads_it() {
        let status = parse_status(&status_message(2, 87, 0b1001_0110)).unwrap();
        assert_eq!(status.fly_state, 2);
        assert_eq!(status.battery, 87);
        assert_eq!(status.speed, 2);
        assert!(status.remote_control && status.headless && status.light);
        assert!(!status.camera_tilt && !status.photo && !status.video);
    }

    #[test]
    fn a_status_message_is_found_inside_a_text_packet() {
        let mut packet = vec![0x93, 0x04, 0x20, 0, 0x10, 0, 0, 0, 0, 0, 0, 0, 0x00];
        packet.extend(status_message(1, 50, 0x01));
        assert_eq!(parse_status(&packet).unwrap().battery, 50);
    }

    #[test]
    fn a_damaged_or_other_message_is_not_status() {
        let mut bad = status_message(1, 50, 0);
        bad[3] ^= 1;
        assert_eq!(parse_status(&bad), None);
        let mut other_type = status_message(1, 50, 0);
        other_type[1] = 1;
        other_type[5] ^= 1;
        assert_eq!(parse_status(&other_type), None);
        assert_eq!(parse_status(&[0x88, 0x00, 0x55]), None);
        assert_eq!(parse_status(&bytes(FIRMWARE_PACKET)), None);
    }

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

    /// A real reply, from the drone in the reversing repo's capture.
    const FIRMWARE_PACKET: &str = "930441001000000035000501016528464c4f5729464c4f575f373230505f5631\
                                   2e342e315f32303233303630355f4265746128433232292c493d333635333030\
                                   30";

    #[test]
    fn the_firmware_name_is_read_from_its_reply() {
        let packet = bytes(FIRMWARE_PACKET);
        assert_eq!(
            parse_firmware(&packet).as_deref(),
            Some("(FLOW)FLOW_720P_V1.4.1_20230605_Beta(C22),I=3653000")
        );
    }

    #[test]
    fn other_packets_are_not_a_firmware_name() {
        assert_eq!(parse_firmware(&part(1, 0, 1)), None);
        assert_eq!(parse_firmware(&[0x93, 0x04]), None);
        // The reply to a text command: the same kind of packet with another marker.
        let mut reply = vec![0x93, 0x04, 0x13, 0, 2, 0, 0, 0, 7, 0, 0, 0, 0x01, 0x67];
        reply.extend_from_slice(b"<e=0>");
        assert_eq!(parse_firmware(&reply), None);
    }

    #[test]
    fn a_firmware_name_stops_at_anything_unprintable_and_is_bounded() {
        let mut packet = vec![0; 12];
        packet[..2].copy_from_slice(&TEXT_MAGIC);
        packet.extend_from_slice(&FIRMWARE_REPLY);
        packet.extend_from_slice(b"NAME\xFFjunk");
        assert_eq!(parse_firmware(&packet).as_deref(), Some("NAME"));
        packet.truncate(14);
        packet.extend_from_slice(&[b'A'; 500]);
        assert_eq!(parse_firmware(&packet).map(|name| name.len()), Some(120));
    }

    const PART_BYTES: usize = 8;

    fn part(frame: u32, part: u32, total: u32) -> Vec<u8> {
        let mut packet = vec![part as u8; VIDEO_HEADER_LENGTH + PART_BYTES];
        packet[..VIDEO_HEADER_LENGTH].fill(0);
        packet[..2].copy_from_slice(&VIDEO_MAGIC);
        packet[VIDEO_FRAME_OFFSET..VIDEO_FRAME_OFFSET + 4].copy_from_slice(&frame.to_le_bytes());
        packet[VIDEO_PART_OFFSET..VIDEO_PART_OFFSET + 4].copy_from_slice(&part.to_le_bytes());
        packet[VIDEO_TOTAL_OFFSET..VIDEO_TOTAL_OFFSET + 4].copy_from_slice(&total.to_le_bytes());
        let size = total * PART_BYTES as u32;
        packet[VIDEO_SIZE_OFFSET..VIDEO_SIZE_OFFSET + 4].copy_from_slice(&size.to_le_bytes());
        packet
    }

    #[test]
    fn a_frame_is_rebuilt_in_order_once_with_parts_out_of_order_and_repeated() {
        let mut tracker = VideoTracker::default();
        assert!(tracker.observe(&part(1, 2, 3)).is_none());
        assert!(tracker.observe(&part(1, 0, 3)).is_none());
        assert!(tracker.observe(&part(1, 0, 3)).is_none());
        let frame = tracker.observe(&part(1, 1, 3)).unwrap();
        assert!(tracker.observe(&part(1, 1, 3)).is_none());
        assert_eq!(frame.number, 1);
        assert_eq!(frame.body.len(), 3 * PART_BYTES);
        assert_eq!(frame.body[0], 0);
        assert_eq!(frame.body[PART_BYTES], 1);
        assert_eq!(frame.body[2 * PART_BYTES], 2);
        assert_eq!(tracker.completed(), 1);
        assert_eq!(tracker.received(), 1);
    }

    #[test]
    fn corrupt_packets_are_ignored() {
        let mut tracker = VideoTracker::default();
        assert!(tracker.observe(&[0x93, 0x01]).is_none());
        assert!(tracker.observe(&part(5, 0, 0)).is_none());
        assert!(tracker.observe(&part(5, 3, 3)).is_none());
        assert!(tracker.observe(&part(5, 0, MAX_VIDEO_PARTS + 1)).is_none());
        assert!(tracker.observe(&part(u32::MAX, 0, 1)).is_none());
        let mut wrong_magic = part(5, 0, 1);
        wrong_magic[0] = 0x3F;
        assert!(tracker.observe(&wrong_magic).is_none());
        assert_eq!(tracker.completed(), 0);
    }

    #[test]
    fn a_frame_of_the_wrong_size_is_acknowledged_but_not_returned() {
        let mut tracker = VideoTracker::default();
        let mut damaged = part(1, 0, 1);
        damaged[VIDEO_SIZE_OFFSET] += 1;
        assert!(tracker.observe(&damaged).is_none());
        assert_eq!(tracker.completed(), 1);
        assert_eq!(tracker.received(), 0);
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
        assert!(tracker.observe(&part(4, 0, 1)).is_some());
        assert!(tracker.observe(&part(3, 1, 2)).is_none());
        assert_eq!(tracker.completed(), 4);
    }

    #[test]
    fn a_frame_in_pieces_is_incomplete_until_whole() {
        let mut tracker = VideoTracker::default();
        assert!(!tracker.is_incomplete());
        tracker.observe(&part(1, 0, 2));
        assert!(tracker.is_incomplete());
        tracker.observe(&part(1, 1, 2));
        assert!(!tracker.is_incomplete());
    }

    #[test]
    fn a_gap_in_the_video_cannot_make_later_frames_look_old() {
        let mut tracker = VideoTracker::default();
        assert!(tracker.observe(&part(1, 0, 1)).is_some());
        // Nothing arrives for a while, and each skip fires anyway.
        for _ in 0..10 {
            assert!(!tracker.skip());
        }
        assert_eq!(tracker.completed(), 1);
        assert!(tracker.observe(&part(2, 0, 1)).is_some());
    }

    #[test]
    fn skipping_asks_for_the_next_frame_without_counting_it_as_received() {
        let mut tracker = VideoTracker::default();
        tracker.observe(&part(1, 0, 1));
        tracker.observe(&part(2, 0, 2));
        assert!(tracker.skip());
        assert_eq!(tracker.completed(), 2);
        assert_eq!(tracker.received(), 1);
        assert!(tracker.observe(&part(2, 1, 2)).is_none());
        assert!(tracker.observe(&part(3, 0, 1)).is_some());
    }
}
