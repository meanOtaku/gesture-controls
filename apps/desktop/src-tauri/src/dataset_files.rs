//! A recording as two dense files: `ppg.csv` (the pulse sensor's samples) and `imu.csv` (the motion sensors' samples), in
//! one folder with a small `dataset.json`. Each file has a row only where its own sensor produced a sample, so neither has
//! blank cells where the other sensor had nothing. Merged by timestamp the two files are exactly the single-file dataset the
//! app has always used (rows with the other sensor's columns empty), which is how the trainer reads them.
//!
//! This module is the format: the headers, validating a pair of files, splitting an older single file into a pair, merging a
//! pair back, a hash of a pair, and a report of the gaps in each stream. It never touches the disk.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

pub const PPG_FILE: &str = "ppg.csv";
pub const IMU_FILE: &str = "imu.csv";
pub const META_FILE: &str = "dataset.json";
pub const FORMAT_VERSION: u32 = 1;

pub const PPG_HEADER: [&str; 7] = [
    "timestamp_ns",
    "sequence",
    "ppg_green",
    "ppg_red",
    "ppg_ir",
    "contact_quality",
    "label",
];
pub const IMU_HEADER: [&str; 13] = [
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

/// The columns of the legacy single-file dataset (see `model_lab::DATASET_CSV_HEADER`), by what they belong to.
const LEGACY_COLUMNS: usize = 17;
const LEGACY_PPG: std::ops::Range<usize> = 2..5;
const LEGACY_IMU: std::ops::Range<usize> = 5..15;
const LEGACY_CONTACT: usize = 15;
const LEGACY_LABEL: usize = 16;

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

/// A pair of validated files, ready to store.
#[derive(Debug, PartialEq)]
pub struct Pair {
    pub ppg_csv: String,
    pub imu_csv: String,
    pub ppg_rows: usize,
    pub imu_rows: usize,
    /// Distinct labels on the stored rows, sorted.
    pub labels: Vec<String>,
    pub gaps: GapReport,
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

/// The rows of one file: (timestamp in ns, the whole line, its label), after the optional `#` lines and the exact header.
struct Rows<'a> {
    comments: Vec<&'a str>,
    header: &'a str,
    rows: Vec<(i128, &'a str, &'a str)>,
}

fn read_rows<'a>(
    name: &str,
    text: &'a str,
    header: &'a str,
    columns: usize,
) -> Result<Rows<'a>, String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut at = 0;
    let mut comments = Vec::new();
    while at < lines.len() && lines[at].trim_start().starts_with('#') {
        comments.push(lines[at]);
        at += 1;
    }
    match lines.get(at) {
        Some(found) if *found == header => {}
        Some(found) => {
            return Err(format!(
                "{name}: the header is not the one this file must have\n  expected: {header}\n  actual:   {found}"
            ));
        }
        None => return Err(format!("{name}: it is empty")),
    }
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
        rows.push((stamp, *line, fields[columns - 1].trim()));
    }
    Ok(Rows {
        comments,
        header: lines[at],
        rows,
    })
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

