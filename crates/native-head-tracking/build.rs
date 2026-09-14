//! Milestone 1: compiles and links the macOS native provider. Other targets
//! (Windows/Milestone 4, Linux/no physical backend) do nothing here yet, so
//! `src/ffi.rs`'s extern blocks stay declaration-only for them -- see the
//! module doc comment in `src/lib.rs`.

use std::env;
use std::path::{Path, PathBuf};

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "macos" {
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("crates/native-head-tracking sits two directories below the repo root")
        .to_path_buf();
    let vendor = repo_root.join("third_party/sony-head-tracker");

    cc::Build::new()
        .cpp(true)
        .std("c++20")
        .include(vendor.join("include"))
        .include(vendor.join("macos/Bridge"))
        .include(manifest_dir.join("include"))
        // Pure, platform-agnostic engine sources. Their Windows counterparts
        // (src/logger.cpp, src/hid_backend.cpp, src/output_udp.cpp,
        // src/bluetooth.cpp, src/app_config_store.cpp,
        // src/diagnostics_report.cpp, src/sensor_api_backend.cpp -- each
        // `#include`s "sony_head_tracker/windows_prelude.hpp") define the
        // same interfaces for Windows and must stay out of this build.
        .file(vendor.join("src/app_config.cpp"))
        .file(vendor.join("src/diagnostics.cpp"))
        .file(vendor.join("src/hid_descriptor.cpp"))
        .file(vendor.join("src/math.cpp"))
        .file(vendor.join("src/orientation.cpp"))
        .file(vendor.join("src/protocol.cpp"))
        // macOS platform implementations of the same interfaces. These are
        // plain C++/CoreFoundation (hid_backend_macos.cpp, audio_wake_macos.cpp,
        // output_udp_posix.cpp, logger_macos.cpp, app_config_store_macos.cpp)
        // or Objective-C++ written for manual reference counting, not ARC
        // (bluetooth_recovery_macos.mm uses explicit `autorelease`), so the
        // whole target compiles as one archive with no ARC flag.
        .file(vendor.join("src/macos/app_config_store_macos.cpp"))
        .file(vendor.join("src/macos/audio_wake_macos.cpp"))
        .file(vendor.join("src/macos/bluetooth_recovery_macos.mm"))
        .file(vendor.join("src/macos/hid_backend_macos.cpp"))
        .file(vendor.join("src/macos/logger_macos.cpp"))
        .file(vendor.join("src/macos/output_udp_posix.cpp"))
        // Upstream's vendored C ABI bridge, plus our adapter (repo-owned, not
        // vendored) that maps it onto include/spatial_head_tracker.h.
        .file(vendor.join("macos/Bridge/sony_head_tracker_c.mm"))
        .file("macos/adapter.cpp")
        .compile("sony_head_tracker_macos");

    for framework in [
        "Foundation",
        "CoreFoundation",
        "IOKit",
        "IOBluetooth",
        "AudioToolbox",
        "AudioUnit",
        "CoreAudio",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }

    println!("cargo:rerun-if-changed={}", vendor.display());
    println!("cargo:rerun-if-changed=macos/adapter.cpp");
    println!("cargo:rerun-if-changed=include/spatial_head_tracker.h");
}
