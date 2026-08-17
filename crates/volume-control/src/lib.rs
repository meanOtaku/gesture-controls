#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::io::{Read, Seek, SeekFrom};
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
#[cfg(unix)]
use std::process::{Command, ExitStatus, Output, Stdio};
#[cfg(unix)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(unix)]
use std::sync::{Mutex, OnceLock};
#[cfg(unix)]
use std::thread;
#[cfg(unix)]
use std::time::{Duration, Instant};

#[cfg(unix)]
use command_group::{CommandGroup, GroupChild};
use thiserror::Error;

const GET_VOLUME_SCRIPT: &str = "output volume of (get volume settings)";
const SET_VOLUME_SCRIPT: &str =
    "on run argv\nset volume output volume ((item 1 of argv) as integer)\nend run";
const GET_MUTED_SCRIPT: &str = "output muted of (get volume settings)";
const SET_MUTED_SCRIPT: &str = "on run argv\nif item 1 of argv is \"true\" then\nset volume with output muted\nelse\nset volume without output muted\nend if\nend run";
#[cfg(unix)]
const NATIVE_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(unix)]
const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(unix)]
const COMMAND_CLEANUP_TIMEOUT: Duration = Duration::from_millis(250);
#[cfg(unix)]
const DEFERRED_REAP_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(unix)]
static COMMAND_EXECUTION_LOCK: Mutex<()> = Mutex::new(());
#[cfg(unix)]
static DEFERRED_REAP_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(unix)]
static DEFERRED_CHILDREN: OnceLock<Mutex<Vec<GroupChild>>> = OnceLock::new();

#[derive(Debug, Error, PartialEq)]
pub enum VolumeError {
    #[error("volume must be finite and within 0.0..=1.0")]
    InvalidVolume,
    #[error("native volume control is not available on this platform")]
    UnsupportedPlatform,
    #[error("system volume can only change while the volume overlay is visible")]
    OverlayInactive,
    #[error("volume adjustment must be finite")]
    InvalidAdjustment,
    #[error("native volume backend returned an invalid response: {0}")]
    InvalidResponse(String),
    #[error("native volume backend failed: {0}")]
    Backend(String),
}

pub trait VolumeController: Send + Sync {
    fn get_volume(&self) -> Result<f32, VolumeError>;
    fn set_volume(&self, volume: f32) -> Result<(), VolumeError>;
    fn get_muted(&self) -> Result<bool, VolumeError>;
    fn set_muted(&self, muted: bool) -> Result<(), VolumeError>;
}

pub trait AppleScriptRunner: Send + Sync {
    fn run(&self, script: &str, args: &[String]) -> Result<String, VolumeError>;
}

#[derive(Debug, Default)]
pub struct OsascriptRunner;

#[cfg(unix)]
struct ChildGuard {
    child: Option<GroupChild>,
    stdout: File,
    stderr: File,
}

#[cfg(unix)]
impl ChildGuard {
    fn spawn(command: &mut Command) -> Result<Self, VolumeError> {
        let stdout = tempfile::tempfile()
            .map_err(|error| VolumeError::Backend(format!("failed to capture stdout: {error}")))?;
        let stderr = tempfile::tempfile()
            .map_err(|error| VolumeError::Backend(format!("failed to capture stderr: {error}")))?;
        command
            .stdout(Stdio::from(stdout.try_clone().map_err(|error| {
                VolumeError::Backend(format!("failed to clone stdout capture: {error}"))
            })?))
            .stderr(Stdio::from(stderr.try_clone().map_err(|error| {
                VolumeError::Backend(format!("failed to clone stderr capture: {error}"))
            })?));
        let child = command
            .group()
            .spawn()
            .map_err(|error| VolumeError::Backend(error.to_string()))?;
        Ok(Self {
            child: Some(child),
            stdout,
            stderr,
        })
    }

    fn child_mut(&mut self) -> &mut GroupChild {
        self.child.as_mut().expect("guard always owns a child")
    }

