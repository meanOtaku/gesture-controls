//! Copies of the same recording in an export folder: finding them, replacing the older copy when a recording is exported
//! again (after its labels were corrected), and clearing out the older copies already there.
//!
//! Two exported copies are of the same recording when they hold the same sensor samples: the same rows of `ppg.csv` and
//! `imu.csv` with the two label columns (`label`, `manual_label`) left out ([`signal_sha`]). Relabelling changes only those
//! columns, so every export of one recording has the same signal, however it was named or labelled; two different
//! recordings never do. An exported folder carries no other identity (its `dataset.json` has no dataset id), and the
//! names cannot be trusted: the Recorder's exports carry the time of the export, the Labelling page's are numbered.
//!
//! Hand labels are golden. An older copy is only replaced without asking when it cannot hold hand labels newer than the
//! export: it has none, it has the same labels, it is the copy being exported, or its files were not changed after it was
//! exported (`dataset.json`'s `exportedAtMs`). Otherwise the caller is told and the person decides. Copies are moved to the
//! Trash, never deleted, and only folders directly inside the chosen export folder are ever touched, never the app's own
//! datasets.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::dataset_files::{self, Meta};

/// The largest file read while scanning: a long session at the watch's rates is well under this.
const MAX_FILE_BYTES: u64 = 200 * 1024 * 1024;
/// How long after `exportedAtMs` a copy's files may still be written by the export itself.
const EXPORT_WRITE_SLACK_MS: u64 = 2_000;
/// The folder a single-CSV export's supporting files go in is named after the CSV with this after it.
const COMPANION_SUFFIX: &str = "-files";

/// One exported copy of a recording in an export folder.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportCopy {
    /// The copy's folder (for a single-CSV export, its supporting files' folder).
    pub path: String,
    pub name: String,
    /// The CSV of a single-CSV export, which goes with its folder.
    pub csv_path: Option<String>,
    /// The hash of its sensor samples, labels left out: equal for every copy of one recording.
    pub signal: String,
    /// When its files last changed (an export, or labels saved to it), ms since 1970.
    pub modified_ms: u64,
    /// When it was exported, for copies exported since this was recorded.
    pub exported_at_ms: Option<u64>,
    /// Whether its labels were changed after it was exported (unknown for older exports).
    pub relabelled_after_export: Option<bool>,
    pub ppg_rows: usize,
    pub imu_rows: usize,
    /// Rows with a hand label.
    pub hand_labelled_rows: usize,
    /// The labels its rows train on.
    pub labels: Vec<String>,
    /// What it is: `folder` (`ppg.csv` and `imu.csv`) or `csv` (one older single-file recording).
    pub kind: String,
    /// Which page wrote it, from what is in the folder: `labelling` (the Labelling page's export carries
    /// `manual_labels.json`) or `recorder` (the Recorder's, written when the recording stopped). `None` for a CSV.
    pub exported_from: Option<String>,
    /// The time in its name (`gesture-dataset-<label>-<time>`), ms since 1970: for a Recorder export, when it was exported.
    pub name_time_ms: Option<u64>,
    /// A hash of the label each row trains on: equal when two copies are labelled alike.
    #[serde(skip)]
    labels_sha: String,
}

impl ExportCopy {
    fn paths(&self) -> Vec<PathBuf> {
        let mut paths = vec![PathBuf::from(&self.path)];
        paths.extend(self.csv_path.as_ref().map(PathBuf::from));
        paths
    }
}

/// The copies of one recording, newest first: the first is the one kept.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CopyGroup {
    pub signal: String,
    pub copies: Vec<ExportCopy>,
    /// Why the first copy is the newest, when it is known.
    pub newest_reason: Option<String>,
    /// Whether the first copy is known to be the newest. Not when another copy with other labels was written at the same
    /// time (copies copied into the folder together get the time of the copy, not of their export): then nothing is chosen
    /// for the person, who must say which to keep.
    pub newest_known: bool,
}

/// What to do with earlier copies of the recording being exported.
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ExistingCopies {
    /// Replace them, unless one may hold newer hand labels: then nothing is written and the person is asked.
    #[default]
    Ask,
    /// Replace them (the person said so).
    Replace,
    /// Leave them and add another copy.
    KeepBoth,
}

/// What an export did.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    /// Where it was written; `None` when nothing was written because the person must choose (`needs_choice`).
    pub written: Option<String>,
    /// The earlier copies moved to the Trash.
    pub replaced: Vec<String>,
    /// Earlier copies of this recording, when one of them may hold newer hand labels than the export: ask, then export
    /// again with [`ExistingCopies::Replace`] or [`ExistingCopies::KeepBoth`].
    pub needs_choice: Vec<ExportCopy>,
    /// Something that went wrong after the export was written (an old copy that could not be moved to the Trash).
    pub warning: Option<String>,
}

