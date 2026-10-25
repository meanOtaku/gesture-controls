//! A recording as two dense files: `ppg.csv` (the pulse sensor's samples) and `imu.csv` (the motion sensors' samples), in
//! one folder with a small `dataset.json`. Each file has a row only where its own sensor produced a sample, so neither has
//! blank cells where the other sensor had nothing. Merged by timestamp the two files are exactly the single-file dataset the
//! app has always used (rows with the other sensor's columns empty), which is how the trainer reads them.
//!
//! This module is the format: the headers, validating a pair of files, splitting an older single file into a pair, merging a
//! pair back, a hash of a pair, and a report of the gaps in each stream. It never touches the disk.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use serde::{Deserialize, Serialize};

pub const PPG_FILE: &str = "ppg.csv";
pub const IMU_FILE: &str = "imu.csv";
pub const META_FILE: &str = "dataset.json";
pub const FORMAT_VERSION: u32 = 1;

/// A label given by hand on the Labelling page. Where a row has one it is the row's label, whatever `label` (from the
/// recorder or the camera) says; [`NO_LABEL`] there means the row has no label at all.
pub const MANUAL_LABEL_COLUMN: &str = "manual_label";
/// A manual label saying "nothing here": the row is unlabelled, whatever its `label` says.
pub const NO_LABEL: &str = "-";
/// The label of a stretch left out on the Labelling page (strap loose, poor contact): kept in the recording, never trained on.
pub const LEFT_OUT_LABEL: &str = "left_out";
/// How a session was recorded travels with its files as `# context.<field>: <value>` lines at the top (the Recorder's
/// session details: wrist, arm, activity, strap, pinch style, notes).
pub const CONTEXT_PREFIX: &str = "context.";

pub const PPG_HEADER: [&str; 8] = [
    "timestamp_ns",
    "sequence",
    "ppg_green",
    "ppg_red",
    "ppg_ir",
    "contact_quality",
    "label",
    MANUAL_LABEL_COLUMN,
];
pub const IMU_HEADER: [&str; 14] = [
    "timestamp_ns",
    "sequence",
    "accel_x",
    "accel_y",
    "accel_z",
    "gyro_x",
    "gyro_y",
    "gyro_z",
    "quat_w",
    "quat_x",
    "quat_y",
    "quat_z",
    "label",
    MANUAL_LABEL_COLUMN,
];
/// The headers before manual labels existed. Still read; what is stored or written gets the column, empty.
const PPG_HEADER_V1: [&str; 7] = [
    "timestamp_ns",
    "sequence",
    "ppg_green",
    "ppg_red",
    "ppg_ir",
    "contact_quality",
    "label",
];
const IMU_HEADER_V1: [&str; 13] = [
    "timestamp_ns",
    "sequence",
    "accel_x",
    "accel_y",
    "accel_z",
    "gyro_x",
    "gyro_y",
    "gyro_z",
    "quat_w",
    "quat_x",
    "quat_y",
    "quat_z",
    "label",
];

/// The label a row trains on: its manual label where it has one ([`NO_LABEL`] meaning none), otherwise its `label`.
pub fn effective_label<'a>(label: &'a str, manual: &'a str) -> &'a str {
    match manual.trim() {
        "" => label.trim(),
        NO_LABEL => "",
        manual => manual,
    }
}

/// The columns of the single-file dataset (see `model_lab::DATASET_CSV_HEADER`), by what they belong to. A file written
/// since manual labels existed has one more column, `manual_label`, after `label`.
const LEGACY_COLUMNS: usize = 17;
const LEGACY_PPG: std::ops::Range<usize> = 2..5;
const LEGACY_IMU: std::ops::Range<usize> = 5..15;
const LEGACY_CONTACT: usize = 15;
const LEGACY_LABEL: usize = 16;
const LEGACY_MANUAL: usize = 17;

/// A stream's samples further apart than this are a gap: the watch's sensors never go that long between samples.
pub const GAP_MS: f64 = 250.0;

/// What `dataset.json` says about a folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub format_version: u32,
    pub ppg_rows: usize,
    pub imu_rows: usize,
    pub labels: Vec<String>,
    /// The SHA-256 of the single file this folder was made from, when it was converted from one: the data is the same, so it
    /// keeps the identity that models trained on it were sealed with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_sha256: Option<String>,
    /// How the session was recorded (see [`CONTEXT_PREFIX`]).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub context: BTreeMap<String, String>,
}

/// How dense one stream is.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamGaps {
    pub samples: usize,
    pub duration_s: f64,
    /// Samples per second over the stretches without a gap.
    pub rate_hz: f64,
    /// How many times the stream went quiet for longer than a quarter of a second.
    pub gaps: usize,
    pub longest_gap_s: f64,
    /// The share of the recording's time spent in those gaps, 0 to 1.
    pub share_in_gaps: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GapReport {
    pub ppg: StreamGaps,
    pub imu: StreamGaps,
}

