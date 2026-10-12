//! Network designs: named, reusable recipes for the network a model is trained with.
//!
//! A design says what goes into the model (statistics of each window, or the dataset's own columns, and how many
//! readings of each), how the pulse sensor's spikes are pulled out, how long a window is, and the shape of the network and
//! how it learns. It says nothing about which label or recordings: the same design can teach any label. Training takes a
//! design and adds those (see [`NetworkDesign::apply_to`]), so a model is always made from exactly one named design.
//!
//! The built-in designs (one for each method, and one that reads all thirteen dataset columns) are fixed and are never
//! saved or deleted; a person's own are kept in a file in the model-lab folder, written atomically, and a design that does
//! not pass [`validate`] is never saved and is dropped if it fails when read back.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use model_lab_core::StreamSource;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tracing::warn;
use uuid::Uuid;

use crate::label_training::{BACKENDS, TrainRequest, preview_inputs};
use crate::model_lab::MODEL_LAB_DIR_NAME;
use crate::network_spec::NetworkSpec;

const FILE_NAME: &str = "network-designs.json";
pub const MAX_DESIGNS: usize = 100;
const MAX_NAME_CHARS: usize = 40;
const MAX_DESCRIPTION_CHARS: usize = 300;
pub const BUILT_IN_PREFIX: &str = "builtin-";
const COLUMNS: [&str; 13] = [
    "ppg_green",
    "ppg_red",
    "ppg_ir",
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
];
const LIGHTS: [&str; 3] = ["green", "red", "ir"];

fn one() -> u32 {
    1
}
fn window_default() -> u32 {
    500
}
fn statistics() -> String {
    "statistics".into()
}
fn none() -> String {
    "none".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDesign {
    /// Empty when new: the app gives it one. Built-in designs start with `builtin-`.
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// The training method: `logreg`, `mlp`, `torch-mlp` or `cnn1d`.
    pub method: String,
    /// `statistics` (averages, spread and so on of each window) or `raw` (the dataset's own columns, one neuron each).
    /// The convolutional method always reads columns, so for it this is `raw`.
    #[serde(default = "statistics")]
    pub input_mode: String,
    /// Statistics: the streams the model may read, which of the pulse sensor's lights, only how things change, and
    /// optionally exactly which statistics.
    #[serde(default)]
    pub sources: Vec<StreamSource>,
    #[serde(default)]
    pub ppg_channels: Option<Vec<String>>,
    #[serde(default)]
    pub movement_only: bool,
    #[serde(default)]
    pub features: Option<Vec<String>>,
    /// Columns (raw columns, and the convolutional method): which columns of the dataset the network reads, and how many
    /// readings of each (the steps each is laid onto).
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default = "one")]
    pub readings: u32,
    /// How the pulse sensor's spikes are pulled out (a spike method name), or `none`.
    #[serde(default = "none")]
    pub spike_method: String,
    /// How far back (milliseconds: 2000, 4000 or 8000) the pulse sensor's level is compared with, or none. Statistics only.
    #[serde(default)]
    pub baseline_ms: Option<u32>,
    #[serde(default = "window_default")]
    pub window_ms: u32,
    /// The network's shape and learning settings; absent means the method's own default.
    #[serde(default)]
    pub network: Option<NetworkSpec>,
    /// The convolutional method only: a pre-trained motion encoder (by name) to start from, and whether to keep its
    /// layers as they are (see `motion_encoders`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pretrained: Option<String>,
    #[serde(default)]
    pub pretrained_freeze: bool,
    /// Set by the app: a built-in design cannot be changed or deleted.
    #[serde(default)]
    pub built_in: bool,
}

impl NetworkDesign {
    fn columns_mode(&self) -> bool {
        self.method == "cnn1d" || self.input_mode == "raw"
    }