/// The identity of a recording whatever its labels: its rows without the `label` and `manual_label` columns.
pub fn signal_sha(ppg_csv: &str, imu_csv: &str) -> Result<String, String> {
    let signal = |rows: dataset_files::Rows| -> String {
        rows.rows
            .iter()
            .map(|row| row.line.rsplitn(3, ',').nth(2).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n")
    };
    let ppg = signal(dataset_files::read_ppg(ppg_csv)?);
    let imu = signal(dataset_files::read_imu(imu_csv)?);
    Ok(dataset_files::pair_sha(&ppg, &imu))
}

/// What a copy's labels are: a hash of the label each row trains on (`ppg.csv`'s rows then `imu.csv`'s), how many rows
/// have a hand label, and the distinct labels.
fn labels_of(ppg_csv: &str, imu_csv: &str) -> Result<(String, usize, Vec<String>), String> {
    let ppg = dataset_files::read_ppg(ppg_csv)?;
    let imu = dataset_files::read_imu(imu_csv)?;
    let rows = ppg.rows.iter().chain(&imu.rows);
    let hand = rows.clone().filter(|row| !row.manual.is_empty()).count();
    let mut all = String::new();
    let mut distinct = std::collections::BTreeSet::new();
    for row in rows {
        let label = dataset_files::effective_label(&row.label, &row.manual);
        all.push_str(label);
        all.push('\n');
        if !label.is_empty() {
            distinct.insert(label.to_string());
        }
    }
    Ok((
        model_lab_core::sha256_hex(all.as_bytes()),
        hand,
        distinct.into_iter().collect(),
    ))
}

fn read_limited(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("{} is too large", path.display()));
    }
    fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The exported copy in `dir`, if it is one (a folder with `ppg.csv` and `imu.csv` that read as a pair).
fn read_copy(dir: &Path) -> Option<ExportCopy> {
    let name = dir.file_name()?.to_str()?.to_string();
    let ppg = read_limited(&dir.join(dataset_files::PPG_FILE)).ok()?;
    let imu = read_limited(&dir.join(dataset_files::IMU_FILE)).ok()?;
    let signal = signal_sha(&ppg, &imu).ok()?;
    let meta_path = dir.join(dataset_files::META_FILE);
    let meta: Option<Meta> = read_limited(&meta_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok());
    let exported_at_ms = meta.as_ref().and_then(|m| m.exported_at_ms);
    // A single-CSV export: `<name>.csv` beside its `<name>-files` folder. The CSV is the copy people open and label.
    let csv_path = name
        .strip_suffix(COMPANION_SUFFIX)
        .map(|stem| dir.with_file_name(format!("{stem}.csv")))
        .filter(|csv| csv.is_file());
    let csv_pair = csv_path
        .as_ref()
        .and_then(|csv| read_limited(csv).ok())
        .and_then(|text| dataset_files::split_legacy_with(&text, false).ok())
        .filter(|pair| signal_sha(&pair.ppg_csv, &pair.imu_csv).ok().as_ref() == Some(&signal));
    let (labels_sha, hand_labelled_rows, labels) = match &csv_pair {
        Some(pair) => labels_of(&pair.ppg_csv, &pair.imu_csv).ok()?,
        None => labels_of(&ppg, &imu).ok()?,
    };
    let mut data_ms = modified_ms(&dir.join(dataset_files::PPG_FILE))
        .max(modified_ms(&dir.join(dataset_files::IMU_FILE)));
    if let (Some(csv), Some(_)) = (&csv_path, &csv_pair) {
        data_ms = data_ms.max(modified_ms(csv));
    }
    let relabelled_after_export = exported_at_ms.map(|at| data_ms > at + EXPORT_WRITE_SLACK_MS);
    let pair = dataset_files::parse_pair_with(&ppg, &imu, false).ok()?;
    Some(ExportCopy {
        path: dir.display().to_string(),
        name,
        csv_path: csv_pair.and(csv_path).map(|csv| csv.display().to_string()),
        signal,
        modified_ms: data_ms.max(modified_ms(&meta_path)),
        exported_at_ms,
        relabelled_after_export,
        ppg_rows: pair.ppg_rows,
        imu_rows: pair.imu_rows,
        hand_labelled_rows,
        labels,
        kind: "folder".into(),
        exported_from: Some(
            if dir.join(MANUAL_LABELS_FILE).is_file() {
                "labelling"
            } else {
                "recorder"
            }
            .into(),
        ),
        name_time_ms: name_time_ms(&dir.display().to_string()),
        labels_sha,
    })
}

/// What the Labelling page's export writes beside the files: the hand labels as intervals (`labelling::copy_export_evidence`).
const MANUAL_LABELS_FILE: &str = "manual_labels.json";

/// The time in an export's name (`…-2026-11-06T05-33-16.844Z`, then perhaps `-2` or `.csv`), ms since 1970.
fn name_time_ms(path: &str) -> Option<u64> {
    let name = Path::new(path).file_name()?.to_str()?;
    let end = name.rfind('Z')?;
    let start = end.checked_sub(23)?;
    let stamp = name.get(start..=end)?;
    chrono::NaiveDateTime::parse_from_str(stamp, "%Y-%m-%dT%H-%M-%S%.3fZ")
        .ok()
        .and_then(|t| u64::try_from(t.and_utc().timestamp_millis()).ok())
}

/// A copy's name without a number an export added because the name was taken (`name-2` is `name`, 2), and its number
/// (1 when it has none).
fn numbered(path: &str) -> (PathBuf, String, u32) {
    let path = Path::new(path);
    let folder = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let name = name.strip_suffix(".csv").unwrap_or(name);
    if let Some((stem, number)) = name.rsplit_once('-')
        && !number.starts_with('0')
        && let Ok(number) = number.parse::<u32>()
        && (2..1000).contains(&number)
    {
        return (folder, stem.to_string(), number);
    }
    (folder, name.to_string(), 1)
}

