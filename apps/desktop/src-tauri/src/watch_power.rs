//! What streaming costs the watch, from the counters it reports with every few heartbeats (`WatchStatsReport`): battery
//! drain and average current, CPU time, how often the motion sensors woke the app, each sensor's achieved rate, and what
//! went over the link. Rates come from the difference between two reports, so they hold whatever the report interval.
//!
//! A **measurement** is a stretch you start and stop (say 30 minutes on the desk with batching off, then on): its result
//! is the rates over the whole stretch plus the link delay sampled through it, kept in `watch-measurements.json` to
//! compare runs. Nothing here changes what the watch does.

use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use spatial_protocol::WatchStatsReport;
use tauri::{AppHandle, Emitter, Manager, State};

pub const WATCH_POWER_EVENT: &str = "watch-power";
const MEASUREMENTS_FILE: &str = "watch-measurements.json";
/// The live rates are over about the last minute of reports.
const LIVE_WINDOW_MS: u64 = 60_000;
/// A measurement shorter than this says too little about battery to be worth keeping as a comparison.
const SHORT_RUN_MS: u64 = 10 * 60_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorRate {
    pub id: String,
    pub name: String,
    pub registered: bool,
    pub requested_hz: Option<f64>,
    pub achieved_hz: f64,
    pub fifo_max_events: u32,
}

/// Rates between two reports.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerRates {
    pub seconds: f64,
    /// From the battery percentage: coarse, so only meaningful over tens of minutes.
    pub battery_percent_per_hour: Option<f64>,
    /// From the charge counter: the average current drawn, in mA.
    pub average_draw_ma: Option<f64>,
    /// The watch app's share of one CPU core.
    pub cpu_percent: Option<f64>,
    /// How often the motion sensors' events reached the app: the wakes that hardware batching cuts.
    pub sensor_deliveries_per_second: f64,
    pub sensors: Vec<SensorRate>,
    pub ppg_hz: f64,
    pub ppg_deliveries_per_second: f64,
    pub messages_per_second: f64,
    pub bytes_per_second: f64,
    pub dropped_messages: u64,
    pub refused_sends: u64,
    /// The watch was on its charger at either end: battery figures are meaningless then.
    pub charging: bool,
    pub temperature_c: Option<f64>,
}

/// The rates from report `a` to the later report `b`; None when `b` is not later, or the watch's counters went back
/// (it restarted), so the two cannot be compared.
pub fn rates_between(a: &WatchStatsReport, b: &WatchStatsReport) -> Option<PowerRates> {
    if b.elapsed_ms <= a.elapsed_ms
        || b.messages < a.messages
        || b.sensor_deliveries < a.sensor_deliveries
        || b.ppg_samples < a.ppg_samples
    {
        return None;
    }
    let seconds = (b.elapsed_ms - a.elapsed_ms) as f64 / 1000.0;
    let hours = seconds / 3600.0;
    let per_second = |later: u64, earlier: u64| later.saturating_sub(earlier) as f64 / seconds;
    let battery_a = a.battery.as_ref();
    let battery_b = b.battery.as_ref();
    let charging = battery_a.and_then(|x| x.charging).unwrap_or(false) || battery_b.and_then(|x| x.charging).unwrap_or(false);
    let battery_percent_per_hour = match (battery_a.and_then(|x| x.percent), battery_b.and_then(|x| x.percent)) {
        (Some(before), Some(after)) => Some((f64::from(before) - f64::from(after)) / hours),
        _ => None,
    };
    let average_draw_ma = match (battery_a.and_then(|x| x.charge_uah), battery_b.and_then(|x| x.charge_uah)) {
        (Some(before), Some(after)) => Some((before - after) as f64 / 1000.0 / hours),
        _ => None,
    };
    let cpu_percent = match (a.cpu_ms, b.cpu_ms) {
        (Some(before), Some(after)) if after >= before => Some((after - before) as f64 / (b.elapsed_ms - a.elapsed_ms) as f64 * 100.0),
        _ => None,
    };
    let sensors = b
        .sensors
        .iter()
        .map(|sensor| {
            let before = a.sensors.iter().find(|s| s.id == sensor.id).map(|s| s.events).unwrap_or(sensor.events);
            SensorRate {
                id: sensor.id.clone(),
                name: sensor.name.clone(),
                registered: sensor.registered,
                requested_hz: sensor.requested_period_us.filter(|us| *us > 0).map(|us| 1_000_000.0 / f64::from(us)),
                achieved_hz: per_second(sensor.events, before),
                fifo_max_events: sensor.fifo_max_events,
            }
        })
        .collect();
    Some(PowerRates {
        seconds,
        battery_percent_per_hour,
        average_draw_ma,
        cpu_percent,
        sensor_deliveries_per_second: per_second(b.sensor_deliveries, a.sensor_deliveries),
        sensors,
        ppg_hz: per_second(b.ppg_samples, a.ppg_samples),
        ppg_deliveries_per_second: per_second(b.ppg_deliveries, a.ppg_deliveries),
        messages_per_second: per_second(b.messages, a.messages),
        bytes_per_second: per_second(b.bytes, a.bytes),
        dropped_messages: b.dropped_messages.saturating_sub(a.dropped_messages),
        refused_sends: b.refused_sends.saturating_sub(a.refused_sends),
        charging,
        temperature_c: battery_b.and_then(|x| x.temperature_c),
    })
}