/// A pair of validated files, ready to store, with the `manual_label` column.
#[derive(Debug, PartialEq)]
pub struct Pair {
    pub ppg_csv: String,
    pub imu_csv: String,
    pub ppg_rows: usize,
    pub imu_rows: usize,
    /// Distinct labels the stored rows train on (see [`effective_label`]), sorted.
    pub labels: Vec<String>,
    pub gaps: GapReport,
    /// How the session was recorded, from the files' `# context.` lines.
    pub context: BTreeMap<String, String>,
}

fn header_line(columns: &[&str]) -> String {
    columns.join(",")
}

pub fn ppg_header() -> String {
    header_line(&PPG_HEADER)
}

pub fn imu_header() -> String {
    header_line(&IMU_HEADER)
}

/// One row of a file, with the `manual_label` column whatever the file had.
pub(crate) struct Row {
    pub(crate) stamp: i128,
    /// The whole row, with the `manual_label` column.
    pub(crate) line: String,
    pub(crate) label: String,
    pub(crate) manual: String,
}

/// The rows of one file, after the optional `#` lines and the header (this format's, or the one before manual labels).
pub(crate) struct Rows<'a> {
    pub(crate) comments: Vec<&'a str>,
    pub(crate) rows: Vec<Row>,
}

pub(crate) fn read_rows<'a>(
    name: &str,
    text: &'a str,
    header: &[&str],
    header_v1: &[&str],
) -> Result<Rows<'a>, String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut at = 0;
    let mut comments = Vec::new();
    while at < lines.len() && lines[at].trim_start().starts_with('#') {
        comments.push(lines[at]);
        at += 1;
    }
    let (expected, old) = (header_line(header), header_line(header_v1));
    let columns = match lines.get(at) {
        Some(found) if *found == expected => header.len(),
        Some(found) if *found == old => header_v1.len(),
        Some(found) => {
            return Err(format!(
                "{name}: the header is not the one this file must have\n  expected: {expected}\n  actual:   {found}"
            ));
        }
        None => return Err(format!("{name}: it is empty")),
    };
    let mut rows = Vec::new();
    let mut previous: Option<i128> = None;
    for (offset, line) in lines[at + 1..].iter().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let number = offset + 1;
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() != columns {
            return Err(format!(
                "{name}: row {number}: expected {columns} columns, got {}",
                fields.len()
            ));
        }
        let stamp: i128 = fields[0].trim().parse().map_err(|_| {
            format!(
                "{name}: row {number}: the timestamp '{}' is not a whole number",
                fields[0]
            )
        })?;
        if previous.is_some_and(|p| stamp < p) {
            return Err(format!(
                "{name}: row {number}: the timestamp goes backwards"
            ));
        }
        previous = Some(stamp);
        let (label, manual, line) = if columns == header.len() {
            (fields[columns - 2], fields[columns - 1], (*line).to_string())
        } else {
            (fields[columns - 1], "", format!("{line},"))
        };
        rows.push(Row {
            stamp,
            line,
            label: label.trim().to_string(),
            manual: manual.trim().to_string(),
        });
    }
    Ok(Rows { comments, rows })
}

pub(crate) fn read_ppg<'a>(text: &'a str) -> Result<Rows<'a>, String> {
    read_rows(PPG_FILE, text, &PPG_HEADER, &PPG_HEADER_V1)
}

pub(crate) fn read_imu<'a>(text: &'a str) -> Result<Rows<'a>, String> {
    read_rows(IMU_FILE, text, &IMU_HEADER, &IMU_HEADER_V1)
}

/// The session details in `# context.<field>: <value>` lines.
pub fn context_of<'a>(comments: impl IntoIterator<Item = &'a str>) -> BTreeMap<String, String> {
    comments
        .into_iter()
        .filter_map(|line| {
            let rest = line.trim_start().trim_start_matches('#').trim_start().strip_prefix(CONTEXT_PREFIX)?;
            let (field, value) = rest.split_once(':')?;
            let (field, value) = (field.trim(), value.trim());
            (!field.is_empty() && !value.is_empty()).then(|| (field.to_string(), value.to_string()))
        })
        .collect()
}

/// The `# context.` lines for session details, in field order.
pub fn context_lines(context: &BTreeMap<String, String>) -> Vec<String> {
    context
        .iter()
        .map(|(field, value)| format!("# {CONTEXT_PREFIX}{field}: {}", value.replace(['\n', '\r'], " ")))
        .collect()
}