    /// The streams (and pulse lights) the design's columns need, or the statistics' own choice.
    fn needs(&self) -> (Vec<StreamSource>, Option<Vec<String>>) {
        if !self.columns_mode() {
            return (self.sources.clone(), self.ppg_channels.clone());
        }
        let mut sources = Vec::new();
        for column in &self.columns {
            let source = match column.split('_').next() {
                Some("ppg") => StreamSource::WatchPpg,
                Some("accel") => StreamSource::WatchAcceleration,
                Some("gyro") => StreamSource::WatchGyroscope,
                _ => StreamSource::WatchOrientation,
            };
            if !sources.contains(&source) {
                sources.push(source);
            }
        }
        let lights: Vec<String> = LIGHTS
            .iter()
            .filter(|light| self.columns.iter().any(|c| *c == format!("ppg_{light}")))
            .map(ToString::to_string)
            .collect();
        (
            sources,
            if lights.is_empty() {
                None
            } else {
                Some(lights)
            },
        )
    }

    /// Puts the design's choices into a training request. The label, recordings and what each other label means are the
    /// request's own: a design is about the network only.
    pub fn apply_to(&self, request: &mut TrainRequest) {
        let (sources, lights) = self.needs();
        request.backend = self.method.clone();
        request.sources = sources;
        request.ppg_channels = lights;
        request.movement_only = !self.columns_mode() && self.movement_only
            || self.method == "cnn1d" && self.movement_only;
        request.spike_method = Some(self.spike_method.clone());
        // A columns model keeps it to read its pulse channels against their recent past (the request's checks drop it
        // when nothing can use it).
        request.baseline_ms = self.baseline_ms;
        request.window_ms = self.window_ms;
        request.input_mode = if self.input_mode == "raw" && self.method != "cnn1d" {
            Some("raw".into())
        } else {
            None
        };
        request.grid_steps = if self.columns_mode() {
            Some(self.readings)
        } else {
            None
        };
        // Columns are chosen one by one, but the streams they come from provide every column of a stream: say exactly which.
        request.features = if self.columns_mode() {
            Some(self.columns.clone())
        } else {
            self.features.clone()
        };
        request.network = self.network.clone();
        request.pretrained = self.pretrained.clone().filter(|_| self.method == "cnn1d");
        request.pretrained_freeze = self.pretrained_freeze;
    }

    fn template_request(&self) -> TrainRequest {
        let mut request: TrainRequest = serde_json::from_value(serde_json::json!({
            "label": "x", "datasetIds": [], "negatives": [], "excludes": [], "backend": self.method, "sources": [],
        }))
        .expect("a minimal request is valid");
        self.apply_to(&mut request);
        request
    }
}

/// Every design, built-in and saved.
pub fn all_designs(app: &AppHandle) -> Result<Vec<NetworkDesign>, String> {
    Ok(everything(read_designs(&designs_path(app)?)))
}

/// Fills in a request that names a design with that design's choices; a request without one is returned as it is.
pub fn resolve_design(app: &AppHandle, mut request: TrainRequest) -> Result<TrainRequest, String> {
    let Some(id) = request.design_id.clone() else {
        return Ok(request);
    };
    let design = everything(read_designs(&designs_path(app)?))
        .into_iter()
        .find(|d| d.id == id)
        .ok_or("that network design no longer exists: choose another")?;
    design.apply_to(&mut request);
    Ok(request)
}

/// What a design would read, for the editor to show as it is edited.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignPreview {
    /// Why this design cannot be used, in words.
    pub problem: Option<String>,
    /// Every input the streams and settings provide, and the ones the model would read.
    pub available: Vec<String>,
    pub inputs: Vec<String>,
    /// How many input neurons that is.
    pub neurons: u32,
}

