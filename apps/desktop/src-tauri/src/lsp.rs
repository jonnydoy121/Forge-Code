use forge_core::lsp::{encode_frame, read_frame, resolve_command, server_spec};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

struct Proc {
    stdin: ChildStdin,
    child: Child,
}

#[derive(Default)]
pub struct LspState {
    next: Mutex<u32>,
    procs: Mutex<HashMap<u32, Proc>>,
}

#[derive(Clone, Serialize)]
struct LspMsg {
    id: u32,
    msg: String,
}

/// Directories searched before PATH: workspace node_modules/.bin, then the repo's (dev builds).
fn search_dirs(root: &str) -> Vec<PathBuf> {
    vec![PathBuf::from(root).join("node_modules").join(".bin"), PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../node_modules/.bin"))]
}

#[tauri::command]
pub fn lsp_start(app: AppHandle, state: State<LspState>, language: String, root: String) -> Result<u32, String> {
    let (name, args) = server_spec(&language).ok_or_else(|| format!("no language server known for {language}"))?;
    let exe = resolve_command(name, &search_dirs(&root)).ok_or_else(|| format!("{name} not found. Run npm install in the Forge repo or install it on PATH."))?;

    let mut cmd = Command::new(exe);
    cmd.args(args).current_dir(&root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    let id = {
        let mut n = state.next.lock().unwrap();
        *n += 1;
        *n
    };
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(Some(msg)) = read_frame(&mut reader) {
            let _ = app.emit("lsp-msg", LspMsg { id, msg });
        }
        let _ = app.emit("lsp-exit", id);
    });
    state.procs.lock().unwrap().insert(id, Proc { stdin, child });
    Ok(id)
}

#[tauri::command]
pub fn lsp_send(state: State<LspState>, id: u32, msg: String) -> Result<(), String> {
    let mut p = state.procs.lock().unwrap();
    let proc = p.get_mut(&id).ok_or("language server not running")?;
    proc.stdin.write_all(&encode_frame(&msg)).and_then(|_| proc.stdin.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lsp_stop(state: State<LspState>, id: u32) {
    if let Some(mut p) = state.procs.lock().unwrap().remove(&id) {
        let _ = p.child.kill();
    }
}