/// A finished measurement, kept to compare with others.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchMeasurement {
    pub id: String,
    pub label: String,
    pub started_at: String,
    pub ended_at: String,
    pub rates: Option<PowerRates>,
    /// The median, over the run, of how old motion samples were when they arrived (the link's p50 and p95).
    pub delay_p50_ms: Option<f64>,
    pub delay_p95_ms: Option<f64>,
    /// Anything that makes the result less trustworthy: charging, a restart, too short.
    pub notes: Vec<String>,
}

struct Run {
    label: String,
    started_at: String,
    first: Option<WatchStatsReport>,
    last: Option<WatchStatsReport>,
    delays_p50: Vec<f64>,
    delays_p95: Vec<f64>,
    notes: Vec<String>,
}

impl Run {
    fn observe(&mut self, report: &WatchStatsReport, delay: (Option<u64>, Option<u64>)) {
        if let Some(last) = &self.last
            && rates_between(last, report).is_none()
        {
            self.notes.push("the watch restarted during the run; it is measured from the restart".into());
            self.first = None;
        }
        if self.first.is_none() {
            self.first = Some(report.clone());
        }
        self.last = Some(report.clone());
        if let Some(p50) = delay.0 {
            self.delays_p50.push(p50 as f64);
        }
        if let Some(p95) = delay.1 {
            self.delays_p95.push(p95 as f64);
        }
    }

    fn rates(&self) -> Option<PowerRates> {
        rates_between(self.first.as_ref()?, self.last.as_ref()?)
    }

    fn finish(mut self, id: String) -> WatchMeasurement {
        let rates = self.rates();
        if rates.as_ref().is_some_and(|r| r.charging) {
            self.notes.push("the watch was charging: its battery figures do not count".into());
        }
        match &rates {
            None => self.notes.push("no two reports from the watch: nothing measured (is a watch with this build connected?)".into()),
            Some(r) if r.seconds * 1000.0 < SHORT_RUN_MS as f64 => {
                self.notes.push(format!("only {:.0} minutes: battery figures need 10 or more", r.seconds / 60.0))
            }
            Some(_) => {}
        }
        WatchMeasurement {
            id,
            label: self.label,
            started_at: self.started_at,
            ended_at: now(),
            rates,
            delay_p50_ms: median(&mut self.delays_p50),
            delay_p95_ms: median(&mut self.delays_p95),
            notes: self.notes,
        }
    }
}

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    Some(if values.len() % 2 == 1 { values[mid] } else { (values[mid - 1] + values[mid]) / 2.0 })
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// What the Watch page shows: the last minute's rates, and the measurement under way.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchPowerView {
    pub live: Option<PowerRates>,
    /// The watch has never sent a report: its build predates them.
    pub reporting: bool,
    pub run: Option<RunView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    pub label: String,
    pub started_at: String,
    pub rates: Option<PowerRates>,
}

#[derive(Default)]
struct Inner {
    recent: VecDeque<WatchStatsReport>,
    run: Option<Run>,
}

/// Keeps the recent reports and the measurement under way.
#[derive(Default)]
pub struct WatchPower {
    inner: Mutex<Inner>,
}