/// Whether `a` is known to have been written after `b`, and how that is known: from their files' times when those differ;
/// when they were written at the same moment (copied together), from what the folders hold: a later number on the same
/// name, a Labelling-page export against the Recorder's (written when the recording stopped, before it could be
/// labelled), or, for two Recorder exports, the export time in their names.
fn later_than(a: &ExportCopy, b: &ExportCopy) -> Option<&'static str> {
    if a.modified_ms > b.modified_ms + EXPORT_WRITE_SLACK_MS {
        return Some("its files were changed last");
    }
    if b.modified_ms > a.modified_ms + EXPORT_WRITE_SLACK_MS {
        return None;
    }
    let (a_folder, a_stem, a_number) = numbered(&a.path);
    let (b_folder, b_stem, b_number) = numbered(&b.path);
    if a_folder == b_folder && a_stem == b_stem && a_number != b_number {
        return (a_number > b_number).then_some("it is a later numbered export of the same name");
    }
    match (a.exported_from.as_deref(), b.exported_from.as_deref()) {
        (Some("labelling"), Some("recorder")) => Some(
            "it was exported from the Labelling page, after the Recorder exported the recording when it stopped",
        ),
        (Some("recorder"), Some("labelling")) => None,
        (Some("recorder"), Some("recorder")) => match (a.name_time_ms, b.name_time_ms) {
            (Some(at), Some(bt)) if at > bt + EXPORT_WRITE_SLACK_MS => {
                Some("it was exported later (the time in its name)")
            }
            _ => None,
        },
        _ => None,
    }
}

/// An older single-file recording (`*.csv` with the dataset columns), if `path` is one.
fn read_csv_copy(path: &Path) -> Option<ExportCopy> {
    let name = path.file_name()?.to_str()?.to_string();
    let pair = dataset_files::split_legacy_with(&read_limited(path).ok()?, false).ok()?;
    let signal = signal_sha(&pair.ppg_csv, &pair.imu_csv).ok()?;
    let (labels_sha, hand_labelled_rows, labels) = labels_of(&pair.ppg_csv, &pair.imu_csv).ok()?;
    Some(ExportCopy {
        path: path.display().to_string(),
        name,
        csv_path: None,
        signal,
        modified_ms: modified_ms(path),
        exported_at_ms: None,
        relabelled_after_export: None,
        ppg_rows: pair.ppg_rows,
        imu_rows: pair.imu_rows,
        hand_labelled_rows,
        labels,
        kind: "csv".into(),
        exported_from: None,
        name_time_ms: name_time_ms(&path.display().to_string()),
        labels_sha,
    })
}

/// Every exported copy directly inside `folder` (never deeper; hidden and staging folders are skipped). These are the
/// folders an export writes, which is what an export replaces.
pub fn scan(folder: &Path) -> Result<Vec<ExportCopy>, String> {
    let entries =
        fs::read_dir(folder).map_err(|e| format!("could not read {}: {e}", folder.display()))?;
    let mut copies: Vec<ExportCopy> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|entry| read_copy(&entry.path()))
        .collect();
    copies.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(copies)
}

/// How deep a scan with subfolders goes, and how many folders it looks in at most.
const MAX_DEPTH: usize = 8;
const MAX_FOLDERS: usize = 20_000;

/// Every recording in `folder` for a clean-up: the exported folders and the older single-CSV recordings in it, and with
/// `subfolders` in every folder below it too (never following links, never inside a recording's own folder). A copy's
/// `name` is its path below `folder`.
pub fn scan_tree(folder: &Path, subfolders: bool) -> Result<Vec<ExportCopy>, String> {
    let mut copies = Vec::new();
    let mut pending = vec![(folder.to_path_buf(), 0usize)];
    let mut seen = 0usize;
    while let Some((dir, depth)) = pending.pop() {
        seen += 1;
        if seen > MAX_FOLDERS {
            return Err(format!(
                "{} holds more than {MAX_FOLDERS} folders: choose a smaller one",
                folder.display()
            ));
        }
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if depth == 0 => {
                return Err(format!("could not read {}: {error}", dir.display()));
            }
            Err(_) => continue,
        };
        let mut found_here = Vec::new();
        let mut companions = HashSet::new();
        let mut csvs = Vec::new();
        for entry in entries.filter_map(Result::ok) {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            // `file_type` does not follow links, so a link is never scanned and cannot loop.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                if let Some(copy) = read_copy(&path) {
                    if let Some(csv) = &copy.csv_path {
                        companions.insert(PathBuf::from(csv));
                    }
                    found_here.push(copy);
                } else if subfolders && depth < MAX_DEPTH {
                    pending.push((path, depth + 1));
                }
            } else if kind.is_file()
                && path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("csv"))
            {
                csvs.push(path);
            }
        }
        for csv in csvs {
            if !companions.contains(&csv)
                && let Some(copy) = read_csv_copy(&csv)
            {
                found_here.push(copy);
            }
        }
        for mut copy in found_here {
            copy.name = Path::new(&copy.path)
                .strip_prefix(folder)
                .map_or_else(|_| copy.name.clone(), |p| p.display().to_string());
            copies.push(copy);
        }
    }
    copies.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(copies)
}

