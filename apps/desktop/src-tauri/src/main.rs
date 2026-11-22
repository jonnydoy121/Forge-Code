#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod indexer;
mod lsp;
mod proc;
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

#[derive(serde::Serialize)]
struct SandboxOut {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
    millis: u64,
    mode: &'static str,
    granted: Vec<String>,
    warnings: Vec<String>,
}

fn mode_name(m: forge_core::sandbox::Mode) -> &'static str {
    match m {
        forge_core::sandbox::Mode::AppContainer => "appcontainer",
        forge_core::sandbox::Mode::EnvOnly => "env-only",
    }
}

/// Run an agent command confined to the workspace (AppContainer on Windows: no network, no profile or credential access).
#[tauri::command]
async fn sandbox_run(cwd: String, command: String, timeout_ms: u64, toolchain_read: bool) -> Result<SandboxOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let o = forge_core::sandbox::run(&command, Path::new(&cwd), std::time::Duration::from_millis(timeout_ms), 2_000_000, &forge_core::sandbox::Options { toolchain_read })?;
        Ok(SandboxOut { code: o.result.code, stdout: o.result.stdout, stderr: o.result.stderr, timed_out: o.result.timed_out, millis: o.result.millis as u64, mode: mode_name(o.mode), granted: o.granted, warnings: o.warnings })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn sandbox_status() -> &'static str {
    mode_name(forge_core::sandbox::available_mode())
}

#[tauri::command]
fn bg_start(state: tauri::State<forge_core::bg::Background>, cwd: String, command: String) -> Result<u32, String> {
    state.start(&command, Path::new(&cwd))
}

#[tauri::command]
fn bg_read(state: tauri::State<forge_core::bg::Background>, id: u32, lines: usize) -> Result<forge_core::bg::BgOutput, String> {
    state.read(id, lines)
}

#[tauri::command]
fn bg_stop(state: tauri::State<forge_core::bg::Background>, id: u32) -> Result<(), String> {
    state.stop(id)
}

#[tauri::command]
fn bg_list(state: tauri::State<forge_core::bg::Background>) -> Vec<forge_core::bg::BgInfo> {
    state.list()
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
        .manage(proc::ProcState::default())
        .manage(forge_core::bg::Background::default())
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_file,
            write_file,
            read_file_opt,
            remove_file,
            list_names,
            git_run,
            home_dir,
            sandbox_run,
            sandbox_status,
            bg_start,
            bg_read,
            bg_stop,
            bg_list,
            proc::proc_start,
            proc::proc_send,
            proc::proc_stop,
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