impl WatchPower {
    /// Takes one report, with the link's motion delay at that moment, and returns the view to publish.
    pub fn observe(&self, report: WatchStatsReport, delay: (Option<u64>, Option<u64>)) -> Option<WatchPowerView> {
        let mut inner = self.inner.lock().ok()?;
        if let Some(last) = inner.recent.back()
            && rates_between(last, &report).is_none()
        {
            inner.recent.clear(); // a restarted watch starts its counters again
        }
        inner.recent.push_back(report.clone());
        while inner.recent.len() > 2 && report.elapsed_ms - inner.recent[1].elapsed_ms >= LIVE_WINDOW_MS {
            inner.recent.pop_front();
        }
        if let Some(run) = inner.run.as_mut() {
            run.observe(&report, delay);
        }
        Some(view_of(&inner))
    }

    pub fn view(&self) -> WatchPowerView {
        self.inner.lock().map(|inner| view_of(&inner)).unwrap_or(WatchPowerView { live: None, reporting: false, run: None })
    }
}

fn view_of(inner: &Inner) -> WatchPowerView {
    let live = match (inner.recent.front(), inner.recent.back()) {
        (Some(first), Some(last)) => rates_between(first, last),
        _ => None,
    };
    WatchPowerView {
        live,
        reporting: !inner.recent.is_empty(),
        run: inner.run.as_ref().map(|run| RunView { label: run.label.clone(), started_at: run.started_at.clone(), rates: run.rates() }),
    }
}

fn measurements_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(MEASUREMENTS_FILE))
}