/// Newest first: last changed, then the later name (a numbered copy is the later one).
fn newest_first(copies: &mut [ExportCopy]) {
    copies.sort_by(|a, b| {
        b.modified_ms
            .cmp(&a.modified_ms)
            .then_with(|| b.name.len().cmp(&a.name.len()))
            .then_with(|| b.name.cmp(&a.name))
    });
}

/// The recordings with more than one copy, each newest first.
pub fn groups(copies: Vec<ExportCopy>) -> Vec<CopyGroup> {
    let mut by_signal: BTreeMap<String, Vec<ExportCopy>> = BTreeMap::new();
    for copy in copies {
        by_signal.entry(copy.signal.clone()).or_default().push(copy);
    }
    let mut groups: Vec<CopyGroup> = by_signal
        .into_iter()
        .filter(|(_, copies)| copies.len() > 1)
        .map(|(signal, mut copies)| {
            newest_first(&mut copies);
            // The newest is the copy known to be later than every other with other labels (one labelled alike loses
            // nothing, whichever is kept).
            let newest = (0..copies.len()).find_map(|at| {
                let mut reasons = Vec::new();
                for (other_at, other) in copies.iter().enumerate() {
                    if other_at == at || other.labels_sha == copies[at].labels_sha {
                        continue;
                    }
                    let reason = later_than(&copies[at], other)?;
                    if !reasons.contains(&reason) {
                        reasons.push(reason);
                    }
                }
                Some((at, reasons))
            });
            let newest_known = newest.is_some();
            let newest_reason = newest.and_then(|(at, reasons)| {
                let copy = copies.remove(at);
                copies.insert(0, copy);
                (!reasons.is_empty()).then(|| format!("Newest because {}.", reasons.join("; ")))
            });
            CopyGroup {
                signal,
                copies,
                newest_reason,
                newest_known,
            }
        })
        .collect();
    groups.sort_by(|a, b| a.copies[0].name.cmp(&b.copies[0].name));
    groups
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// The earlier copies in `parent` of the recording about to be exported, and whether to replace them (`Ok(Ok(copies))`)
/// or ask first (`Ok(Err(copies))`). `source` is where the export is made from when it is a file or folder on disk.
pub fn plan(
    parent: &Path,
    ppg_csv: &str,
    imu_csv: &str,
    source: Option<&Path>,
    existing: ExistingCopies,
) -> Result<Result<Vec<ExportCopy>, Vec<ExportCopy>>, String> {
    if existing == ExistingCopies::KeepBoth {
        return Ok(Ok(Vec::new()));
    }
    // A recording the format cannot read has no earlier copies to find: the export goes ahead as before.
    let Ok(signal) = signal_sha(ppg_csv, imu_csv) else {
        return Ok(Ok(Vec::new()));
    };
    let (labels, _, _) = labels_of(ppg_csv, imu_csv)?;
    let mut copies: Vec<ExportCopy> = scan(parent)?
        .into_iter()
        .filter(|copy| copy.signal == signal)
        .collect();
    newest_first(&mut copies);
    if existing == ExistingCopies::Replace {
        return Ok(Ok(copies));
    }
    let may_hold_newer_labels = |copy: &ExportCopy| {
        let is_source = source.is_some_and(|s| copy.paths().iter().any(|p| same_path(p, s)));
        !is_source
            && copy.hand_labelled_rows > 0
            && copy.labels_sha != labels
            && copy.relabelled_after_export != Some(false)
    };
    Ok(if copies.iter().any(may_hold_newer_labels) {
        Err(copies)
    } else {
        Ok(copies)
    })
}

/// Whether `path` may be used for a new export: free, or held by a copy about to be replaced.
pub fn is_free(path: &Path, replacing: &[ExportCopy]) -> bool {
    !path.exists()
        || replacing
            .iter()
            .any(|c| c.paths().iter().any(|p| p == path))
}

/// Moves each copy (its folder and its CSV) to the Trash. Returns what was moved and, if one could not be, why.
pub fn trash_copies(copies: &[ExportCopy]) -> (Vec<String>, Option<String>) {
    let mut moved = Vec::new();
    for copy in copies {
        for path in copy.paths() {
            if !path.exists() {
                continue;
            }
            if let Err(error) = move_to_trash(&path) {
                return (moved, Some(error));
            }
            moved.push(path.display().to_string());
        }
    }
    (moved, None)
}

#[cfg(all(target_os = "macos", not(test)))]
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|error| {
            format!(
                "could not move {} to the Trash: {}",
                path.display(),
                error.localizedDescription()
            )
        })
}

#[cfg(all(not(target_os = "macos"), not(test)))]
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    Err(format!(
        "could not move {} to the Trash: this is only done on macOS",
        path.display()
    ))
}

/// Tests never fill the real Trash: a moved copy goes to a folder of its own under the temporary folder.
#[cfg(test)]
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    let bin = std::env::temp_dir()
        .join("export-copies-test-trash")
        .join(uuid::Uuid::new_v4().simple().to_string());
    fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    fs::rename(path, bin.join(path.file_name().unwrap_or_default())).map_err(|e| e.to_string())
}

