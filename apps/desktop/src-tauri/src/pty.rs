use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    next: Mutex<u32>,
    sessions: Mutex<HashMap<u32, Session>>,
}

#[derive(Clone, Serialize)]
struct PtyData {
    id: u32,
    data: String,
}

#[tauri::command]
pub fn pty_spawn(app: AppHandle, state: State<PtyState>, cwd: Option<String>, cols: u16, rows: u16) -> Result<u32, String> {
    let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let shell = if cfg!(windows) { "powershell.exe".to_string() } else { std::env::var("SHELL").unwrap_or("/bin/sh".into()) };
    let mut cmd = CommandBuilder::new(shell);
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = {
        let mut n = state.next.lock().unwrap();
        *n += 1;
        *n
    };
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut carry: Vec<u8> = Vec::new();
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            carry.extend_from_slice(&buf[..n]);
            // Emit only complete UTF-8; keep a trailing partial sequence for the next read.
            let valid = match std::str::from_utf8(&carry) {
                Ok(_) => carry.len(),
                Err(e) => e.valid_up_to(),
            };
            if valid > 0 {
                let data = String::from_utf8_lossy(&carry[..valid]).into_owned();
                let _ = app.emit("pty-data", PtyData { id, data });
                carry.drain(..valid);
            }
        }
        let _ = app.emit("pty-exit", id);
    });
    state.sessions.lock().unwrap().insert(id, Session { master: pair.master, writer, child });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut s = state.sessions.lock().unwrap();
    let sess = s.get_mut(&id).ok_or("no such terminal")?;
    sess.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let s = state.sessions.lock().unwrap();
    let sess = s.get(&id).ok_or("no such terminal")?;
    sess.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<PtyState>, id: u32) {
    if let Some(mut sess) = state.sessions.lock().unwrap().remove(&id) {
        let _ = sess.child.kill();
    }
}