    fn poll_status(&mut self) -> std::io::Result<Option<ExitStatus>> {
        if !leader_exited_without_reaping(self.child_mut())? {
            return Ok(None);
        }
        if let Err(error) = self.child_mut().kill()
            && !process_group_is_absent(&error)
        {
            return Err(error);
        }
        try_reap_leader(self.child_mut())
    }

    fn collect_output(mut self, status: ExitStatus) -> Result<Output, VolumeError> {
        self.child.take();
        Ok(Output {
            status,
            stdout: read_capture(&mut self.stdout, "stdout")?,
            stderr: read_capture(&mut self.stderr, "stderr")?,
        })
    }

    fn defer_reap(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let _ = child.kill();
        let slot = DEFERRED_CHILDREN.get_or_init(|| Mutex::new(Vec::new()));
        let mut deferred = match slot.lock() {
            Ok(deferred) => deferred,
            Err(poisoned) => poisoned.into_inner(),
        };
        let start_reaper = deferred.is_empty();
        deferred.push(child);
        DEFERRED_REAP_ACTIVE.store(true, Ordering::Release);
        drop(deferred);

        if start_reaper {
            let _ = thread::Builder::new()
                .name("native-volume-reaper".to_string())
                .spawn(reap_deferred_children);
        }
    }

    fn cleanup_failure(&mut self, message: String) -> VolumeError {
        self.defer_reap();
        VolumeError::Backend(message)
    }

    fn terminate_and_reap(&mut self) -> Result<(), VolumeError> {
        if let Err(kill_error) = self.child_mut().kill() {
            if !process_group_is_absent(&kill_error) {
                return Err(self.cleanup_failure(format!(
                    "failed to terminate native volume command: {kill_error}"
                )));
            }
            match try_reap_leader(self.child_mut()) {
                Ok(Some(_)) => {
                    self.child.take();
                    return Ok(());
                }
                Ok(None) => {
                    return Err(self.cleanup_failure(format!(
                        "native volume process group disappeared before its leader exited: {kill_error}"
                    )));
                }
                Err(wait_error) => {
                    return Err(self.cleanup_failure(format!(
                        "native volume process group disappeared: {kill_error}; status check failed: {wait_error}"
                    )));
                }
            }
        }

        let cleanup_started = Instant::now();
        loop {
            match try_reap_leader(self.child_mut()) {
                Ok(Some(_)) => {
                    self.child.take();
                    return Ok(());
                }
                Ok(None) if cleanup_started.elapsed() < COMMAND_CLEANUP_TIMEOUT => {
                    thread::sleep(COMMAND_POLL_INTERVAL);
                }
                Ok(None) => {
                    return Err(self.cleanup_failure(
                        "native volume command did not exit after termination".to_string(),
                    ));
                }
                Err(error) => {
                    return Err(self.cleanup_failure(format!(
                        "failed to reap native volume command: {error}"
                    )));
                }
            }
        }
    }
}

#[cfg(unix)]
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.child.is_some() {
            let _ = self.terminate_and_reap();
        }
    }
}

#[cfg(unix)]
fn leader_exited_without_reaping(child: &mut GroupChild) -> std::io::Result<bool> {
    let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    // SAFETY: `info` points to writable siginfo_t storage, the PID belongs to
    // this owned child, and waitid leaves the child waitable because of WNOWAIT.
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result == -1 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: waitid succeeded and initialized the siginfo_t storage.
    let info = unsafe { info.assume_init() };
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    let exited_pid = info.si_pid;
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    // SAFETY: si_pid is valid after a successful waitid call.
    let exited_pid = unsafe { info.si_pid() };
    Ok(exited_pid != 0)
}

#[cfg(unix)]
fn try_reap_leader(child: &mut GroupChild) -> std::io::Result<Option<ExitStatus>> {
    let mut status = 0;
    // SAFETY: status points to valid writable storage, and child.id() is the PID
    // returned by the successful spawn owned by this guard.
    let result = unsafe { libc::waitpid(child.id() as libc::pid_t, &mut status, libc::WNOHANG) };
    if result == 0 {
        return Ok(None);
    }
    if result == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(Some(ExitStatus::from_raw(status)))
}

