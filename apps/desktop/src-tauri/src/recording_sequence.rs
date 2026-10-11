//! The order saved recordings came in: each gets a number (1 for the first) the first time it is listed, kept in a small
//! file beside the recordings, so "recording 3" keeps meaning the same recording after others are deleted. A number is
//! never given to another recording. Recordings that already existed are numbered by when they were saved.
//!
//! Nothing inside a recording is changed: the numbers live only in `sequence.json` next to the recording folders.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "sequence.json";

/// Serializes numbering, so two listings at once never hand out the same number twice.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sequence {
    pub numbers: BTreeMap<String, u32>,
    pub next: u32,
}

impl Sequence {
    /// Numbers the recordings that have no number yet, oldest first (`saved_at`, then id, so the result never depends on
    /// the order they were read in), and forgets numbers of recordings that no longer exist. True if anything changed.
    pub fn assign(&mut self, present: &[(String, String)]) -> bool {
        let before = (self.numbers.clone(), self.next);
        self.next = self
            .next
            .max(self.numbers.values().copied().max().unwrap_or(0) + 1);
        let mut fresh: Vec<&(String, String)> = present
            .iter()
            .filter(|(id, _)| !self.numbers.contains_key(id))
            .collect();
        fresh.sort_by(|a, b| (&a.1, &a.0).cmp(&(&b.1, &b.0)));
        for (id, _) in fresh {
            self.numbers.insert(id.clone(), self.next);
            self.next += 1;
        }
        self.numbers
            .retain(|id, _| present.iter().any(|(p, _)| p == id));
        (self.numbers.clone(), self.next) != before
    }
}

/// Numbers for these recordings (id, saved at), read from and saved to `dir/sequence.json`. If the file cannot be written
/// the numbers are still returned; they are then worked out again next time.
pub fn numbers_for(dir: &Path, present: &[(String, String)]) -> BTreeMap<String, u32> {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = dir.join(FILE_NAME);
    let mut sequence = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Sequence>(&text).ok())
        .unwrap_or_default();
    if sequence.assign(present) {
        let tmp = path.with_extension("json.tmp");
        let saved = serde_json::to_string_pretty(&sequence)
            .map_err(|e| e.to_string())
            .and_then(|json| fs::write(&tmp, json).map_err(|e| e.to_string()))
            .and_then(|()| fs::rename(&tmp, &path).map_err(|e| e.to_string()));
        if let Err(error) = saved {
            tracing::warn!(%error, "could not save the recording order");
        }
    }
    sequence.numbers
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &str, at: &str) -> (String, String) {
        (id.into(), at.into())
    }

    #[test]
    fn existing_recordings_are_numbered_oldest_first_and_new_ones_continue_from_there() {
        let mut sequence = Sequence::default();
        assert!(sequence.assign(&[
            rec("zzz", "2026-10-01"),
            rec("aaa", "2026-10-03"),
            rec("mmm", "2026-10-02")
        ]));
        assert_eq!(sequence.numbers["zzz"], 1);
        assert_eq!(sequence.numbers["mmm"], 2);
        assert_eq!(sequence.numbers["aaa"], 3);
        assert!(!sequence.assign(&[
            rec("zzz", "2026-10-01"),
            rec("aaa", "2026-10-03"),
            rec("mmm", "2026-10-02")
        ]));
        assert!(sequence.assign(&[
            rec("zzz", "x"),
            rec("aaa", "x"),
            rec("mmm", "x"),
            rec("new", "2026-10-09")
        ]));
        assert_eq!(sequence.numbers["new"], 4);
    }

    #[test]
    fn a_number_is_not_given_again_after_its_recording_is_deleted() {
        let mut sequence = Sequence::default();
        sequence.assign(&[rec("a", "1"), rec("b", "2"), rec("c", "3")]);
        sequence.assign(&[rec("a", "1"), rec("b", "2")]); // c is deleted
        assert!(!sequence.numbers.contains_key("c"));
        sequence.assign(&[rec("a", "1"), rec("b", "2"), rec("d", "4")]);
        assert_eq!(sequence.numbers["d"], 4);
        assert_eq!(sequence.numbers["a"], 1);
    }

    #[test]
    fn numbers_are_kept_between_listings() {
        let dir = std::env::temp_dir().join(format!(
            "recording-sequence-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let first = numbers_for(&dir, &[rec("a", "1"), rec("b", "2")]);
        let second = numbers_for(&dir, &[rec("b", "2"), rec("a", "1"), rec("c", "0")]); // c is older but came later
        assert_eq!((first["a"], first["b"]), (1, 2));
        assert_eq!((second["a"], second["b"], second["c"]), (1, 2, 3));
        let _ = fs::remove_dir_all(&dir);
    }
}
