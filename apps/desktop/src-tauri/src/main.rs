#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    println!("forge-core {}", forge_core::core_version());
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Forge");
}