#[cfg(unix)]
fn reap_deferred_children_once() -> bool {
    let Some(slot) = DEFERRED_CHILDREN.get() else {
        DEFERRED_REAP_ACTIVE.store(false, Ordering::Release);
        return true;
    };
    let mut children = match slot.lock() {
        Ok(children) => children,
        Err(poisoned) => poisoned.into_inner(),
    };
    children.retain_mut(|child| match child.kill() {
        Ok(()) => !matches!(try_reap_leader(child), Ok(Some(_))),
        Err(error) if process_group_is_absent(&error) => {
            !matches!(try_reap_leader(child), Ok(Some(_)))
        }
        Err(_) => true,
    });
    let empty = children.is_empty();
    if empty {
        DEFERRED_REAP_ACTIVE.store(false, Ordering::Release);
    }
    empty
}

#[cfg(unix)]
fn reap_deferred_children() {
    let started = Instant::now();
    loop {
        if reap_deferred_children_once() || started.elapsed() >= DEFERRED_REAP_TIMEOUT {
            return;
        }
        thread::sleep(COMMAND_POLL_INTERVAL);
    }
}

#[cfg(unix)]
fn read_capture(file: &mut File, stream: &str) -> Result<Vec<u8>, VolumeError> {
    file.seek(SeekFrom::Start(0))
        .and_then(|_| {
            let mut output = Vec::new();
            file.read_to_end(&mut output).map(|_| output)
        })
        .map_err(|error| VolumeError::Backend(format!("failed to read {stream}: {error}")))
}

#[cfg(unix)]
fn process_group_is_absent(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(libc::ESRCH)
}

#[cfg(unix)]
fn run_command_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> Result<Output, VolumeError> {
    let _execution = COMMAND_EXECUTION_LOCK
        .lock()
        .map_err(|_| VolumeError::Backend("native command lock was poisoned".to_string()))?;
    if DEFERRED_REAP_ACTIVE.load(Ordering::Acquire) {
        let cleanup_started = Instant::now();
        while DEFERRED_REAP_ACTIVE.load(Ordering::Acquire) && !reap_deferred_children_once() {
            if cleanup_started.elapsed() >= COMMAND_CLEANUP_TIMEOUT {
                return Err(VolumeError::Backend(
                    "a previous native volume command is still being reaped".to_string(),
                ));
            }
            thread::sleep(COMMAND_POLL_INTERVAL);
        }
    }

    let mut child = ChildGuard::spawn(command)?;
    let started = Instant::now();
    loop {
        match child.poll_status() {
            Ok(Some(status)) => return child.collect_output(status),
            Ok(None) if started.elapsed() < timeout => {
                thread::sleep(COMMAND_POLL_INTERVAL.min(timeout));
            }
            Ok(None) => {
                return match child.terminate_and_reap() {
                    Ok(()) => Err(VolumeError::Backend(format!(
                        "native volume command timed out after {} ms",
                        timeout.as_millis()
                    ))),
                    Err(cleanup_error) => Err(VolumeError::Backend(format!(
                        "native volume command timed out after {} ms; cleanup failed: {cleanup_error}",
                        timeout.as_millis()
                    ))),
                };
            }
            Err(error) => {
                return match child.terminate_and_reap() {
                    Ok(()) => Err(VolumeError::Backend(format!(
                        "failed to read native volume command status: {error}"
                    ))),
                    Err(cleanup_error) => Err(VolumeError::Backend(format!(
                        "failed to read native volume command status: {error}; cleanup failed: {cleanup_error}"
                    ))),
                };
            }
        }
    }
}

#[cfg(unix)]
impl AppleScriptRunner for OsascriptRunner {
    fn run(&self, script: &str, args: &[String]) -> Result<String, VolumeError> {
        let mut command = Command::new("/usr/bin/osascript");
        command.args(["-e", script]).args(args);
        let output = run_command_with_timeout(&mut command, NATIVE_COMMAND_TIMEOUT)?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            return Err(VolumeError::Backend(if stderr.is_empty() {
                format!("osascript exited with {}", output.status)
            } else {
                stderr
            }));
        }
        String::from_utf8(output.stdout)
            .map_err(|error| VolumeError::InvalidResponse(error.to_string()))
    }
}

