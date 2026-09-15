use std::env;
use std::path::Path;

fn main() {
    println!("cargo:rerun-if-env-changed=LITERT_RUNTIME_DIR");
    println!("cargo:rerun-if-env-changed=LITERT_RUNTIME_TARGET");

    if env::var_os("CARGO_FEATURE_LITERT_INFERENCE").is_some() {
        configure_litert_runtime();
    }

    tauri_build::build()
}

/// A feature-enabled desktop binary must be linked against the exact native
/// runtime which its Tauri bundle carries. `litert-sys` otherwise resolves a
/// user cache (and emits that absolute cache as an rpath), which is correct for
/// development but would make a shipped package depend on the packager's host.
fn configure_litert_runtime() {
    let target = env::var("TARGET").expect("Cargo did not provide TARGET");
    let expected_library = match target.as_str() {
        "aarch64-apple-darwin" => "libLiteRt.dylib",
        "x86_64-unknown-linux-gnu" | "aarch64-unknown-linux-gnu" => "libLiteRt.so",
        "x86_64-pc-windows-msvc" => "libLiteRt.dll",
        _ => panic!(
            "LiteRT package not created: target `{target}` has no reviewed runtime packaging layout. \
             Use the supported package entrypoint and one of its declared desktop targets."
        ),
    };

    let declared_target = env::var("LITERT_RUNTIME_TARGET").unwrap_or_default();
    assert_eq!(
        declared_target, target,
        "LiteRT package not created: LITERT_RUNTIME_TARGET must exactly match Cargo target `{target}`; \
         cross-target native runtimes are rejected."
    );

    let runtime_dir = env::var("LITERT_RUNTIME_DIR").unwrap_or_else(|_| {
        panic!(
            "LiteRT package not created: LITERT_RUNTIME_DIR is required. \
             Use `npm run package:litert` with a reviewed native runtime; do not package a cache-only runtime."
        )
    });
    let runtime_dir = Path::new(&runtime_dir);
    assert!(
        runtime_dir.join(expected_library).is_file(),
        "LiteRT package not created: {} is missing from {}. The native runtime is unavailable, \
         so no feature-enabled package may be produced.",
        expected_library,
        runtime_dir.display()
    );

    match target.as_str() {
        "aarch64-apple-darwin" => println!(
            "cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Resources/litert/{target}"
        ),
        "x86_64-unknown-linux-gnu" | "aarch64-unknown-linux-gnu" => println!(
            "cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/spatial-gesture-desktop/litert/{target}"
        ),
        "x86_64-pc-windows-msvc" => {
            // The Windows overlay places the supplied DLLs beside the executable,
            // the native loader's normal search location.
        }
        _ => unreachable!("unsupported target was rejected above"),
    }
}
