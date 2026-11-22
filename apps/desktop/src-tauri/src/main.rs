#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod lsp;
mod pty;

use forge_core::fs::{self, DirEntry};
use std::path::Path;

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    fs::list_dir(Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_text(Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    fs::write_text(Path::new(&path), &contents).map_err(|e| e.to_string())
}

/// Workspace to open on launch (FORGE_WORKSPACE), used for demos and tests.
#[tauri::command]
fn initial_workspace() -> Option<String> {
    std::env::var("FORGE_WORKSPACE").ok()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .manage(pty::PtyState::default())
        .manage(lsp::LspState::default())
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_file,
            write_file,
            initial_workspace,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Forge");
}