#[cfg(not(unix))]
impl AppleScriptRunner for OsascriptRunner {
    fn run(&self, _script: &str, _args: &[String]) -> Result<String, VolumeError> {
        Err(VolumeError::UnsupportedPlatform)
    }
}

#[derive(Debug)]
pub struct MacOsVolumeController<R = OsascriptRunner> {
    runner: R,
}

impl Default for MacOsVolumeController<OsascriptRunner> {
    fn default() -> Self {
        Self {
            runner: OsascriptRunner,
        }
    }
}

impl<R> MacOsVolumeController<R> {
    pub fn with_runner(runner: R) -> Self {
        Self { runner }
    }

    pub fn runner(&self) -> &R {
        &self.runner
    }
}

impl<R: AppleScriptRunner> VolumeController for MacOsVolumeController<R> {
    fn get_volume(&self) -> Result<f32, VolumeError> {
        let response = self.runner.run(GET_VOLUME_SCRIPT, &[])?;
        let percent = response
            .trim()
            .parse::<f32>()
            .map_err(|_| VolumeError::InvalidResponse(response.trim().to_owned()))?;
        if !percent.is_finite() || !(0.0..=100.0).contains(&percent) {
            return Err(VolumeError::InvalidResponse(response.trim().to_owned()));
        }
        Ok(percent / 100.0)
    }

    fn set_volume(&self, volume: f32) -> Result<(), VolumeError> {
        validate_volume(volume)?;
        let percent = (volume * 100.0).round() as u8;
        self.runner.run(SET_VOLUME_SCRIPT, &[percent.to_string()])?;
        Ok(())
    }

