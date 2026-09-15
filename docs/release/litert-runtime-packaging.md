# LiteRT desktop runtime packaging

GC-004 makes a feature-enabled desktop package an explicit release action. The
ordinary desktop build remains LiteRT-free: its optional backend is absent and
model windows fail closed. Do not call a package LiteRT-capable merely because
it contains a TFLite model or because the Rust feature was selected.

## Supported native-runtime targets

The selected `litert` 0.2.x dependency defines pinned native prebuilt coverage
for the following desktop Rust triples:

- `aarch64-apple-darwin` (macOS Apple Silicon)
- `x86_64-pc-windows-msvc` (Windows x64)
- `x86_64-unknown-linux-gnu` (Linux x64)
- `aarch64-unknown-linux-gnu` (Linux ARM64)

No Intel macOS runtime is declared by this dependency. Do not cross-label an
Apple Silicon artifact as universal or Intel-compatible.

## Deliberate package entrypoint

The only repository entrypoint for a LiteRT release package is:

    npm run package:litert

It requires all three values below. The command fails before a Tauri package is
created if any value is absent, the target triple is unsupported, the primary
native library is missing, or the runtime notice is missing:

    LITERT_RUNTIME_TARGET=<one supported triple>
    LITERT_RUNTIME_DIR=<reviewed directory containing that target's libLiteRt.*>
    LITERT_RUNTIME_NOTICE_FILE=<reviewed license/NOTICE distributed with that runtime>

The entrypoint sets `litert-inference`, passes `LITERT_LIB_DIR` to the native
binding, sets `LITERT_NO_DOWNLOAD=1`, and stages only real `libLiteRt*` files.
It never downloads a runtime, manufactures a placeholder library, or silently
falls back to a host/cross-target library. Staging is under
`apps/desktop/src-tauri/resources/litert/` and is deleted even when Tauri
packaging fails.

`LITERT_NO_DOWNLOAD=1` is intentional: release packaging must use an
independently reviewed and legally redistributable runtime input rather than a
build-time network fetch from the binding dependency.

## Bundle layout

The per-target staging layout is:

    resources/litert/<target-triple>/
      libLiteRt.<platform-extension>
      libLiteRt*.<platform-extension>     # additional supplied LiteRT runtime libraries
      NOTICE                               # supplied reviewed runtime notice
      runtime-manifest.json                # target and staged file names

The macOS and Linux Tauri overlay preserves this as `litert/<target-triple>/`
in the Tauri resource directory. The desktop build script adds a target-specific
loader search path to that resource location. The Windows overlay places the
entire `x86_64-pc-windows-msvc` runtime directory next to the executable because
the Windows DLL loader does not search a nested Tauri resource directory.

The script does not claim that optional accelerator libraries are usable: it
stages only files actually supplied alongside the reviewed primary runtime.
The runtime manifest is inventory, not a validation result.

## Release procedure and gates

1. Obtain the native LiteRT files and exact accompanying notice from an approved
   redistribution source for one target. Verify the source, license, version,
   hashes, architecture, and any required signing outside this script.
2. Set the three required variables and run `npm run package:litert` on the
   matching native release host/toolchain. Do not use a runtime from another
   target.
3. Retain the generated package and its staged `runtime-manifest.json` as
   release evidence. Record artifact hashes and signing/notarization status.
4. On a clean host, verify launch, native-library discovery, Monitor behavior,
   Live behavior with a reviewed model, forced release on runtime failure, and
   the Watch-button fallback while inference is Off.

All four steps are release gates. As of GC-004, no target runtime was supplied,
no package was produced, no package was installed, and no hardware was used.
Every platform, validation, native-loader, clean-install, signing, CI, and
hardware gate remains **DEFERRED / NOT CLEARED**.