fn read_measurements(app: &AppHandle) -> Vec<WatchMeasurement> {
    measurements_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_measurements(app: &AppHandle, list: &[WatchMeasurement]) -> Result<(), String> {
    let path = measurements_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Called with each heartbeat that carries a report: updates the rates and publishes them.
pub fn on_report(app: &AppHandle, report: WatchStatsReport) {
    let delay = app
        .try_state::<std::sync::Arc<watch_bridge::WatchBridgeServer>>()
        .map(|server| {
            let diagnostics = server.link_diagnostics();
            (diagnostics.delay_p50_ms, diagnostics.delay_p95_ms)
        })
        .unwrap_or((None, None));
    if let Some(power) = app.try_state::<WatchPower>()
        && let Some(view) = power.observe(report, delay)
    {
        let _ = app.emit(WATCH_POWER_EVENT, view);
    }
}

#[tauri::command]
pub fn get_watch_power(power: State<'_, WatchPower>) -> WatchPowerView {
    power.view()
}

/// Starts a measurement named `label`, replacing any under way (which is dropped, not kept).
#[tauri::command]
pub fn start_watch_measurement(label: String, power: State<'_, WatchPower>) -> Result<WatchPowerView, String> {
    let label = label.trim().chars().take(80).collect::<String>();
    let mut inner = power.inner.lock().map_err(|_| "the power meter's lock was poisoned".to_string())?;
    inner.run = Some(Run {
        label: if label.is_empty() { "Measurement".into() } else { label },
        started_at: now(),
        first: None,
        last: None,
        delays_p50: Vec::new(),
        delays_p95: Vec::new(),
        notes: Vec::new(),
    });
    // Start from the latest report already in hand, so the run counts from now.
    if let Some(latest) = inner.recent.back().cloned()
        && let Some(run) = inner.run.as_mut()
    {
        run.first = Some(latest.clone());
        run.last = Some(latest);
    }
    Ok(view_of(&inner))
}

/// Ends the measurement under way and keeps its result.
#[tauri::command]
pub fn stop_watch_measurement(app: AppHandle, power: State<'_, WatchPower>) -> Result<WatchMeasurement, String> {
    let run = power
        .inner
        .lock()
        .map_err(|_| "the power meter's lock was poisoned".to_string())?
        .run
        .take()
        .ok_or("no measurement is under way")?;
    let measurement = run.finish(uuid::Uuid::new_v4().simple().to_string()[..12].to_string());
    let mut list = read_measurements(&app);
    list.push(measurement.clone());
    write_measurements(&app, &list)?;
    Ok(measurement)
}

#[tauri::command]
pub fn list_watch_measurements(app: AppHandle) -> Vec<WatchMeasurement> {
    read_measurements(&app)
}

#[tauri::command]
pub fn delete_watch_measurement(id: String, app: AppHandle) -> Result<Vec<WatchMeasurement>, String> {
    let mut list = read_measurements(&app);
    list.retain(|m| m.id != id);
    write_measurements(&app, &list)?;
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;
    use spatial_protocol::{WatchBatteryReport, WatchSensorReport};

    fn report(elapsed_ms: u64, scale: u64, percent: u8, charge_uah: i64) -> WatchStatsReport {
        WatchStatsReport {
            elapsed_ms,
            cpu_ms: Some(scale * 30),
            battery: Some(WatchBatteryReport { percent: Some(percent), charging: Some(false), charge_uah: Some(charge_uah), current_ua: None, temperature_c: Some(30.0) }),
            sensor_deliveries: scale * 50,
            sensors: vec![WatchSensorReport {
                id: "acceleration".into(),
                name: "Accel".into(),
                registered: true,
                requested_period_us: Some(20_000),
                fifo_max_events: 450,
                fifo_reserved_events: 0,
                events: scale * 50,
            }],
            ppg_samples: scale * 25,
            ppg_deliveries: scale * 10,
            messages: scale * 12,
            bytes: scale * 3000,
            refused_sends: 0,
            dropped_messages: scale / 100,
        }
    }

    #[test]
    fn rates_come_from_the_difference_between_two_reports() {
        // An hour apart, with every counter a second's worth per second.
        let a = report(1_000_000, 1000, 90, 300_000);
        let b = report(4_600_000, 4600, 84, 240_000);
        let rates = rates_between(&a, &b).unwrap();
        assert_eq!(rates.seconds, 3600.0);
        assert_eq!(rates.battery_percent_per_hour, Some(6.0));
        assert_eq!(rates.average_draw_ma, Some(60.0), "60,000 µAh in an hour is 60 mA");
        assert!((rates.cpu_percent.unwrap() - 3.0).abs() < 1e-9, "30 ms of CPU a second is 3%");
        assert!((rates.sensor_deliveries_per_second - 50.0).abs() < 1e-9);
        assert!((rates.sensors[0].achieved_hz - 50.0).abs() < 1e-9);
        assert_eq!(rates.sensors[0].requested_hz, Some(50.0));
        assert!((rates.ppg_hz - 25.0).abs() < 1e-9);
        assert!((rates.bytes_per_second - 3000.0).abs() < 1e-9);
        assert_eq!(rates.dropped_messages, 36);
        assert!(!rates.charging);
    }

    #[test]
    fn a_restarted_watch_or_a_report_out_of_order_gives_no_rates() {
        let a = report(4_600_000, 4600, 84, 240_000);
        assert!(rates_between(&a, &report(1_000_000, 1000, 90, 300_000)).is_none());
        assert!(rates_between(&a, &report(4_700_000, 10, 84, 240_000)).is_none(), "its counters started again");
    }

    #[test]
    fn the_live_rates_cover_about_the_last_minute() {
        let power = WatchPower::default();
        for i in 0..40u64 {
            power.observe(report(i * 5_000, i * 5, 90, 300_000), (None, None));
        }
        let live = power.view().live.unwrap();
        assert!(live.seconds >= 60.0 && live.seconds <= 65.0, "{}", live.seconds);
    }

    #[test]
    fn a_measurement_covers_its_run_with_the_median_delay_and_says_what_to_doubt() {
        let mut run = Run { label: "batching off".into(), started_at: now(), first: None, last: None, delays_p50: vec![], delays_p95: vec![], notes: vec![] };
        run.observe(&report(0, 0, 90, 300_000), (Some(40), Some(90)));
        run.observe(&report(60_000, 60, 90, 299_000), (Some(60), Some(120)));
        run.observe(&report(120_000, 120, 89, 298_000), (Some(50), Some(100)));
        let result = run.finish("x".into());
        assert_eq!(result.rates.as_ref().unwrap().seconds, 120.0);
        assert_eq!(result.delay_p50_ms, Some(50.0));
        assert_eq!(result.delay_p95_ms, Some(100.0));
        assert!(result.notes.iter().any(|n| n.contains("only 2 minutes")), "{:?}", result.notes);

        let mut restarted = Run { label: "r".into(), started_at: now(), first: None, last: None, delays_p50: vec![], delays_p95: vec![], notes: vec![] };
        restarted.observe(&report(500_000, 500, 90, 300_000), (None, None));
        restarted.observe(&report(1_000, 1, 90, 300_000), (None, None));
        restarted.observe(&report(61_000, 61, 90, 300_000), (None, None));
        let result = restarted.finish("y".into());
        assert_eq!(result.rates.unwrap().seconds, 60.0, "measured from the restart");
        assert!(result.notes.iter().any(|n| n.contains("restarted")));
    }
}