    fn get_muted(&self) -> Result<bool, VolumeError> {
        let response = self.runner.run(GET_MUTED_SCRIPT, &[])?;
        match response.trim().to_ascii_lowercase().as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(VolumeError::InvalidResponse(response.trim().to_owned())),
        }
    }

    fn set_muted(&self, muted: bool) -> Result<(), VolumeError> {
        self.runner.run(SET_MUTED_SCRIPT, &[muted.to_string()])?;
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct UnsupportedVolumeController;

impl VolumeController for UnsupportedVolumeController {
    fn get_volume(&self) -> Result<f32, VolumeError> {
        Err(VolumeError::UnsupportedPlatform)
    }

    fn set_volume(&self, _volume: f32) -> Result<(), VolumeError> {
        Err(VolumeError::UnsupportedPlatform)
    }

    fn get_muted(&self) -> Result<bool, VolumeError> {
        Err(VolumeError::UnsupportedPlatform)
    }

    fn set_muted(&self, _muted: bool) -> Result<(), VolumeError> {
        Err(VolumeError::UnsupportedPlatform)
    }
}

pub fn platform_volume_controller() -> Box<dyn VolumeController> {
    #[cfg(target_os = "macos")]
    {
        Box::new(MacOsVolumeController::default())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(UnsupportedVolumeController)
    }
}

pub fn adjust_system_volume(
    controller: &dyn VolumeController,
    overlay_visible: bool,
    delta_percent: f32,
) -> Result<f32, VolumeError> {
    if !overlay_visible {
        return Err(VolumeError::OverlayInactive);
    }
    if !delta_percent.is_finite() {
        return Err(VolumeError::InvalidAdjustment);
    }
    let current = controller.get_volume()?;
    validate_volume(current)?;
    let updated_percent = (current * 100.0 + delta_percent).clamp(0.0, 100.0).round();
    let updated = updated_percent / 100.0;
    controller.set_volume(updated)?;
    Ok(updated)
}

fn validate_volume(volume: f32) -> Result<(), VolumeError> {
    if volume.is_finite() && (0.0..=1.0).contains(&volume) {
        Ok(())
    } else {
        Err(VolumeError::InvalidVolume)
    }
}

#[cfg(all(test, unix))]
mod timeout_tests {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use super::{VolumeError, run_command_with_timeout};

    fn process_exists(pid: &str) -> bool {
        Command::new("/bin/kill")
            .args(["-0", pid])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    fn process_survives_reap_grace_period(pid: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(1);
        while process_exists(pid) {
            if Instant::now() >= deadline {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[test]
    fn successful_native_command_output_is_collected() {
        let output = run_command_with_timeout(
            Command::new("/usr/bin/printf").arg("73"),
            Duration::from_secs(1),
        )
        .unwrap();

        assert!(output.status.success());
        assert_eq!(output.stdout, b"73");
    }

    #[test]
    fn native_commands_are_terminated_after_the_deadline() {
        let pid_file = std::env::temp_dir().join(format!(
            "gesture-controls-volume-timeout-{}.pid",
            std::process::id()
        ));
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "echo $$ > \"$1\"; exec /bin/sleep 2",
                "volume-timeout",
            ])
            .arg(&pid_file);
        let started = Instant::now();
        let error = run_command_with_timeout(&mut command, Duration::from_millis(100)).unwrap_err();

        assert!(matches!(error, VolumeError::Backend(message) if message.contains("timed out")));
        assert!(started.elapsed() < Duration::from_secs(1));
        let pid = std::fs::read_to_string(&pid_file).unwrap();
        let still_running = Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
        let _ = std::fs::remove_file(pid_file);
        assert!(
            !still_running,
            "timed-out child process must be terminated and reaped"
        );
    }

    #[test]
    fn timed_out_native_command_terminates_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("descendant.pid");
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "sleep 10 & echo $! > \"$1\"; wait",
                "volume-timeout-tree",
            ])
            .arg(&pid_file);

        let error = run_command_with_timeout(&mut command, Duration::from_millis(100)).unwrap_err();
        assert!(matches!(error, VolumeError::Backend(message) if message.contains("timed out")));

        let pid = std::fs::read_to_string(pid_file).unwrap();
        let still_running = process_survives_reap_grace_period(pid.trim());
        if still_running {
            let _ = Command::new("/bin/kill").args(["-9", pid.trim()]).status();
        }
        assert!(!still_running, "timed-out descendants must not be orphaned");
    }

    #[test]
    fn successful_native_command_does_not_wait_for_inherited_output_pipes() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("descendant.pid");
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "sleep 2 & echo $! > \"$1\"; exit 0",
                "volume-success-tree",
            ])
            .arg(&pid_file);

        let started = Instant::now();
        let output = run_command_with_timeout(&mut command, Duration::from_millis(500)).unwrap();

        assert!(output.status.success());
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "output collection must stay bounded after the process leader exits"
        );
        let pid = std::fs::read_to_string(pid_file).unwrap();
        let still_running = process_survives_reap_grace_period(pid.trim());
        if still_running {
            let _ = Command::new("/bin/kill").args(["-9", pid.trim()]).status();
        }
        assert!(
            !still_running,
            "successful command descendants must not be orphaned"
        );
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use std::fs;
    use std::process::Command;

    use super::{GET_MUTED_SCRIPT, GET_VOLUME_SCRIPT, SET_MUTED_SCRIPT, SET_VOLUME_SCRIPT};

    #[test]
    fn applescript_programs_compile() {
        for (index, script) in [
            GET_VOLUME_SCRIPT,
            SET_VOLUME_SCRIPT,
            GET_MUTED_SCRIPT,
            SET_MUTED_SCRIPT,
        ]
        .into_iter()
        .enumerate()
        {
            let directory = std::env::temp_dir().join(format!(
                "gesture-controls-volume-{}-{index}",
                std::process::id()
            ));
            fs::create_dir(&directory).expect("create isolated AppleScript test directory");
            let output = directory.join("script.scpt");
            let result = Command::new("/usr/bin/osacompile")
                .arg("-o")
                .arg(&output)
                .args(["-e", script])
                .output()
                .expect("osacompile must be available on macOS");
            let _ = fs::remove_dir_all(&directory);
            assert!(
                result.status.success(),
                "AppleScript failed to compile: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }
}