/// Refuses a folder inside the app's own data: its datasets are never cleaned up from here.
fn check_export_folder(app: &AppHandle, folder: &Path) -> Result<PathBuf, String> {
    let folder = folder
        .canonicalize()
        .map_err(|_| format!("{} does not exist", folder.display()))?;
    if !folder.is_dir() {
        return Err(format!("{} is not a folder", folder.display()));
    }
    if let Ok(data) = app
        .path()
        .app_data_dir()
        .and_then(|d| Ok(d.canonicalize()?))
        && (folder.starts_with(&data) || data.starts_with(&folder))
    {
        return Err("that folder holds the app's own data: choose an export folder".into());
    }
    Ok(folder)
}

/// The recordings with more than one copy in a folder (and, with `subfolders`, the folders below it), each newest first
/// (the first is the one to keep). Read off the main thread: a folder of recordings can be a gigabyte.
#[tauri::command]
pub async fn scan_export_copies(
    folder: String,
    subfolders: Option<bool>,
    app: AppHandle,
) -> Result<Vec<CopyGroup>, String> {
    let folder = check_export_folder(&app, Path::new(&folder))?;
    let subfolders = subfolders.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || Ok(groups(scan_tree(&folder, subfolders)?)))
        .await
        .map_err(|e| e.to_string())?
}

/// What a clean-up did.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashOutcome {
    pub moved: Vec<String>,
    pub error: Option<String>,
}

/// Moves the chosen copies in a folder to the Trash. Each must be a copy the same scan finds (directly inside `folder`,
/// or below it with `subfolders`), and every recording must keep at least one copy that is not being moved: the folder is
/// scanned again here, so nothing chosen from an earlier scan is removed if it has changed since.
pub fn remove_copies(
    folder: &Path,
    paths: &[String],
    subfolders: bool,
) -> Result<TrashOutcome, String> {
    let copies = scan_tree(folder, subfolders)?;
    let chosen: HashSet<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let mut removing = Vec::new();
    for path in &chosen {
        let copy = copies
            .iter()
            .find(|c| Path::new(&c.path) == path)
            .ok_or_else(|| format!("{} is not an exported copy in this folder", path.display()))?;
        let kept = copies
            .iter()
            .any(|other| other.signal == copy.signal && !chosen.contains(Path::new(&other.path)));
        if !kept {
            return Err(format!(
                "{} is the last copy of its recording: it is kept",
                copy.name
            ));
        }
        removing.push(copy.clone());
    }
    removing.sort_by(|a, b| a.name.cmp(&b.name));
    let (moved, error) = trash_copies(&removing);
    Ok(TrashOutcome { moved, error })
}