/// Validates a pair of files and returns them as they will be stored. Each must carry its exact header and rows of the right
/// width with timestamps that never go backwards. Labels work as in a single file: a `# label: X` line says every row is X;
/// otherwise rows with no label are the gaps between marked intervals and are dropped. At least one labelled row must remain.
pub fn parse_pair(ppg_text: &str, imu_text: &str) -> Result<Pair, String> {
    let (ppg_head, imu_head) = (ppg_header(), imu_header());
    let ppg = read_rows(PPG_FILE, ppg_text, &ppg_head, PPG_HEADER.len())?;
    let imu = read_rows(IMU_FILE, imu_text, &imu_head, IMU_HEADER.len())?;
    let mut labels = BTreeSet::new();
    let mut kept = Vec::new();
    for (name, rows) in [(PPG_FILE, &ppg), (IMU_FILE, &imu)] {
        let declared = declared_label(&rows.comments);
        let mut lines: Vec<&str> = Vec::new();
        let mut stamps: Vec<i128> = Vec::new();
        for (index, (stamp, line, label)) in rows.rows.iter().enumerate() {
            match (&declared, label.is_empty()) {
                (Some(want), true) => {
                    return Err(format!(
                        "{name}: row {}: no label, but the file declares '# label: {want}'",
                        index + 1
                    ));
                }
                (Some(want), false) if label != want => {
                    return Err(format!(
                        "{name}: row {}: labeled '{label}', but the file declares '# label: {want}'",
                        index + 1
                    ));
                }
                (None, true) => continue, // between marked intervals
                _ => {}
            }
            labels.insert((*label).to_string());
            lines.push(line);
            stamps.push(*stamp);
        }
        kept.push((lines, stamps));
    }
    if kept.iter().all(|(lines, _)| lines.is_empty()) {
        return Err("no labeled rows in either file: add a '# label: <value>' line for a single-label session, or label the rows".into());
    }
    let build = |rows: &Rows, lines: &[&str]| {
        let mut out: Vec<&str> = rows.comments.clone();
        out.push(rows.header);
        out.extend(lines.iter().copied());
        out.join("\n") + "\n"
    };
    let gaps = GapReport {
        ppg: gaps_of(&kept[0].1),
        imu: gaps_of(&kept[1].1),
    };
    Ok(Pair {
        ppg_csv: build(&ppg, &kept[0].0),
        imu_csv: build(&imu, &kept[1].0),
        ppg_rows: kept[0].0.len(),
        imu_rows: kept[1].0.len(),
        labels: labels.into_iter().collect(),
        gaps,
    })
}

