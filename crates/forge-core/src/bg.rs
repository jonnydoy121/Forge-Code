//! Background processes the agent starts (dev servers, watchers). The agent can read their recent output and stop
//! them; they die with Forge. They run with a scrubbed environment but WITHOUT the network sandbox, because a dev
//! server must listen on a port, so starting one always goes through the permission gate.

use crate::sandbox::{prepare_dirs, sandbox_env};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

const MAX_LINES: usize = 2000;

struct Proc {
    command: String,
    child: Child,
    lines: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Default)]
pub struct Background {
    next: Mutex<u32>,
    procs: Mutex<HashMap<u32, Proc>>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BgInfo {
    pub id: u32,
    pub command: String,
    pub running: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BgOutput {
    pub running: bool,
    pub exit_code: Option<i32>,
    pub output: String,
}

fn pump(r: impl std::io::Read + Send + 'static, lines: Arc<Mutex<VecDeque<String>>>, tag: &'static str) {
    std::thread::spawn(move || {
        for line in BufReader::new(r).lines().map_while(Result::ok) {
            let mut q = lines.lock().unwrap();
            if q.len() >= MAX_LINES {
                q.pop_front();
            }
            q.push_back(if tag.is_empty() { line } else { format!("[{tag}] {line}") });
        }
    });
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

impl Background {
    pub fn start(&self, command: &str, workspace: &Path) -> Result<u32, String> {
        let sandbox_dir = workspace.join(".forge").join("sandbox");
        prepare_dirs(&sandbox_dir).map_err(|e| e.to_string())?;
        let env = sandbox_env(std::env::vars(), &sandbox_dir);
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/D", "/S", "/C"]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c.raw_arg(format!("\"{command}\""));
            }
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", command]);
            c
        };
        cmd.current_dir(workspace).env_clear().envs(env).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0); // own process group, so a timeout or stop can kill the whole tree
        }
        let mut child = cmd.spawn().map_err(|e| format!("failed to start: {e}"))?;
        let lines = Arc::new(Mutex::new(VecDeque::new()));
        pump(child.stdout.take().unwrap(), lines.clone(), "");
        pump(child.stderr.take().unwrap(), lines.clone(), "stderr");
        let id = {
            let mut n = self.next.lock().unwrap();
            *n += 1;
            *n
        };
        self.procs.lock().unwrap().insert(id, Proc { command: command.to_string(), child, lines });
        Ok(id)
    }

    pub fn read(&self, id: u32, last: usize) -> Result<BgOutput, String> {
        let mut procs = self.procs.lock().unwrap();
        let p = procs.get_mut(&id).ok_or_else(|| format!("no background process {id}"))?;
        let status = p.child.try_wait().map_err(|e| e.to_string())?;
        let q = p.lines.lock().unwrap();
        let skip = q.len().saturating_sub(last.max(1));
        Ok(BgOutput { running: status.is_none(), exit_code: status.and_then(|s| s.code()), output: q.iter().skip(skip).cloned().collect::<Vec<_>>().join("\n") })
    }

    pub fn stop(&self, id: u32) -> Result<(), String> {
        let mut procs = self.procs.lock().unwrap();
        let mut p = procs.remove(&id).ok_or_else(|| format!("no background process {id}"))?;
        kill_tree(p.child.id());
        let _ = p.child.kill();
        let _ = p.child.wait();
        Ok(())
    }

    pub fn list(&self) -> Vec<BgInfo> {
        let mut procs = self.procs.lock().unwrap();
        let mut out: Vec<BgInfo> = procs.iter_mut().map(|(id, p)| BgInfo { id: *id, command: p.command.clone(), running: p.child.try_wait().ok().flatten().is_none() }).collect();
        out.sort_by_key(|i| i.id);
        out
    }

    pub fn stop_all(&self) {
        let ids: Vec<u32> = self.procs.lock().unwrap().keys().copied().collect();
        for id in ids {
            let _ = self.stop(id);
        }
    }
}

impl Drop for Background {
    fn drop(&mut self) {
        self.stop_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn wait_for(bg: &Background, id: u32, needle: &str) -> BgOutput {
        let t = Instant::now();
        loop {
            let o = bg.read(id, 50).unwrap();
            if o.output.contains(needle) || t.elapsed() > Duration::from_secs(15) {
                return o;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn long_running_process_output_is_readable_while_it_runs_and_it_can_be_stopped() {
        let ws = tempfile::tempdir().unwrap();
        let bg = Background::default();
        let long = if cfg!(windows) { "echo server-ready && ping -n 30 127.0.0.1 >nul" } else { "echo server-ready && sleep 30" };
        let id = bg.start(long, ws.path()).unwrap();
        let o = wait_for(&bg, id, "server-ready");
        assert!(o.output.contains("server-ready"));
        assert!(o.running, "still running");
        assert_eq!(bg.list().iter().filter(|i| i.running).count(), 1);
        bg.stop(id).unwrap();
        assert!(bg.read(id, 5).is_err(), "gone after stop");
    }

    #[test]
    fn finished_processes_report_their_exit_code() {
        let ws = tempfile::tempdir().unwrap();
        let bg = Background::default();
        let id = bg.start("echo done && exit 3", ws.path()).unwrap();
        let t = Instant::now();
        let o = loop {
            let o = bg.read(id, 10).unwrap();
            if !o.running || t.elapsed() > Duration::from_secs(15) {
                break o;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        assert_eq!(o.exit_code, Some(3));
        assert!(o.output.contains("done"));
    }

    #[test]
    fn secrets_are_not_inherited_and_output_is_bounded() {
        std::env::set_var("FORGE_BG_SECRET_TOKEN", "leakme");
        let ws = tempfile::tempdir().unwrap();
        let bg = Background::default();
        let id = bg.start(if cfg!(windows) { "set" } else { "env" }, ws.path()).unwrap();
        std::thread::sleep(Duration::from_millis(800));
        let o = bg.read(id, 5000).unwrap();
        std::env::remove_var("FORGE_BG_SECRET_TOKEN");
        assert!(!o.output.contains("leakme"));
        assert!(o.output.to_uppercase().contains("PATH="));
    }
}