#[tauri::command]
pub async fn trash_export_copies(
    folder: String,
    paths: Vec<String>,
    subfolders: Option<bool>,
    app: AppHandle,
) -> Result<TrashOutcome, String> {
    let folder = check_export_folder(&app, Path::new(&folder))?;
    // Paths from the scan were canonical; compare them as such.
    let paths: Vec<String> = paths
        .iter()
        .map(|p| {
            Path::new(p)
                .canonicalize()
                .map_or_else(|_| p.clone(), |c| c.display().to_string())
        })
        .collect();
    let subfolders = subfolders.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || remove_copies(&folder, &paths, subfolders))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "export-copies-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    const PPG_HEAD: &str =
        "timestamp_ns,sequence,ppg_green,ppg_red,ppg_ir,contact_quality,label,manual_label";
    const IMU_HEAD: &str = "timestamp_ns,sequence,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,quat_w,quat_x,quat_y,quat_z,label,manual_label";

    /// A tiny recording; `manual` is the hand label of every row, `offset` makes a different recording.
    fn pair(manual: &str, offset: i64) -> (String, String) {
        let ppg = format!(
            "# context.wrist: left\n{PPG_HEAD}\n{},1,10,20,30,0,pinch,{manual}\n{},2,11,21,31,0,,{manual}\n",
            100 + offset,
            140 + offset
        );
        let imu = format!(
            "{IMU_HEAD}\n{},1,0.1,0.2,0.3,0.4,0.5,0.6,1,0,0,0,pinch,{manual}\n",
            120 + offset
        );
        (ppg, imu)
    }

    fn write_copy(
        parent: &Path,
        name: &str,
        (ppg, imu): &(String, String),
        exported_at: Option<u64>,
    ) {
        let dir = parent.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("ppg.csv"), ppg).unwrap();
        fs::write(dir.join("imu.csv"), imu).unwrap();
        let meta = serde_json::json!({
            "formatVersion": 1, "ppgRows": 2, "imuRows": 1, "labels": ["pinch"], "exportedAtMs": exported_at,
        });
        fs::write(dir.join("dataset.json"), meta.to_string()).unwrap();
    }

    #[test]
    fn the_signal_is_the_same_whatever_the_labels_and_comments_and_differs_between_recordings() {
        let (ppg, imu) = pair("", 0);
        let (relabelled_ppg, relabelled_imu) = pair("snap", 0);
        let without_context = ppg.replace("# context.wrist: left\n", "");
        let same = signal_sha(&ppg, &imu).unwrap();
        assert_eq!(same, signal_sha(&relabelled_ppg, &relabelled_imu).unwrap());
        assert_eq!(same, signal_sha(&without_context, &imu).unwrap());
        // A file from before manual labels (no `manual_label` column) is the same recording too.
        let v1_ppg = format!(
            "{}\n100,1,10,20,30,0,pinch\n140,2,11,21,31,0,\n",
            PPG_HEAD.trim_end_matches(",manual_label")
        );
        assert_eq!(same, signal_sha(&v1_ppg, &imu).unwrap());
        let (other_ppg, other_imu) = pair("", 5);
        assert_ne!(same, signal_sha(&other_ppg, &other_imu).unwrap());
    }

    #[test]
    fn copies_of_one_recording_are_grouped_newest_first_and_others_are_left_out() {
        let parent = temp_dir("groups");
        write_copy(&parent, "session", &pair("", 0), None);
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_copy(&parent, "session-2", &pair("snap", 0), None);
        write_copy(&parent, "another", &pair("", 7), None);
        fs::create_dir_all(parent.join("not-a-dataset")).unwrap();
        fs::create_dir_all(parent.join(".hidden.exporting")).unwrap();
        let found = groups(scan(&parent).unwrap());
        assert_eq!(found.len(), 1);
        let names: Vec<&str> = found[0].copies.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["session-2", "session"]);
        assert_eq!(found[0].copies[0].hand_labelled_rows, 3);
        assert_eq!(found[0].copies[0].labels, ["snap"]);
        // Written 20 ms apart, so their times say nothing; the number an export added to the taken name does.
        assert!(found[0].newest_known);
        assert_eq!(
            found[0].newest_reason.as_deref(),
            Some("Newest because it is a later numbered export of the same name.")
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn the_newest_is_known_when_it_was_written_clearly_later_or_the_copies_have_the_same_labels() {
        let parent = temp_dir("newest");
        write_copy(&parent, "old", &pair("", 0), None);
        write_copy(&parent, "new", &pair("snap", 0), None);
        write_copy(&parent, "same", &pair("", 5), None);
        write_copy(&parent, "same-2", &pair("", 5), None);
        let set_time = |name: &str, ms: u64| {
            let time = UNIX_EPOCH + std::time::Duration::from_millis(ms);
            for file in ["ppg.csv", "imu.csv", "dataset.json"] {
                fs::File::options()
                    .write(true)
                    .open(parent.join(name).join(file))
                    .unwrap()
                    .set_modified(time)
                    .unwrap();
            }
        };
        set_time("old", 1_000_000);
        set_time("new", 1_000_000 + 60_000);
        let found = groups(scan(&parent).unwrap());
        assert_eq!(found.len(), 2);
        let relabelled = found
            .iter()
            .find(|g| g.copies.iter().any(|c| c.name == "new"))
            .unwrap();
        assert!(relabelled.newest_known);
        assert_eq!(relabelled.copies[0].name, "new");
        let identical = found
            .iter()
            .find(|g| g.copies.iter().any(|c| c.name == "same"))
            .unwrap();
        assert!(
            identical.newest_known,
            "copies with the same labels lose nothing whichever is kept"
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_single_csv_export_and_its_supporting_folder_are_one_copy() {
        let parent = temp_dir("csv");
        let files = pair("", 0);
        write_copy(&parent, "rec-files", &files, None);
        let single = dataset_files::merge_to_single(&files.0, &files.1).unwrap();
        fs::write(parent.join("rec.csv"), single).unwrap();
        let copies = scan(&parent).unwrap();
        assert_eq!(copies.len(), 1);
        assert_eq!(
            copies[0].csv_path.as_deref(),
            Some(parent.join("rec.csv").display().to_string().as_str())
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn an_earlier_copy_is_replaced_unless_it_may_hold_newer_hand_labels() {
        let parent = temp_dir("plan");
        let corrected = pair("snap", 0);
        // An older export with no hand labels: replaced.
        write_copy(&parent, "old", &pair("", 0), None);
        let planned = plan(
            &parent,
            &corrected.0,
            &corrected.1,
            None,
            ExistingCopies::Ask,
        )
        .unwrap();
        assert_eq!(planned.unwrap().len(), 1);
        // One exported (and not changed since) with other hand labels: replaced, its labels are the older ones.
        let at = now_ms();
        write_copy(&parent, "exported", &pair("pinch", 0), Some(at));
        let planned = plan(
            &parent,
            &corrected.0,
            &corrected.1,
            None,
            ExistingCopies::Ask,
        )
        .unwrap();
        assert_eq!(planned.unwrap().len(), 2);
        // One labelled after it was exported: ask.
        write_copy(&parent, "edited", &pair("pinch", 0), Some(at - 60_000));
        let planned = plan(
            &parent,
            &corrected.0,
            &corrected.1,
            None,
            ExistingCopies::Ask,
        )
        .unwrap();
        assert_eq!(planned.unwrap_err().len(), 3);
        // ...unless it is the copy being exported, or the person said to replace or keep both.
        let source = parent.join("edited");
        let planned = plan(
            &parent,
            &corrected.0,
            &corrected.1,
            Some(&source),
            ExistingCopies::Ask,
        )
        .unwrap();
        assert!(planned.is_ok());
        assert_eq!(
            plan(
                &parent,
                &corrected.0,
                &corrected.1,
                None,
                ExistingCopies::Replace
            )
            .unwrap()
            .unwrap()
            .len(),
            3
        );
        assert!(
            plan(
                &parent,
                &corrected.0,
                &corrected.1,
                None,
                ExistingCopies::KeepBoth
            )
            .unwrap()
            .unwrap()
            .is_empty()
        );
        // An older export with the same hand labels holds nothing newer.
        let same = temp_dir("plan-same");
        write_copy(&same, "old", &corrected, None);
        assert_eq!(
            plan(&same, &corrected.0, &corrected.1, None, ExistingCopies::Ask)
                .unwrap()
                .unwrap()
                .len(),
            1
        );
        // A different recording is never a copy.
        let (other_ppg, other_imu) = pair("snap", 9);
        assert!(
            plan(&parent, &other_ppg, &other_imu, None, ExistingCopies::Ask)
                .unwrap()
                .unwrap()
                .is_empty()
        );
        let _ = fs::remove_dir_all(&parent);
        let _ = fs::remove_dir_all(&same);
    }

    #[test]
    fn a_clean_up_never_removes_the_last_copy_or_anything_that_is_not_a_copy() {
        let parent = temp_dir("remove");
        write_copy(&parent, "a", &pair("", 0), None);
        write_copy(&parent, "b", &pair("", 0), None);
        write_copy(&parent, "lonely", &pair("", 3), None);
        let path = |n: &str| parent.join(n).display().to_string();
        assert!(remove_copies(&parent, &[path("a"), path("b")], false).is_err());
        assert!(remove_copies(&parent, &[path("lonely")], false).is_err());
        assert!(remove_copies(&parent, &["/etc".into()], false).is_err());
        assert!(remove_copies(&parent, &[parent.join("..").display().to_string()], false).is_err());
        // Nothing was touched by the refused requests.
        assert!(
            parent.join("a").is_dir()
                && parent.join("b").is_dir()
                && parent.join("lonely").is_dir()
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_clean_up_moves_the_chosen_older_copies_and_keeps_the_rest() {
        let parent = temp_dir("trash");
        write_copy(&parent, "a", &pair("", 0), None);
        write_copy(&parent, "a-2", &pair("snap", 0), None);
        write_copy(&parent, "a-3", &pair("snap", 0), None);
        let path = |n: &str| parent.join(n).display().to_string();
        let outcome = remove_copies(&parent, &[path("a"), path("a-2")], false).unwrap();
        assert_eq!(outcome.error, None);
        assert_eq!(outcome.moved, [path("a"), path("a-2")]);
        assert!(
            !parent.join("a").exists()
                && !parent.join("a-2").exists()
                && parent.join("a-3").is_dir()
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_scan_with_subfolders_finds_copies_in_any_folder_below_and_older_single_csv_recordings() {
        let parent = temp_dir("tree");
        let files = pair("", 0);
        write_copy(
            &parent.join("Hand labeled"),
            "session",
            &pair("snap", 0),
            None,
        );
        write_copy(&parent.join("old/october"), "session", &files, None);
        fs::write(
            parent.join("old/october/session.csv"),
            dataset_files::merge_to_single(&files.0, &files.1).unwrap(),
        )
        .unwrap();
        fs::write(parent.join("old/notes.csv"), "not,a,recording\n1,2,3\n").unwrap();
        // A link is never followed, so it cannot loop or reach outside.
        #[cfg(unix)]
        std::os::unix::fs::symlink(&parent, parent.join("old/loop")).unwrap();
        assert!(groups(scan_tree(&parent, false).unwrap()).is_empty());
        let found = groups(scan_tree(&parent, true).unwrap());
        assert_eq!(found.len(), 1);
        let mut names: Vec<&str> = found[0].copies.iter().map(|c| c.name.as_str()).collect();
        names.sort();
        assert_eq!(
            names,
            [
                "Hand labeled/session",
                "old/october/session",
                "old/october/session.csv"
            ]
        );
        let csv = found[0].copies.iter().find(|c| c.kind == "csv").unwrap();
        assert_eq!(csv.hand_labelled_rows, 0);
        // A clean-up of the same scan can remove what it found below, and keeps the last copy.
        let path = |n: &str| parent.join(n).display().to_string();
        assert!(remove_copies(&parent, &[path("old/october/session")], false).is_err());
        let outcome = remove_copies(
            &parent,
            &[path("old/october/session"), path("old/october/session.csv")],
            true,
        )
        .unwrap();
        assert_eq!(outcome.moved.len(), 2);
        assert!(parent.join("Hand labeled/session").is_dir());
        let _ = fs::remove_dir_all(&parent);
    }

    /// What a scan of a real folder finds, read-only: `SCAN_FOLDER=… cargo test -q scan_a_folder -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn scan_a_folder() {
        let folder = PathBuf::from(std::env::var("SCAN_FOLDER").expect("SCAN_FOLDER"));
        let started = std::time::Instant::now();
        let copies = scan_tree(&folder.canonicalize().unwrap(), true).unwrap();
        let count = copies.len();
        let found = groups(copies);
        println!(
            "{count} recordings, {} with copies ({} older copies, {} needing a choice) in {:.1} s",
            found.len(),
            found.iter().map(|g| g.copies.len() - 1).sum::<usize>(),
            found.iter().filter(|g| !g.newest_known).count(),
            started.elapsed().as_secs_f64()
        );
        for group in &found {
            let names: Vec<&str> = group.copies.iter().map(|c| c.name.as_str()).collect();
            println!(
                "  {}{}",
                if group.newest_known { "" } else { "? " },
                names.join("  |  ")
            );
            if let Some(reason) = &group.newest_reason {
                println!("      {reason}");
            }
        }
    }

    /// Gives every file of a copy the same time, as copying a set of folders does.
    fn set_time(dir: &Path, ms: u64) {
        let time = UNIX_EPOCH + std::time::Duration::from_millis(ms);
        for entry in fs::read_dir(dir).unwrap() {
            fs::File::options()
                .write(true)
                .open(entry.unwrap().path())
                .unwrap()
                .set_modified(time)
                .unwrap();
        }
    }

    #[test]
    fn copies_copied_together_are_ordered_by_what_their_folders_and_names_say() {
        let parent = temp_dir("metadata");
        // The Recorder's export, named when the recording stopped, and the Labelling page's later export of it, named
        // after when it started, with the hand labels beside it.
        let recorder = "gesture-dataset-pinch_in-2026-11-06T05-33-16.844Z";
        let labelling = "gesture-dataset-pinch_hold-2026-11-06T05-30-51.772Z";
        write_copy(&parent, recorder, &pair("", 0), None);
        write_copy(&parent, labelling, &pair("snap", 0), None);
        fs::write(parent.join(labelling).join("manual_labels.json"), "[]").unwrap();
        // Two Recorder exports of another recording: the one exported later is named later.
        let first = "gesture-dataset-snap-2026-11-19T13-59-20.292Z";
        let second = "gesture-dataset-snap-2026-11-19T14-01-30.339Z";
        write_copy(&parent, second, &pair("", 4), None);
        write_copy(&parent, first, &pair("snap", 4), None);
        // Two Labelling exports under different names: nothing says which came later.
        write_copy(&parent, "mine", &pair("", 8), None);
        write_copy(&parent, "yours", &pair("snap", 8), None);
        for name in ["mine", "yours"] {
            fs::write(parent.join(name).join("manual_labels.json"), "[]").unwrap();
        }
        for entry in fs::read_dir(&parent).unwrap() {
            set_time(&entry.unwrap().path(), 1_000_000);
        }
        let found = groups(scan(&parent).unwrap());
        let group_of = |name: &str| {
            found
                .iter()
                .find(|g| g.copies.iter().any(|c| c.name == name))
                .unwrap()
        };
        let pinch = group_of(recorder);
        assert!(pinch.newest_known);
        assert_eq!(pinch.copies[0].name, labelling);
        assert_eq!(pinch.copies[0].exported_from.as_deref(), Some("labelling"));
        assert!(
            pinch
                .newest_reason
                .as_deref()
                .unwrap()
                .contains("Labelling page")
        );
        let snap = group_of(first);
        assert!(snap.newest_known);
        assert_eq!(snap.copies[0].name, second);
        assert!(
            snap.newest_reason
                .as_deref()
                .unwrap()
                .contains("the time in its name")
        );
        let unknown = group_of("mine");
        assert!(!unknown.newest_known);
        assert_eq!(unknown.newest_reason, None);
        // File times that differ say it all, whatever the folders hold.
        set_time(&parent.join(recorder), 9_000_000);
        let found = groups(scan(&parent).unwrap());
        let pinch = found
            .iter()
            .find(|g| g.copies.iter().any(|c| c.name == recorder))
            .unwrap();
        assert_eq!(pinch.copies[0].name, recorder);
        assert_eq!(
            pinch.newest_reason.as_deref(),
            Some("Newest because its files were changed last.")
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_name_gives_its_time_and_the_number_an_export_added() {
        let stamp = |s: &str| {
            chrono::DateTime::parse_from_rfc3339(s)
                .unwrap()
                .timestamp_millis() as u64
        };
        assert_eq!(
            name_time_ms("/x/gesture-dataset-pinch-2026-11-19T14-25-09.185Z-2"),
            Some(stamp("2026-11-19T14:25:09.185Z"))
        );
        assert_eq!(
            name_time_ms("/x/gesture-dataset-pinch-2026-10-14T01-13-08.108Z.csv"),
            Some(stamp("2026-10-14T01:13:08.108Z"))
        );
        assert_eq!(name_time_ms("/x/session"), None);
        assert_eq!(numbered("/x/a-b-3").1, "a-b");
        assert_eq!(numbered("/x/a-b-3").2, 3);
        assert_eq!(numbered("/x/run-2026").2, 1);
        assert_eq!(numbered("/x/t-07").2, 1);
        assert_eq!(
            numbered("/x/name.csv"),
            (PathBuf::from("/x"), "name".to_string(), 1)
        );
    }

    #[test]
    fn a_path_held_by_a_copy_being_replaced_is_free() {
        let parent = temp_dir("free");
        write_copy(&parent, "session", &pair("", 0), None);
        let copies = scan(&parent).unwrap();
        assert!(!is_free(&parent.join("session"), &[]));
        assert!(is_free(&parent.join("session"), &copies));
        assert!(is_free(&parent.join("other"), &[]));
        let _ = fs::remove_dir_all(&parent);
    }
}
