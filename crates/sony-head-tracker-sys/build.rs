use std::env;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let vendor = manifest.join("../../third_party/sony-head-tracker");
    let target = env::var("CARGO_CFG_TARGET_OS").unwrap();

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .include(manifest.join("native"))
        .include(vendor.join("include"))
        .file(manifest.join("native/sony_head_tracker_c.cpp"))
        .warnings(true);

    if target == "windows" {
        build
            .flag_if_supported("/std:c++20")
            .flag_if_supported("/EHsc")
            .flag_if_supported("/utf-8")
            .define("UNICODE", None)
            .define("_UNICODE", None)
            .file(manifest.join("native/windows_label.cpp"))
            .file(vendor.join("src/math.cpp"))
            .file(vendor.join("src/orientation.cpp"))
            .file(vendor.join("src/hid_descriptor.cpp"))
            .file(vendor.join("src/hid_backend.cpp"))
            .file(vendor.join("src/sensor_api_backend.cpp"))
            .file(vendor.join("src/logger.cpp"));
        for library in [
            "setupapi",
            "hid",
            "cfgmgr32",
            "sensorsapi",
            "portabledeviceguids",
            "ole32",
            "propsys",
        ] {
            println!("cargo:rustc-link-lib={library}");
        }
    } else if target == "macos" {
        build
            .flag_if_supported("-std=c++20")
            .file(vendor.join("src/math.cpp"))
            .file(vendor.join("src/orientation.cpp"))
            .file(vendor.join("src/hid_descriptor.cpp"))
            .file(vendor.join("src/macos/hid_backend_macos.cpp"))
            .file(vendor.join("src/macos/logger_macos.cpp"));
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=IOKit");
    } else {
        build.flag_if_supported("-std=c++20");
    }

    build.compile("sony_head_tracker_native");

    println!("cargo:rerun-if-changed=native/sony_head_tracker_c.h");
    println!("cargo:rerun-if-changed=native/sony_head_tracker_c.cpp");
    println!("cargo:rerun-if-changed=native/windows_label.cpp");
    println!(
        "cargo:rerun-if-changed={}",
        vendor.join("include").display()
    );
    println!("cargo:rerun-if-changed={}", vendor.join("src").display());
}