/// Refuses a design that cannot be trained or run, with the reason.
pub fn validate(design: &NetworkDesign) -> Result<(), String> {
    let name = design.name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(format!("the name must be 1 to {MAX_NAME_CHARS} characters"));
    }
    if design.description.chars().count() > MAX_DESCRIPTION_CHARS
        || design
            .description
            .chars()
            .any(|c| c.is_control() && c != '\n')
    {
        return Err(format!(
            "the description is at most {MAX_DESCRIPTION_CHARS} characters"
        ));
    }
    if !BACKENDS.contains(&design.method.as_str()) {
        return Err(format!(
            "unknown method '{}'; choose one of {BACKENDS:?}",
            design.method
        ));
    }
    match (design.input_mode.as_str(), design.method.as_str()) {
        ("statistics", "cnn1d") => {
            return Err("the convolutional method reads columns, not statistics".into());
        }
        ("statistics", _) | ("raw", _) => {}
        (other, _) => {
            return Err(format!(
                "unknown input mode '{other}'; choose statistics or raw"
            ));
        }
    }
    if !(100..=5000).contains(&design.window_ms) {
        return Err("the window length must be from 100 to 5000 ms".into());
    }
    if design.spike_method != "none"
        && label_inference::SpikeMethod::from_name(&design.spike_method).is_none()
    {
        return Err(format!(
            "unknown spike extraction method '{}'",
            design.spike_method
        ));
    }
    if let Some(ms) = design.baseline_ms
        && !label_inference::BASELINE_CHOICES_MS.contains(&ms)
    {
        return Err(format!(
            "the baseline must be one of {:?} milliseconds",
            label_inference::BASELINE_CHOICES_MS
        ));
    }
    if design.baseline_ms.is_some() && design.columns_mode() {
        return Err("a baseline is for statistics: a model that reads the dataset's columns reads the window itself".into());
    }
    if design.columns_mode() {
        if design.columns.is_empty() {
            return Err("choose at least one column for the network to read".into());
        }
        if let Some(bad) = design
            .columns
            .iter()
            .find(|c| !COLUMNS.contains(&c.as_str()))
        {
            return Err(format!("'{bad}' is not a column of the dataset"));
        }
        let (low, high) = if design.method == "cnn1d" {
            (8, 256)
        } else {
            (1, 64)
        };
        if !(low..=high).contains(&design.readings) {
            return Err(format!(
                "the readings per column must be from {low} to {high}, got {}",
                design.readings
            ));
        }
    } else {
        if design.sources.is_empty() {
            return Err("choose at least one data stream for the model to read".into());
        }
        if design.sources.contains(&StreamSource::HeadPose) {
            return Err("head pose is not available to trained models".into());
        }
        if let Some(bad) = design
            .ppg_channels
            .iter()
            .flatten()
            .find(|l| !LIGHTS.contains(&l.as_str()))
        {
            return Err(format!("unknown pulse sensor channel '{bad}'"));
        }
    }
    if let Some(network) = &design.network {
        network.validate(&design.method)?;
    }
    // The inputs have to resolve: this catches a feature name that does not exist, no pulse lights chosen, and the like.
    preview_inputs(&design.template_request()).map(|_| ())
}

/// The inputs a design would have, or the reason it cannot be used.
pub fn preview(design: &NetworkDesign) -> DesignPreview {
    match validate(design).and_then(|()| preview_inputs(&design.template_request())) {
        Ok(found) => DesignPreview {
            problem: None,
            available: found.available,
            inputs: found.inputs,
            neurons: found.neurons,
        },
        Err(problem) => {
            // Still say what is available, so the editor can keep offering the choices.
            let mut open = design.clone();
            open.features = None;
            let (available, inputs, neurons) = preview_inputs(&open.template_request())
                .map(|f| (f.available, Vec::new(), 0))
                .unwrap_or_default();
            DesignPreview {
                problem: Some(problem),
                available,
                inputs,
                neurons,
            }
        }
    }
}