fn is_context_line(line: &str) -> bool {
    line.trim_start().trim_start_matches('#').trim_start().starts_with(CONTEXT_PREFIX)
}

fn declared_label(comments: &[&str]) -> Option<String> {
    for line in comments {
        let trimmed = line.trim_start().trim_start_matches('#').trim_start();
        if let Some(rest) = trimmed.strip_prefix("label:") {
            let value = rest.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// The gaps in one stream's timestamps (nanoseconds, in order).
pub fn gaps_of(stamps: &[i128]) -> StreamGaps {
    if stamps.len() < 2 {
        return StreamGaps {
            samples: stamps.len(),
            ..StreamGaps::default()
        };
    }
    let seconds = |ns: i128| ns as f64 / 1e9;
    let duration = seconds(stamps[stamps.len() - 1] - stamps[0]);
    let mut steps: Vec<f64> = Vec::new();
    let (mut gap_count, mut gap_time, mut longest) = (0usize, 0.0f64, 0.0f64);
    for pair in stamps.windows(2) {
        let step = seconds(pair[1] - pair[0]);
        if step * 1000.0 > GAP_MS {
            gap_count += 1;
            gap_time += step;
            longest = longest.max(step);
        } else {
            steps.push(step);
        }
    }
    let working: f64 = steps.iter().sum();
    StreamGaps {
        samples: stamps.len(),
        duration_s: duration,
        rate_hz: if working > 0.0 {
            steps.len() as f64 / working
        } else {
            0.0
        },
        gaps: gap_count,
        longest_gap_s: longest,
        share_in_gaps: if duration > 0.0 {
            (gap_time / duration).min(1.0)
        } else {
            0.0
        },
    }
}

/// Validates a pair of files and returns them as they will be stored, with the `manual_label` column (added, empty, to files
/// from before it). Each must carry its exact header (this format's or the one before manual labels) and rows of the right
/// width with timestamps that never go backwards. Labels work as in a single file: a `# label: X` line says every row's
/// `label` is X; otherwise rows with no label are the time between marked intervals and are kept, with no label (the pulse
/// model compares each moment with the seconds before it, so the recording must stay continuous). At least one row must
/// train on a label (see [`effective_label`]).
pub fn parse_pair(ppg_text: &str, imu_text: &str) -> Result<Pair, String> {
    parse_pair_with(ppg_text, imu_text, true)
}

/// [`parse_pair`], optionally allowing a recording with no label at all (one opened for labelling).
pub fn parse_pair_with(ppg_text: &str, imu_text: &str, require_label: bool) -> Result<Pair, String> {
    let ppg = read_ppg(ppg_text)?;
    let imu = read_imu(imu_text)?;
    let mut labels = BTreeSet::new();
    let mut labelled = 0usize;
    for (name, rows) in [(PPG_FILE, &ppg), (IMU_FILE, &imu)] {
        let declared = declared_label(&rows.comments);
        for (index, row) in rows.rows.iter().enumerate() {
            match (&declared, row.label.is_empty()) {
                (Some(want), true) => {
                    return Err(format!(
                        "{name}: row {}: no label, but the file declares '# label: {want}'",
                        index + 1
                    ));
                }
                (Some(want), false) if &row.label != want => {
                    return Err(format!(
                        "{name}: row {}: labeled '{}', but the file declares '# label: {want}'",
                        index + 1,
                        row.label
                    ));
                }
                _ => {}
            }
            let trains_on = effective_label(&row.label, &row.manual);
            if !trains_on.is_empty() {
                labels.insert(trains_on.to_string());
                labelled += 1;
            }
        }
    }
    if require_label && labelled == 0 {
        return Err("no labeled rows in either file: add a '# label: <value>' line for a single-label session, or label the rows".into());
    }
    let build = |rows: &Rows, header: String| {
        let mut out: Vec<String> = rows.comments.iter().map(ToString::to_string).collect();
        out.push(header);
        out.extend(rows.rows.iter().map(|row| row.line.clone()));
        out.join("\n") + "\n"
    };
    let stamps = |rows: &Rows| rows.rows.iter().map(|row| row.stamp).collect::<Vec<_>>();
    let context = context_of(ppg.comments.iter().chain(&imu.comments).copied());
    Ok(Pair {
        ppg_csv: build(&ppg, ppg_header()),
        imu_csv: build(&imu, imu_header()),
        ppg_rows: ppg.rows.len(),
        imu_rows: imu.rows.len(),
        labels: labels.into_iter().collect(),
        gaps: GapReport {
            ppg: gaps_of(&stamps(&ppg)),
            imu: gaps_of(&stamps(&imu)),
        },
        context,
    })
}

/// Splits rows of the single-file dataset (17 columns, or 18 with `manual_label`) into the pair. A row with pulse columns
/// goes to `ppg.csv`; one with motion columns goes to `imu.csv`; a row that has both (an older fused export) goes to both, and
/// one with neither carries nothing and is left out. The `# label:` lines go to both files.
pub fn split_legacy(legacy_csv: &str) -> Result<Pair, String> {
    split_legacy_with(legacy_csv, true)
}

/// [`split_legacy`], optionally allowing a recording with no label at all (one opened for labelling).
pub fn split_legacy_with(legacy_csv: &str, require_label: bool) -> Result<Pair, String> {
    let lines: Vec<&str> = legacy_csv.lines().collect();
    let mut at = 0;
    let mut comments: Vec<&str> = Vec::new();
    while at < lines.len() && lines[at].trim_start().starts_with('#') {
        comments.push(lines[at]);
        at += 1;
    }
    // Only the label line and the session details are meaningful to the pair; the rest described the old single file.
    let kept_comments: Vec<&str> = comments
        .iter()
        .copied()
        .filter(|c| {
            c.trim_start()
                .trim_start_matches('#')
                .trim_start()
                .starts_with("label:")
                || is_context_line(c)
        })
        .collect();
    let columns = match lines.get(at).map(|header| header.split(',').count()) {
        Some(18) => LEGACY_COLUMNS + 1,
        _ => LEGACY_COLUMNS,
    };
    let (mut ppg_rows, mut imu_rows): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    for (offset, line) in lines.iter().enumerate().skip(at + 1) {
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split(',').collect();
        if f.len() != columns {
            return Err(format!(
                "row {}: expected {columns} columns, got {}",
                offset - at,
                f.len()
            ));
        }
        let manual = f.get(LEGACY_MANUAL).copied().unwrap_or("");
        let has = |range: std::ops::Range<usize>| f[range].iter().any(|v| !v.trim().is_empty());
        if has(LEGACY_PPG) {
            ppg_rows.push(format!(
                "{},{},{},{},{},{},{},{manual}",
                f[0], f[1], f[2], f[3], f[4], f[LEGACY_CONTACT], f[LEGACY_LABEL]
            ));
        }
        if has(LEGACY_IMU) {
            imu_rows.push(format!(
                "{},{},{},{},{manual}",
                f[0],
                f[1],
                f[LEGACY_IMU].join(","),
                f[LEGACY_LABEL]
            ));
        }
    }
    let join = |header: String, rows: &[String]| {
        let mut out: Vec<String> = kept_comments.iter().map(ToString::to_string).collect();
        out.push(header);
        out.extend(rows.iter().cloned());
        out.join("\n") + "\n"
    };
    parse_pair_with(
        &join(ppg_header(), &ppg_rows),
        &join(imu_header(), &imu_rows),
        require_label,
    )
}

/// The pair merged back into the single-file dataset as it was before manual labels: every row of both, in timestamp order
/// (a tie puts the pulse row first), with the other sensor's columns empty, and each row's `label` the one it trains on
/// ([`effective_label`]). A pulse row and a motion row with the same timestamp, sequence and labels (one row of an older
/// fused export, written to both files) become that one row again. What a recording imported from a folder on the
/// Recordings tab is stored as.
pub fn merge_to_legacy(ppg_csv: &str, imu_csv: &str) -> Result<String, String> {
    merge(ppg_csv, imu_csv, false)
}

/// The pair merged into one file with both `label` and `manual_label` (`model_lab::DATASET_CSV_HEADER_V2`), as the single
/// file the Labelling page exports.
pub fn merge_to_single(ppg_csv: &str, imu_csv: &str) -> Result<String, String> {
    merge(ppg_csv, imu_csv, true)
}

fn merge(ppg_csv: &str, imu_csv: &str, keep_manual: bool) -> Result<String, String> {
    let ppg = read_ppg(ppg_csv)?;
    let imu = read_imu(imu_csv)?;
    let motion: Vec<Vec<&str>> = imu.rows.iter().map(|row| row.line.split(',').collect()).collect();
    let mut fused = vec![false; motion.len()];
    // Motion rows by timestamp, sequence and labels, earliest first, so each pulse row finds its partner without a scan.
    let mut partners: HashMap<(&str, &str, &str, &str), VecDeque<usize>> = HashMap::new();
    for (i, m) in motion.iter().enumerate() {
        partners.entry((m[0], m[1], m[12], m[13])).or_default().push_back(i);
    }
    let labels = |label: &str, manual: &str| {
        if keep_manual {
            format!("{label},{manual}")
        } else {
            effective_label(label, manual).to_string()
        }
    };
    let mut merged: Vec<(i128, u8, String)> = Vec::new();
    for row in &ppg.rows {
        let f: Vec<&str> = row.line.split(',').collect();
        let partner = partners.get_mut(&(f[0], f[1], f[6], f[7])).and_then(VecDeque::pop_front);
        let middle = match partner {
            Some(i) => {
                fused[i] = true;
                motion[i][2..12].join(",")
            }
            None => ",".repeat(9),
        };
        merged.push((
            row.stamp,
            0,
            format!("{},{},{},{},{},{middle},{},{}", f[0], f[1], f[2], f[3], f[4], f[5], labels(f[6], f[7])),
        ));
    }
    for (index, (row, f)) in imu.rows.iter().zip(&motion).enumerate() {
        if fused[index] {
            continue;
        }
        merged.push((
            row.stamp,
            1,
            format!("{},{},,,,{},,{}", f[0], f[1], f[2..12].join(","), labels(f[12], f[13])),
        ));
    }
    merged.sort_by_key(|row| (row.0, row.1));
    let mut out: Vec<String> = ppg
        .comments
        .iter()
        .chain(&imu.comments)
        .map(|c| c.to_string())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    out.push(if keep_manual {
        crate::model_lab::DATASET_CSV_HEADER_V2.join(",")
    } else {
        crate::model_lab::DATASET_CSV_HEADER.join(",")
    });
    out.extend(merged.into_iter().map(|(_, _, line)| line));
    Ok(out.join("\n") + "\n")
}

/// One held gesture: a run of rows that train on one label (see [`effective_label`]) over both files in time order, joined to
/// the previous run of the same label across a gap under [`HOLD_MERGE_GAP_MS`], as the trainer joins them. Times are in
/// milliseconds after the recording's first sample.
#[derive(Debug, Clone, PartialEq)]
pub struct Hold {
    pub label: String,
    pub start_ms: f64,
    pub end_ms: f64,
}

pub const HOLD_MERGE_GAP_MS: f64 = 400.0;
/// The trainer ignores a hold shorter than this.
pub const MIN_HOLD_MS: f64 = 200.0;

/// Every hold in the pair (short ones too: the trainer drops those under [`MIN_HOLD_MS`]), and the recording's length in ms.
pub fn holds(pair: &Pair) -> Result<(Vec<Hold>, f64), String> {
    let ppg = read_ppg(&pair.ppg_csv)?;
    let imu = read_imu(&pair.imu_csv)?;
    let origin = ppg.rows.iter().chain(&imu.rows).map(|row| row.stamp).min().unwrap_or(0);
    let mut rows: Vec<(f64, &str)> = ppg
        .rows
        .iter()
        .chain(&imu.rows)
        .map(|row| ((row.stamp - origin) as f64 / 1e6, effective_label(&row.label, &row.manual)))
        .collect();
    rows.sort_by(|a, b| a.0.total_cmp(&b.0));
    let duration = rows.last().map_or(0.0, |row| row.0);
    let mut runs: Vec<(f64, f64, &str)> = Vec::new();
    for (at, label) in rows {
        match runs.last_mut() {
            Some(run) if run.2 == label => run.1 = at,
            _ => runs.push((at, at, label)),
        }
    }
    let mut out: Vec<Hold> = Vec::new();
    for (start, end, label) in runs {
        if label.is_empty() {
            continue;
        }
        match out.last_mut() {
            Some(hold) if hold.label == label && start - hold.end_ms < HOLD_MERGE_GAP_MS => hold.end_ms = end,
            _ => out.push(Hold { label: label.to_string(), start_ms: start, end_ms: end }),
        }
    }
    Ok((out, duration))
}

/// What to know about a recording's data before training on it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    /// The share of pulse samples the sensor flagged (contact quality above 0), 0 to 1.
    pub poor_contact_share: f64,
    /// How many holds of each label training uses (at least [`MIN_HOLD_MS`]).
    pub holds: BTreeMap<String, usize>,
    /// Holds too short for training, which it ignores.
    pub short_holds: usize,
}

/// The pair's quality report (see [`Quality`]).
pub fn quality_of(pair: &Pair) -> Result<Quality, String> {
    let ppg = read_ppg(&pair.ppg_csv)?;
    let flagged = ppg
        .rows
        .iter()
        .filter(|row| row.line.split(',').nth(5).and_then(|v| v.trim().parse::<f64>().ok()).is_some_and(|v| v > 0.0))
        .count();
    let (all, _) = holds(pair)?;
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut short = 0;
    for hold in &all {
        if hold.end_ms - hold.start_ms >= MIN_HOLD_MS {
            *counts.entry(hold.label.clone()).or_default() += 1;
        } else {
            short += 1;
        }
    }
    Ok(Quality {
        poor_contact_share: if ppg.rows.is_empty() { 0.0 } else { flagged as f64 / ppg.rows.len() as f64 },
        holds: counts,
        short_holds: short,
    })
}

/// What a pair holds, whatever its `#` lines say (a recording imported once as a single file and once as a folder carries
/// different ones): two recordings with the same identity hold the same rows, and one of them only duplicates the other.
pub fn rows_sha(ppg_csv: &str, imu_csv: &str) -> String {
    let rows = |text: &str| -> String {
        text.lines()
            .filter(|line| !line.trim_start().starts_with('#'))
            .collect::<Vec<_>>()
            .join("\n")
    };
    pair_sha(&rows(ppg_csv), &rows(imu_csv))
}

/// The identity of a pair of files, for sealing a model to the data it learned from.
pub fn pair_sha(ppg_csv: &str, imu_csv: &str) -> String {
    let mut bytes = Vec::with_capacity(ppg_csv.len() + imu_csv.len() + 1);
    bytes.extend_from_slice(ppg_csv.as_bytes());
    bytes.push(0x1f);
    bytes.extend_from_slice(imu_csv.as_bytes());
    model_lab_core::sha256_hex(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_lab::DATASET_CSV_HEADER;

    fn legacy(rows: &[&str], label_line: Option<&str>) -> String {
        let mut out = vec!["# gesture-dataset-export: 1".to_string()];
        if let Some(label) = label_line {
            out.push(format!("# label: {label}"));
        }
        out.push(DATASET_CSV_HEADER.join(","));
        out.extend(rows.iter().map(ToString::to_string));
        out.join("\n") + "\n"
    }

    // A pulse row, a motion row, a fused row (both), and a row with nothing.
    const PPG_ROW: &str = "100,1,10,20,30,,,,,,,,,,,0,pinch";
    const IMU_ROW: &str = "120,2,,,,0.1,0.2,0.3,0.4,0.5,0.6,1,0,0,0,,pinch";
    const BOTH_ROW: &str = "140,3,11,21,31,0.1,0.2,0.3,0.4,0.5,0.6,1,0,0,0,0,idle";
    const EMPTY_ROW: &str = "160,4,,,,,,,,,,,,,,,idle";

    #[test]
    fn a_single_file_is_split_into_two_dense_files_and_merges_back_to_the_same_rows() {
        let pair = split_legacy(&legacy(&[PPG_ROW, IMU_ROW, BOTH_ROW, EMPTY_ROW], None)).unwrap();
        assert_eq!((pair.ppg_rows, pair.imu_rows), (2, 2)); // the fused row is in both; the empty one is nowhere
        assert_eq!(pair.labels, ["idle", "pinch"]);
        let ppg: Vec<&str> = pair.ppg_csv.lines().collect();
        assert_eq!(ppg[0], ppg_header());
        assert_eq!(ppg[1], "100,1,10,20,30,0,pinch,", "with an empty manual_label");
        assert!(
            ppg.iter().skip(1).all(|row| !row.trim_end_matches(',').contains(",,")),
            "no blank cells in the pulse file: {ppg:?}"
        );
        let imu: Vec<&str> = pair.imu_csv.lines().collect();
        assert_eq!(imu[1], "120,2,0.1,0.2,0.3,0.4,0.5,0.6,1,0,0,0,pinch,");
        assert!(
            imu.iter().skip(1).all(|row| !row.trim_end_matches(',').contains(",,")),
            "no blank cells in the motion file"
        );
        // Merged back: every row is as it was, the fused one included, so the conversion is lossless in what a model reads.
        let merged = merge_to_legacy(&pair.ppg_csv, &pair.imu_csv).unwrap();
        let rows: Vec<&str> = merged
            .lines()
            .filter(|l| !l.starts_with('#'))
            .skip(1)
            .collect();
        assert_eq!(rows, [PPG_ROW, IMU_ROW, BOTH_ROW]);
    }

    #[test]
    fn a_single_label_declaration_goes_to_both_files_and_must_hold_on_every_row() {
        let pair = split_legacy(&legacy(&[PPG_ROW, IMU_ROW], Some("pinch"))).unwrap();
        assert!(pair.ppg_csv.contains("# label: pinch") && pair.imu_csv.contains("# label: pinch"));
        let wrong = pair.imu_csv.replace(",pinch", ",fist");
        assert!(
            parse_pair(&pair.ppg_csv, &wrong)
                .unwrap_err()
                .contains("labeled 'fist'")
        );
    }

    #[test]
    fn rows_with_no_label_are_the_time_between_marked_intervals_and_are_kept() {
        let pair = parse_pair(
            &format!("{}\n100,1,1,2,3,0,pinch,\n200,2,1,2,3,0,,\n", ppg_header()),
            &format!("{}\n150,1,0,0,0,0,0,0,1,0,0,0,,\n", imu_header()),
        )
        .unwrap();
        assert_eq!((pair.ppg_rows, pair.imu_rows), (2, 1));
        assert_eq!(pair.labels, ["pinch"]);
        let nothing = parse_pair(
            &format!("{}\n100,1,1,2,3,0,,\n", ppg_header()),
            &format!("{}\n", imu_header()),
        )
        .unwrap_err();
        assert!(nothing.contains("no labeled rows"));
    }

    #[test]
    fn a_file_with_the_wrong_header_width_or_order_is_refused_with_the_reason() {
        let good_imu = format!("{}\n100,1,0,0,0,0,0,0,1,0,0,0,pinch,\n", imu_header());
        let ppg = |row: &str| format!("{}\n{row}\n", ppg_header());
        assert!(
            parse_pair("timestamp_ns,label\n1,pinch\n", &good_imu)
                .unwrap_err()
                .contains("ppg.csv: the header")
        );
        assert!(
            parse_pair(&ppg("100,1,1,2,3,pinch"), &good_imu)
                .unwrap_err()
                .contains("ppg.csv: row 1: expected 8 columns, got 6")
        );
        assert!(
            parse_pair(&ppg("abc,1,1,2,3,0,pinch,"), &good_imu)
                .unwrap_err()
                .contains("not a whole number")
        );
        assert!(
            parse_pair(
                &format!(
                    "{}\n200,1,1,2,3,0,pinch,\n100,2,1,2,3,0,pinch,\n",
                    ppg_header()
                ),
                &good_imu
            )
            .unwrap_err()
            .contains("goes backwards")
        );
        assert!(
            parse_pair("", &good_imu)
                .unwrap_err()
                .contains("ppg.csv: it is empty")
        );
    }

    #[test]
    fn a_manual_label_wins_and_a_dash_means_nothing_here() {
        assert_eq!(effective_label("pinch", ""), "pinch");
        assert_eq!(effective_label("pinch", "fist"), "fist");
        assert_eq!(effective_label("pinch", NO_LABEL), "");
        assert_eq!(effective_label("", "fist"), "fist");
        let pair = parse_pair(
            &format!("{}\n100,1,1,2,3,0,pinch,fist\n200,2,1,2,3,0,pinch,-\n300,3,1,2,3,0,,\n", ppg_header()),
            &format!("{}\n150,1,0,0,0,0,0,0,1,0,0,0,pinch,\n", imu_header()),
        )
        .unwrap();
        assert_eq!(pair.labels, ["fist", "pinch"], "what the rows train on");
        // Merged for the Recordings tab, each row carries the label it trains on; for the Labelling page's single file, both.
        let legacy = merge_to_legacy(&pair.ppg_csv, &pair.imu_csv).unwrap();
        let rows: Vec<&str> = legacy.lines().skip(1).collect();
        assert_eq!(rows[0], "100,1,1,2,3,,,,,,,,,,,0,fist");
        assert_eq!(rows[2], "200,2,1,2,3,,,,,,,,,,,0,");
        let single = merge_to_single(&pair.ppg_csv, &pair.imu_csv).unwrap();
        assert!(single.lines().next().unwrap().ends_with(",label,manual_label"));
        assert!(single.contains("\n100,1,1,2,3,,,,,,,,,,,0,pinch,fist\n"));
        // And that single file splits back into the same pair.
        let back = split_legacy(&single).unwrap();
        assert_eq!((back.ppg_csv, back.imu_csv), (pair.ppg_csv, pair.imu_csv));
    }

    #[test]
    fn session_details_travel_with_the_files() {
        let context: BTreeMap<String, String> =
            [("arm".to_string(), "resting".to_string()), ("wrist".to_string(), "left".to_string())].into();
        let lines = context_lines(&context);
        assert_eq!(lines, ["# context.arm: resting", "# context.wrist: left"]);
        let single = format!(
            "# gesture-dataset-export: 1\n{}\n# label: \n{}\n100,1,10,20,30,,,,,,,,,,,0,pinch\n",
            lines.join("\n"),
            crate::model_lab::DATASET_CSV_HEADER.join(",")
        );
        let pair = split_legacy(&single).unwrap();
        assert_eq!(pair.context, context);
        assert!(pair.ppg_csv.starts_with("# context.arm: resting\n# context.wrist: left\n# label: \n"), "{}", pair.ppg_csv);
        assert!(!pair.ppg_csv.contains("gesture-dataset-export"), "other lines described the old single file");
        // A line with no value says nothing.
        assert!(context_of(["# context.notes: ", "# label: x"]).is_empty());
    }

    #[test]
    fn files_from_before_manual_labels_are_read_and_get_the_column() {
        let pair = parse_pair(
            &format!("{}\n100,1,1,2,3,0,pinch\n", PPG_HEADER_V1.join(",")),
            &format!("{}\n150,1,0,0,0,0,0,0,1,0,0,0,pinch\n", IMU_HEADER_V1.join(",")),
        )
        .unwrap();
        assert_eq!(pair.ppg_csv, format!("{}\n100,1,1,2,3,0,pinch,\n", ppg_header()));
        assert!(pair.imu_csv.ends_with(",pinch,\n"));
        // A recording with no label at all opens for labelling, though it cannot be stored for training as it is.
        let bare = format!("{}\n100,1,1,2,3,0,\n", PPG_HEADER_V1.join(","));
        let empty = format!("{}\n", IMU_HEADER_V1.join(","));
        assert!(parse_pair(&bare, &empty).is_err());
        assert_eq!(parse_pair_with(&bare, &empty, false).unwrap().ppg_rows, 1);
    }

    #[test]
    fn holds_are_joined_across_short_gaps_and_the_quality_report_counts_them() {
        let mut ppg = vec![ppg_header()];
        let mut push = |ms: i64, label: &str, manual: &str, contact: u8| {
            ppg.push(format!("{},1,1,2,3,{contact},{label},{manual}", 1_000_000_000 + ms * 1_000_000));
        };
        for ms in (0..=300).step_by(20) { push(ms, "pinch", "", 0); }
        for ms in (320..=380).step_by(20) { push(ms, "", "", 0); }
        for ms in (400..=600).step_by(20) { push(ms, "pinch", "", 2); }
        for ms in (620..=980).step_by(20) { push(ms, "", "", 0); }
        for ms in (1000..=1100).step_by(20) { push(ms, "pinch", "", 0); }
        for ms in (1120..=1980).step_by(20) { push(ms, "", "", 0); }
        for ms in (2000..=2400).step_by(20) { push(ms, "fist", "pinch", 0); }
        let pair = parse_pair(&(ppg.join("\n") + "\n"), &format!("{}\n", imu_header())).unwrap();
        let (found, duration) = holds(&pair).unwrap();
        let spans: Vec<(f64, f64)> = found.iter().map(|h| (h.start_ms, h.end_ms)).collect();
        assert_eq!(spans, [(0.0, 600.0), (1000.0, 1100.0), (2000.0, 2400.0)]);
        assert_eq!(duration, 2400.0);
        let quality = quality_of(&pair).unwrap();
        assert_eq!(quality.holds, BTreeMap::from([("pinch".to_string(), 2)]));
        assert_eq!(quality.short_holds, 1);
        assert!((quality.poor_contact_share - 11.0 / 121.0).abs() < 1e-9, "11 of the 121 pulse samples were flagged: {}", quality.poor_contact_share);
    }

    #[test]
    fn gaps_are_counted_where_a_stream_goes_quiet_for_more_than_a_quarter_of_a_second() {
        let ms = |t: i128| t * 1_000_000;
        // 25 Hz for one second, a 1.2 s silence, then 25 Hz for one more second.
        let mut stamps: Vec<i128> = (0..26).map(|i| ms(i * 40)).collect();
        stamps.extend((0..26).map(|i| ms(2200 + i * 40)));
        let found = gaps_of(&stamps);
        assert_eq!((found.samples, found.gaps), (52, 1));
        assert!((found.longest_gap_s - 1.2).abs() < 1e-9);
        assert!((found.rate_hz - 25.0).abs() < 0.01, "{}", found.rate_hz);
        assert!((found.share_in_gaps - 1.2 / 3.2).abs() < 1e-6);
        assert_eq!(gaps_of(&[5]).samples, 1);
        assert_eq!(gaps_of(&[]), StreamGaps::default());
    }

    #[test]
    fn what_a_pair_holds_is_its_rows_whatever_its_comment_lines() {
        let rows = format!("{}\n100,1,1,2,3,0,pinch,\n", ppg_header());
        let imu = format!("{}\n", imu_header());
        assert_eq!(rows_sha(&rows, &imu), rows_sha(&format!("# gesture-dataset-export: 1\n# label: \n{rows}"), &imu));
        assert_ne!(rows_sha(&rows, &imu), rows_sha(&rows.replace(",pinch,", ",fist,"), &imu));
    }

    #[test]
    fn the_identity_of_a_pair_changes_with_either_file_and_not_with_where_the_split_falls() {
        let a = pair_sha("ppg", "imu");
        assert_eq!(a, pair_sha("ppg", "imu"));
        assert_ne!(
            a,
            pair_sha("ppgi", "mu"),
            "the boundary is part of what is hashed"
        );
        assert_ne!(a, pair_sha("ppg", "imuX"));
    }
}
