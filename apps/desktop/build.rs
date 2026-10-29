fn main() {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os == "windows" && std::env::var_os("CARGO_FEATURE_VOICE").is_some() {
        // The speech engine is downloaded with the voice models, so it's linked lazily and
        // loaded from there (voice/gpu.rs) only once voice is set up.
        println!("cargo:rustc-link-arg=/DELAYLOAD:sherpa-onnx-c-api.dll");
        println!("cargo:rustc-link-lib=delayimp");
    }
    if os == "macos" {
        // sherpa-onnx and ONNX Runtime ship in Writey.app/Contents/Frameworks.
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    }
    tauri_build::build()
}