fn base(id: &str, name: &str, description: &str, method: &str) -> NetworkDesign {
    NetworkDesign {
        id: format!("{BUILT_IN_PREFIX}{id}"),
        name: name.into(),
        description: description.into(),
        method: method.into(),
        input_mode: if method == "cnn1d" {
            "raw"
        } else {
            "statistics"
        }
        .into(),
        sources: vec![
            StreamSource::WatchAcceleration,
            StreamSource::WatchGyroscope,
        ],
        ppg_channels: None,
        movement_only: false,
        features: None,
        columns: Vec::new(),
        readings: 1,
        spike_method: "none".into(),
        baseline_ms: None,
        window_ms: 500,
        network: None,
        pretrained: None,
        pretrained_freeze: false,
        built_in: true,
    }
}

/// The designs that come with the app: each method as it has always been, and one that reads every dataset column.
pub fn built_in_designs() -> Vec<NetworkDesign> {
    let motion = vec![
        "accel_x".to_string(),
        "accel_y".into(),
        "accel_z".into(),
        "gyro_x".into(),
        "gyro_y".into(),
        "gyro_z".into(),
    ];
    let mut cnn = base(
        "cnn1d",
        "1D convolutional network",
        "Reads acceleration and gyroscope over a 1 second window, 32 steps each, with two convolution layers.",
        "cnn1d",
    );
    cnn.columns = motion;
    cnn.readings = 32;
    cnn.window_ms = 1000;
    let mut raw = base(
        "raw-columns-13",
        "Raw columns: all 13",
        "A small neural network that reads all thirteen dataset columns, one input neuron each (the latest reading of each).",
        "torch-mlp",
    );
    raw.input_mode = "raw".into();
    raw.columns = COLUMNS.iter().map(ToString::to_string).collect();
    // The pulse sensor's level against its recent past: the one thing that told a pinch from rest in the first recordings, and
    // the only form of it that carries over from one session to the next (the level itself is the session's).
    let mut level = base(
        "pulse-level",
        "Pulse level against the recent past",
        "Logistic regression on how far the pulse sensor's level sits above the low end of where it was in the last 4 seconds (the resting level). Made for a held pinch: the level itself differs from session to session, the change against the recent past does not.",
        "logreg",
    );
    level.sources = vec![StreamSource::WatchPpg];
    level.baseline_ms = Some(4000);
    level.features = Some(
        ["ppg_green_rel_low", "ppg_red_rel_low", "ppg_ir_rel_low"]
            .map(ToString::to_string)
            .to_vec(),
    );
    vec![
        level,
        base(
            "logreg",
            "Logistic regression",
            "Fast and simple statistics of acceleration and gyroscope. A good first try, and easy to trust.",
            "logreg",
        ),
        base(
            "mlp",
            "Small neural network (scikit-learn)",
            "Statistics of acceleration and gyroscope into two hidden layers of 32 and 16 neurons.",
            "mlp",
        ),
        base(
            "torch-mlp",
            "Small neural network (PyTorch)",
            "The same idea in PyTorch, which can be designed layer by layer and fine-tuned.",
            "torch-mlp",
        ),
        base(
            "gbt",
            "Boosted trees",
            "Statistics and motion dynamics of acceleration and gyroscope into 150 small decision trees. With few recordings it often beats a neural network.",
            "gbt",
        ),
        cnn,
        raw,
    ]
}

/// The saved designs in `path`, keeping only valid ones with their own ids. A missing or unreadable file is an empty list.
pub fn read_designs(path: &Path) -> Vec<NetworkDesign> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(all) = serde_json::from_str::<Vec<NetworkDesign>>(&text) else {
        warn!(path = %path.display(), "the network designs file could not be read; starting empty");
        return Vec::new();
    };
    let mut kept: Vec<NetworkDesign> = Vec::new();
    for mut design in all {
        design.built_in = false;
        match validate(&design) {
            Ok(())
                if !design.id.is_empty()
                    && !design.id.starts_with(BUILT_IN_PREFIX)
                    && !kept.iter().any(|d| d.id == design.id) =>
            {
                kept.push(design)
            }
            Ok(()) => {
                warn!(id = %design.id, "dropped a network design with a missing, built-in or repeated id")
            }
            Err(error) => warn!(id = %design.id, %error, "dropped an invalid saved network design"),
        }
    }
    kept.truncate(MAX_DESIGNS);
    kept
}