/// Splits rows of the single-file dataset (already validated: 17 columns, labels settled) into the pair. A row with pulse
/// columns goes to `ppg.csv`; one with motion columns goes to `imu.csv`; a row that has both (an older fused export) goes
/// to both, and one with neither carries nothing and is left out. The `# label:` lines go to both files.
pub fn split_legacy(legacy_csv: &str) -> Result<Pair, String> {
    let lines: Vec<&str> = legacy_csv.lines().collect();
    let mut at = 0;
    let mut comments: Vec<&str> = Vec::new();
    while at < lines.len() && lines[at].trim_start().starts_with('#') {
        comments.push(lines[at]);
        at += 1;
    }
    // Only the label line is meaningful to the pair; the rest described the old single file.
    let kept_comments: Vec<&str> = comments
        .iter()
        .copied()
        .filter(|c| {
            c.trim_start()
                .trim_start_matches('#')
                .trim_start()
                .starts_with("label:")
        })
        .collect();
    let (mut ppg_rows, mut imu_rows): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    for (offset, line) in lines.iter().enumerate().skip(at + 1) {
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split(',').collect();
        if f.len() != LEGACY_COLUMNS {
            return Err(format!(
                "row {}: expected {LEGACY_COLUMNS} columns, got {}",
                offset - at,
                f.len()
            ));
        }
        let has = |range: std::ops::Range<usize>| f[range].iter().any(|v| !v.trim().is_empty());
        if has(LEGACY_PPG) {
            ppg_rows.push(format!(
                "{},{},{},{},{},{},{}",
                f[0], f[1], f[2], f[3], f[4], f[LEGACY_CONTACT], f[LEGACY_LABEL]
            ));
        }
        if has(LEGACY_IMU) {
            imu_rows.push(format!(
                "{},{},{},{}",
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
    parse_pair(
        &join(ppg_header(), &ppg_rows),
        &join(imu_header(), &imu_rows),
    )
}

#[cfg(test)]
/// The pair merged back into the single-file dataset: every row of both, in timestamp order (a tie puts the pulse row first),
/// with the other sensor's columns empty. What the trainer builds in memory.
pub fn merge_to_legacy(ppg_csv: &str, imu_csv: &str) -> Result<String, String> {
    let (ppg_head, imu_head) = (ppg_header(), imu_header());
    let ppg = read_rows(PPG_FILE, ppg_csv, &ppg_head, PPG_HEADER.len())?;
    let imu = read_rows(IMU_FILE, imu_csv, &imu_head, IMU_HEADER.len())?;
    let mut merged: Vec<(i128, u8, String)> = Vec::new();
    for (stamp, line, _) in &ppg.rows {
        let f: Vec<&str> = line.split(',').collect();
        merged.push((
            *stamp,
            0,
            format!(
                "{},{},{},{},{},,,,,,,,,,,{},{}",
                f[0], f[1], f[2], f[3], f[4], f[5], f[6]
            ),
        ));
    }
    for (stamp, line, _) in &imu.rows {
        let f: Vec<&str> = line.split(',').collect();
        merged.push((
            *stamp,
            1,
            format!("{},{},,,,{},,{}", f[0], f[1], f[2..12].join(","), f[12]),
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
    out.push(crate::model_lab::DATASET_CSV_HEADER.join(","));
    out.extend(merged.into_iter().map(|(_, _, line)| line));
    Ok(out.join("\n") + "\n")
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
        assert_eq!(ppg[1], "100,1,10,20,30,0,pinch");
        assert!(
            ppg.iter().skip(1).all(|row| !row.contains(",,")),
            "no blank cells in the pulse file: {ppg:?}"
        );
        let imu: Vec<&str> = pair.imu_csv.lines().collect();
        assert_eq!(imu[1], "120,2,0.1,0.2,0.3,0.4,0.5,0.6,1,0,0,0,pinch");
        assert!(
            imu.iter().skip(1).all(|row| !row.contains(",,")),
            "no blank cells in the motion file"
        );
        // Merged back: the rows that had one sensor are as they were, and the fused row is a row of each.
        let merged = merge_to_legacy(&pair.ppg_csv, &pair.imu_csv).unwrap();
        let rows: Vec<&str> = merged
            .lines()
            .filter(|l| !l.starts_with('#'))
            .skip(1)
            .collect();
        assert_eq!(rows[0], PPG_ROW);
        assert_eq!(rows[1], IMU_ROW);
        assert_eq!(rows.len(), 4);
        assert!(rows[2].starts_with("140,3,11,21,31,,,,") && rows[3].starts_with("140,3,,,,0.1"));
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
    fn rows_with_no_label_are_the_gaps_between_marked_intervals_and_are_dropped() {
        let pair = parse_pair(
            &format!("{}\n100,1,1,2,3,0,pinch\n200,2,1,2,3,0,\n", ppg_header()),
            &format!("{}\n150,1,0,0,0,0,0,0,1,0,0,0,\n", imu_header()),
        )
        .unwrap();
        assert_eq!((pair.ppg_rows, pair.imu_rows), (1, 0));
        assert_eq!(pair.labels, ["pinch"]);
        let nothing = parse_pair(
            &format!("{}\n100,1,1,2,3,0,\n", ppg_header()),
            &format!("{}\n", imu_header()),
        )
        .unwrap_err();
        assert!(nothing.contains("no labeled rows"));
    }

    #[test]
    fn a_file_with_the_wrong_header_width_or_order_is_refused_with_the_reason() {
        let good_imu = format!("{}\n100,1,0,0,0,0,0,0,1,0,0,0,pinch\n", imu_header());
        let ppg = |row: &str| format!("{}\n{row}\n", ppg_header());
        assert!(
            parse_pair("timestamp_ns,label\n1,pinch\n", &good_imu)
                .unwrap_err()
                .contains("ppg.csv: the header")
        );
        assert!(
            parse_pair(&ppg("100,1,1,2,3,pinch"), &good_imu)
                .unwrap_err()
                .contains("ppg.csv: row 1: expected 7 columns, got 6")
        );
        assert!(
            parse_pair(&ppg("abc,1,1,2,3,0,pinch"), &good_imu)
                .unwrap_err()
                .contains("not a whole number")
        );
        assert!(
            parse_pair(
                &format!(
                    "{}\n200,1,1,2,3,0,pinch\n100,2,1,2,3,0,pinch\n",
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
