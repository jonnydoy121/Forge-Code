//! Generic line-oriented child process bridge, used for MCP servers and ACP agents (both speak newline-delimited
//! JSON-RPC over stdio). Each line from stdout is emitted as an event; the UI writes lines to stdin.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

struct Entry {
    stdin: ChildStdin,
    child: Child,
}

#[derive(Default)]
pub struct ProcState {
    next: Mutex<u32>,
    procs: Mutex<HashMap<u32, Entry>>,
}

#[derive(Clone, Serialize)]
struct Line {
    id: u32,
    line: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: u32,
    code: Option<i32>,
}

/// An absolute path to a real executable (the bundled agent runtime) needs no shell: launching it directly is faster and
/// avoids an extra cmd.exe process per child. Bare names (PATH lookup) and .cmd/.bat shims still go through cmd.
#[cfg(windows)]
fn is_direct_exe(program: &str) -> bool {
    let p = std::path::Path::new(program);
    p.is_absolute() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"))
}

#[cfg(windows)]
fn command_for(program: &str, args: &[String]) -> Command {
    use std::os::windows::process::CommandExt;
    if is_direct_exe(program) {
        let mut c = Command::new(program);
        c.args(args);
        c.creation_flags(0x0800_0000);
        return c;
    }
    // Run through cmd so PATH lookup and .cmd shims (npx, gemini, ...) work. Arguments with spaces are quoted.
    let quote = |a: &str| if a.is_empty() || a.contains([' ', '\t', '"']) { format!("\"{}\"", a.replace('"', "\\\"")) } else { a.to_string() };
    let line = std::iter::once(quote(program)).chain(args.iter().map(|a| quote(a))).collect::<Vec<_>>().join(" ");
    let mut c = Command::new("cmd");
    c.args(["/D", "/S", "/C"]).raw_arg(format!("\"{line}\""));
    c.creation_flags(0x0800_0000);
    c
}

#[cfg(not(windows))]
fn command_for(program: &str, args: &[String]) -> Command {
    let mut c = Command::new(program);
    c.args(args);
    c
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
}
#[cfg(not(windows))]
fn kill_tree(pid: u32) {
    // Children are started in their own process group (pgid == pid), so a negative pid kills the whole tree: killing
    // only the shell would leave its children running and holding the output pipes open.
    let group = Command::new("kill").args(["-9", "--", &format!("-{pid}")]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    if !group.map(|s| s.success()).unwrap_or(false) {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
}

#[tauri::command]
pub fn proc_start(app: AppHandle, state: State<ProcState>, command: String, args: Vec<String>, cwd: Option<String>, env: Vec<(String, String)>) -> Result<u32, String> {
    let mut cmd = command_for(&command, &args);
    if let Some(dir) = cwd {
        cmd.current_dir(Path::new(&dir));
    }
    cmd.envs(env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // own process group, so a timeout or stop can kill the whole tree
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start {command}: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let id = {
        let mut n = state.next.lock().unwrap();
        *n += 1;
        *n
    };
    let a1 = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = a1.emit("proc-line", Line { id, line });
        }
        let _ = a1.emit("proc-exit", Exit { id, code: None });
    });
    let a2 = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = a2.emit("proc-stderr", Line { id, line });
        }
    });
    state.procs.lock().unwrap().insert(id, Entry { stdin, child });
    Ok(id)
}

#[tauri::command]
pub fn proc_send(state: State<ProcState>, id: u32, line: String) -> Result<(), String> {
    let mut p = state.procs.lock().unwrap();
    let e = p.get_mut(&id).ok_or("process not running")?;
    e.stdin.write_all(line.as_bytes()).and_then(|_| e.stdin.write_all(b"\n")).and_then(|_| e.stdin.flush()).map_err(|e| e.to_string())
}

impl ProcState {
    /// Stop every child process. After a page reload the JavaScript that knew their ids is gone, so nothing else could.
    pub fn stop_all(&self) {
        let all: Vec<Entry> = self.procs.lock().unwrap().drain().map(|(_, e)| e).collect();
        for mut e in all {
            kill_tree(e.child.id());
            let _ = e.child.kill();
        }
    }
}

#[tauri::command]
pub fn proc_stop(state: State<ProcState>, id: u32) {
    if let Some(mut e) = state.procs.lock().unwrap().remove(&id) {
        kill_tree(e.child.id());
        let _ = e.child.kill();
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn an_absolute_exe_is_launched_directly_everything_else_goes_through_cmd() {
        let exe = r"C:\Program Files\Forge-Code\forge-runtime.exe";
        assert_eq!(command_for(exe, &[]).get_program(), std::ffi::OsStr::new(exe));
        // PATH lookups and shims need the shell.
        assert_eq!(command_for("npx", &[]).get_program(), std::ffi::OsStr::new("cmd"));
        assert_eq!(command_for(r"C:\tools\gemini.cmd", &[]).get_program(), std::ffi::OsStr::new("cmd"));
        assert_eq!(command_for(r"relative\thing.exe", &[]).get_program(), std::ffi::OsStr::new("cmd"));
        assert_eq!(command_for(r"C:\tools\app.EXE", &["--x".into()]).get_program(), std::ffi::OsStr::new(r"C:\tools\app.EXE"));
    }
}