/// Writes the designs atomically (a temporary file, then a rename), so a crash leaves the old file or the new one.
pub fn write_designs(path: &Path, designs: &[NetworkDesign]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(designs).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Adds a design (an empty id gets `new_id`) or replaces the saved one with its id. Nothing changes if it is invalid, a
/// built-in is never replaced, and names stay unique (ignoring case, across the built-ins too).
pub fn upsert(
    saved: &[NetworkDesign],
    mut design: NetworkDesign,
    new_id: impl FnOnce() -> String,
) -> Result<Vec<NetworkDesign>, String> {
    if design.id.starts_with(BUILT_IN_PREFIX) {
        return Err("a built-in design cannot be changed: duplicate it and change the copy".into());
    }
    design.built_in = false;
    design.name = design.name.trim().to_string();
    validate(&design)?;
    if design.id.is_empty() {
        design.id = new_id();
    } else if !design
        .id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        || design.id.len() > 64
    {
        return Err("the design id is not valid".into());
    }
    if saved
        .iter()
        .chain(built_in_designs().iter())
        .any(|d| d.id != design.id && d.name.eq_ignore_ascii_case(&design.name))
    {
        return Err(format!("a design called '{}' already exists", design.name));
    }
    let mut next = saved.to_vec();
    if let Some(position) = next.iter().position(|d| d.id == design.id) {
        next[position] = design;
    } else if next.len() >= MAX_DESIGNS {
        return Err(format!(
            "the most designs allowed ({MAX_DESIGNS}) has been reached"
        ));
    } else {
        next.push(design);
    }
    Ok(next)
}

#[derive(Default)]
pub struct NetworkDesignRuntime {
    lock: Mutex<()>,
}

fn designs_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(MODEL_LAB_DIR_NAME).join(FILE_NAME))
        .map_err(|e| e.to_string())
}

fn everything(saved: Vec<NetworkDesign>) -> Vec<NetworkDesign> {
    let mut all = built_in_designs();
    all.extend(saved);
    all
}

/// Every design: the built-in ones first, then the person's own.
#[tauri::command]
pub fn list_network_designs(
    app: AppHandle,
    runtime: State<'_, NetworkDesignRuntime>,
) -> Result<Vec<NetworkDesign>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "the network designs lock was poisoned")?;
    Ok(everything(read_designs(&designs_path(&app)?)))
}

#[tauri::command]
pub fn save_network_design(
    design: NetworkDesign,
    app: AppHandle,
    runtime: State<'_, NetworkDesignRuntime>,
) -> Result<Vec<NetworkDesign>, String> {
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "the network designs lock was poisoned")?;
    let path = designs_path(&app)?;
    let next = upsert(&read_designs(&path), design, || {
        format!("design-{}", &Uuid::new_v4().simple().to_string()[..8])
    })?;
    write_designs(&path, &next)?;
    Ok(everything(next))
}

#[tauri::command]
pub fn delete_network_design(
    id: String,
    app: AppHandle,
    runtime: State<'_, NetworkDesignRuntime>,
) -> Result<Vec<NetworkDesign>, String> {
    if id.starts_with(BUILT_IN_PREFIX) {
        return Err("a built-in design cannot be deleted".into());
    }
    let _guard = runtime
        .lock
        .lock()
        .map_err(|_| "the network designs lock was poisoned")?;
    let path = designs_path(&app)?;
    let mut saved = read_designs(&path);
    let before = saved.len();
    saved.retain(|d| d.id != id);
    if saved.len() == before {
        return Err("there is no such design".into());
    }
    write_designs(&path, &saved)?;
    Ok(everything(saved))
}

