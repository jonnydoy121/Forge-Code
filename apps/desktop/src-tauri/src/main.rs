#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod indexer;
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

#[tauri::command]
fn read_file_opt(path: String) -> Result<Option<String>, String> {
    fs::read_text_opt(Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_file(path: String) -> Result<(), String> {
    fs::remove_file(Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_names(path: String) -> Result<Vec<String>, String> {
    fs::list_names(Path::new(&path)).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct GitResult {
    ok: bool,
    stdout: String,
    stderr: String,
}

#[tauri::command]
fn git_run(root: String, args: Vec<String>) -> Result<GitResult, String> {
    let o = forge_core::git::run(Path::new(&root), &args)?;
    Ok(GitResult { ok: o.ok, stdout: o.stdout, stderr: o.stderr })
}

#[derive(serde::Serialize)]
struct ExecOut {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
    millis: u64,
}

/// Run a shell command in the workspace (project checks, hooks). Blocking work runs off the UI thread.
#[tauri::command]
async fn run_command(cwd: String, command: String, timeout_ms: u64, env: Vec<(String, String)>) -> Result<ExecOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        forge_core::exec::run_shell(&command, Path::new(&cwd), std::time::Duration::from_millis(timeout_ms), &env, 2_000_000)
            .map(|r| ExecOut { code: r.code, stdout: r.stdout, stderr: r.stderr, timed_out: r.timed_out, millis: r.millis as u64 })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The user's home directory, for personal memories.
#[tauri::command]
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()
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
        .manage(indexer::IndexState::default())
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_file,
            write_file,
            read_file_opt,
            remove_file,
            list_names,
            git_run,
            home_dir,
            run_command,
            initial_workspace,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            indexer::index_start,
            indexer::index_status,
            indexer::index_grep,
            indexer::index_symbol,
            indexer::index_references,
            indexer::index_repo_map,
            indexer::index_semantic,
            indexer::index_cone,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Forge");
}