/// What a design would read, for the editor, without saving it.
#[tauri::command]
pub fn preview_network_design(design: NetworkDesign) -> DesignPreview {
    preview(&design)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pulse_level_design_reads_only_the_level_features_against_a_four_second_baseline() {
        let level = built_in_designs()
            .into_iter()
            .find(|d| d.id == "builtin-pulse-level")
            .unwrap();
        validate(&level).unwrap();
        assert_eq!(
            (level.method.as_str(), level.baseline_ms),
            ("logreg", Some(4000))
        );
        let mut request = level.template_request();
        level.apply_to(&mut request);
        assert_eq!(request.baseline_ms, Some(4000));
        assert_eq!(request.sources, vec![StreamSource::WatchPpg]);
        let preview = preview(&level);
        assert_eq!(preview.problem, None);
        assert_eq!(preview.neurons, 3);
        assert!(preview.inputs.iter().all(|name| name.contains("_rel_")));
    }

    fn dense() -> NetworkDesign {
        let mut d = base("x", "My design", "", "torch-mlp");
        d.id = String::new();
        d.built_in = false;
        d
    }

    #[test]
    fn the_encoder_goes_with_a_convolutional_design_only_and_a_columns_design_keeps_its_pulse_baseline()
     {
        let mut cnn = base("cnn", "Mine", "", "cnn1d");
        cnn.input_mode = "raw".into();
        cnn.columns = vec!["accel_x".into(), "ppg_green".into()];
        cnn.readings = 32;
        cnn.pretrained = Some("motion-encoder".into());
        cnn.pretrained_freeze = true;
        cnn.baseline_ms = Some(4000);
        let request = cnn.template_request();
        assert_eq!(request.pretrained.as_deref(), Some("motion-encoder"));
        assert!(request.pretrained_freeze);
        assert_eq!(request.baseline_ms, Some(4000));
        let mut other = dense();
        other.pretrained = Some("motion-encoder".into());
        assert!(other.template_request().pretrained.is_none());
    }

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "network-designs-test-{}-{name}",
            Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn the_built_in_designs_are_valid_and_cover_each_method_and_all_thirteen_columns() {
        let all = built_in_designs();
        for design in &all {
            validate(design).unwrap_or_else(|e| panic!("{}: {e}", design.name));
            assert!(design.built_in && design.id.starts_with(BUILT_IN_PREFIX));
        }
        let methods: Vec<&str> = all.iter().map(|d| d.method.as_str()).collect();
        for method in BACKENDS {
            assert!(methods.contains(&method), "{method}");
        }
        let raw = all
            .iter()
            .find(|d| d.id == "builtin-raw-columns-13")
            .unwrap();
        assert_eq!(preview(raw).neurons, 13);
        assert_eq!(preview(raw).inputs.len(), 13);
        // Names are unique.
        let mut names: Vec<String> = all.iter().map(|d| d.name.to_lowercase()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), all.len());
    }

    #[test]
    fn a_good_design_is_accepted_and_each_bad_one_is_refused_with_a_reason() {
        assert!(validate(&dense()).is_ok());
        type Change = Box<dyn Fn(&mut NetworkDesign)>;
        let cases: Vec<(Change, &str)> = vec![
            (Box::new(|d| d.name = "  ".into()), "name"),
            (Box::new(|d| d.name = "x".repeat(41)), "name"),
            (Box::new(|d| d.description = "x".repeat(301)), "description"),
            (Box::new(|d| d.method = "forest".into()), "unknown method"),
            (
                Box::new(|d| d.input_mode = "pixels".into()),
                "unknown input mode",
            ),
            (
                Box::new(|d| {
                    d.method = "cnn1d".into();
                    d.input_mode = "statistics".into();
                }),
                "columns, not statistics",
            ),
            (Box::new(|d| d.window_ms = 20), "window length"),
            (
                Box::new(|d| d.spike_method = "soup".into()),
                "spike extraction",
            ),
            (Box::new(|d| d.sources = vec![]), "at least one data stream"),
            (
                Box::new(|d| d.sources = vec![StreamSource::HeadPose]),
                "head pose",
            ),
            (
                Box::new(|d| d.ppg_channels = Some(vec!["blue".into()])),
                "pulse sensor channel",
            ),
            (
                Box::new(|d| d.features = Some(vec!["ppg_green_mean".into()])),
                "not an input",
            ),
            (
                Box::new(|d| {
                    d.input_mode = "raw".into();
                    d.columns = vec![];
                }),
                "at least one column",
            ),
            (
                Box::new(|d| {
                    d.input_mode = "raw".into();
                    d.columns = vec!["accel_w".into()];
                }),
                "not a column",
            ),
            (
                Box::new(|d| {
                    d.input_mode = "raw".into();
                    d.columns = vec!["accel_x".into()];
                    d.readings = 65;
                }),
                "readings per column",
            ),
            (
                Box::new(|d| {
                    d.method = "cnn1d".into();
                    d.input_mode = "raw".into();
                    d.columns = vec!["accel_x".into()];
                    d.readings = 4;
                }),
                "readings per column",
            ),
            (
                Box::new(|d| d.baseline_ms = Some(3000)),
                "baseline must be one of",
            ),
            (
                Box::new(|d| {
                    d.input_mode = "raw".into();
                    d.columns = vec!["ppg_red".into()];
                    d.baseline_ms = Some(4000);
                }),
                "baseline is for statistics",
            ),
            (
                Box::new(|d| {
                    d.network = Some(
                        serde_json::from_value(serde_json::json!({"hidden": [{"units": 0}]}))
                            .unwrap(),
                    )
                }),
                "units",
            ),
            (
                Box::new(|d| {
                    d.method = "logreg".into();
                    d.network = Some(NetworkSpec::default());
                }),
                "neural network methods",
            ),
        ];
        for (change, message) in cases {
            let mut design = dense();
            change(&mut design);
            let error = validate(&design).unwrap_err();
            assert!(error.contains(message), "{error} should mention {message}");
        }
    }

    #[test]
    fn a_designs_inputs_follow_its_choices_and_it_applies_itself_to_a_training_request() {
        // Statistics: acceleration and gyroscope are 38 inputs (14 statistics and 5 motion dynamics each).
        let stats = dense();
        let found = preview(&stats);
        assert!(found.problem.is_none());
        assert_eq!(
            (found.neurons, found.inputs.len(), found.available.len()),
            (38, 38, 38)
        );
        // Raw columns: each column at each reading is a neuron.
        let mut raw = dense();
        raw.input_mode = "raw".into();
        raw.columns = vec![
            "accel_x".into(),
            "accel_y".into(),
            "gyro_z".into(),
            "ppg_ir".into(),
        ];
        raw.readings = 8;
        let found = preview(&raw);
        assert_eq!((found.neurons, found.inputs.len()), (32, 4));
        let mut request = raw.template_request();
        assert_eq!(request.backend, "torch-mlp");
        assert_eq!(request.input_mode.as_deref(), Some("raw"));
        assert_eq!(request.grid_steps, Some(8));
        assert_eq!(request.ppg_channels, Some(vec!["ir".to_string()])); // only the light whose column is ticked
        assert!(
            request.sources.contains(&StreamSource::WatchPpg)
                && !request.sources.contains(&StreamSource::WatchOrientation)
        );
        // The design is about the network: the label and recordings stay the request's own.
        request.label = "snap".into();
        request.dataset_ids = vec!["d1".into()];
        raw.apply_to(&mut request);
        assert_eq!(
            (request.label.as_str(), request.dataset_ids.len()),
            ("snap", 1)
        );
        // The convolutional method counts channels, not neurons.
        let mut cnn = dense();
        cnn.method = "cnn1d".into();
        cnn.input_mode = "raw".into();
        cnn.columns = vec!["accel_x".into(), "accel_y".into()];
        cnn.readings = 32;
        assert_eq!(preview(&cnn).neurons, 2);
        // A problem is explained, and the choices are still offered.
        let mut bad = dense();
        bad.features = Some(vec!["nope".into()]);
        let found = preview(&bad);
        assert!(found.problem.unwrap().contains("not an input"));
        assert_eq!(found.available.len(), 38);
    }

    #[test]
    fn designs_round_trip_through_the_file_and_a_damaged_one_is_dropped() {
        let path = temp("file.json");
        let mut a = dense();
        a.id = "design-aaaa".into();
        let mut b = dense();
        b.id = "design-bbbb".into();
        b.name = "Another".into();
        b.network = Some(
            serde_json::from_value(
                serde_json::json!({"hidden": [{"units": 9, "activation": "tanh"}]}),
            )
            .unwrap(),
        );
        write_designs(&path, &[a.clone(), b.clone()]).unwrap();
        assert!(!path.with_extension("json.tmp").exists());
        assert_eq!(read_designs(&path), [a.clone(), b.clone()]);
        // A hand-edited file: an invalid design, a repeated id, a built-in id and junk are all dropped; the rest stays.
        let mut bad = a.clone();
        bad.id = "design-cccc".into();
        bad.window_ms = 1;
        let mut repeat = a.clone();
        repeat.name = "Repeat".into();
        let mut claims = b.clone();
        claims.id = "builtin-logreg".into();
        claims.name = "Claims".into();
        write_designs(&path, &[a.clone(), bad, repeat, claims]).unwrap();
        assert_eq!(read_designs(&path), [a]);
        fs::write(&path, "not json").unwrap();
        assert!(read_designs(&path).is_empty());
        assert!(read_designs(&temp("missing.json")).is_empty());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn upsert_adds_with_a_new_id_replaces_by_id_and_keeps_names_unique_including_the_built_ins() {
        let first = upsert(&[], dense(), || "design-1".into()).unwrap();
        assert_eq!(first[0].id, "design-1");
        let mut renamed = first[0].clone();
        renamed.name = "Renamed".into();
        let replaced = upsert(&first, renamed, || unreachable!()).unwrap();
        assert_eq!((replaced.len(), replaced[0].name.as_str()), (1, "Renamed"));
        let mut twin = dense();
        twin.name = "renamed".into();
        assert!(
            upsert(&replaced, twin, || "design-2".into())
                .unwrap_err()
                .contains("already exists")
        );
        let mut clash = dense();
        clash.name = "LOGISTIC REGRESSION".into();
        assert!(
            upsert(&replaced, clash, || "design-3".into())
                .unwrap_err()
                .contains("already exists")
        ); // a built-in's name
        let mut builtin = built_in_designs().remove(0);
        builtin.description = "changed".into();
        assert!(
            upsert(&replaced, builtin, || unreachable!())
                .unwrap_err()
                .contains("cannot be changed")
        );
        let mut weird = dense();
        weird.id = "../escape".into();
        assert!(
            upsert(&replaced, weird, || unreachable!())
                .unwrap_err()
                .contains("id is not valid")
        );
        let mut invalid = dense();
        invalid.window_ms = 10;
        assert!(upsert(&replaced, invalid, || "design-4".into()).is_err());
    }

    #[test]
    fn the_library_has_a_limit() {
        let mut saved = Vec::new();
        for n in 0..MAX_DESIGNS {
            let mut d = dense();
            d.name = format!("Design {n}");
            saved = upsert(&saved, d, || format!("design-{n}")).unwrap();
        }
        let mut one_more = dense();
        one_more.name = "One more".into();
        assert!(
            upsert(&saved, one_more, || "design-x".into())
                .unwrap_err()
                .contains("most designs")
        );
    }
}
