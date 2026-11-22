//! Run a shell command with a timeout and bounded output. Used for project checks and hooks.
//! (OS-level sandboxing of agent commands arrives with the permission gate in Phase 8.)

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct ExecResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub millis: u128,
}

fn read_capped(mut r: impl Read + Send + 'static, cap: usize) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let mut buf = [0u8; 8192];
        let mut dropped = false;
        while let Ok(n) = r.read(&mut buf) {
            if n == 0 {
                break;
            }
            if out.len() < cap {
                let take = n.min(cap - out.len());
                out.extend_from_slice(&buf[..take]);
                dropped |= take < n;
            } else {
                dropped = true; // keep draining so the child never blocks on a full pipe
            }
        }
        let mut s = String::from_utf8_lossy(&out).into_owned();
        if dropped {
            s.push_str("\n[output truncated]");
        }
        s
    })
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

pub fn run_shell(command: &str, cwd: &Path, timeout: Duration, env: &[(String, String)], max_output: usize) -> Result<ExecResult, String> {
    run_inner(command, cwd, timeout, env, max_output, false)
}

/// Like `run_shell`, but the child sees ONLY `env` (nothing inherited): used for sandboxed agent commands.
pub fn run_shell_env_only(command: &str, cwd: &Path, timeout: Duration, env: &[(String, String)], max_output: usize) -> Result<ExecResult, String> {
    run_inner(command, cwd, timeout, env, max_output, true)
}

fn run_inner(command: &str, cwd: &Path, timeout: Duration, env: &[(String, String)], max_output: usize, clear_env: bool) -> Result<ExecResult, String> {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/D", "/S", "/C"]);
        // Pass the command line verbatim. Rust would otherwise escape embedded quotes with backslashes, which
        // cmd.exe does not understand. With /S, cmd strips exactly the outer pair of quotes we add here.
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
    cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if clear_env {
        cmd.env_clear();
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // own process group, so a timeout or stop can kill the whole tree
    }
    let started = Instant::now();
    let mut child = cmd.spawn().map_err(|e| format!("failed to start command: {e}"))?;
    let out = read_capped(child.stdout.take().unwrap(), max_output);
    let err = read_capped(child.stderr.take().unwrap(), max_output);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) => break Some(s),
            None if started.elapsed() >= timeout => {
                timed_out = true;
                kill_tree(child.id());
                let _ = child.kill();
                break child.wait().ok();
            }
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    Ok(ExecResult {
        code: status.and_then(|s| s.code()),
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
        timed_out,
        millis: started.elapsed().as_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(cmd: &str, secs: u64) -> ExecResult {
        run_shell(cmd, &std::env::temp_dir(), Duration::from_secs(secs), &[], 1024).unwrap()
    }

    #[test]
    fn captures_stdout_stderr_and_exit_code() {
        let r = run("echo out && echo err 1>&2 && exit 3", 10);
        assert_eq!(r.code, Some(3));
        assert!(r.stdout.contains("out") && r.stderr.contains("err"));
        assert!(!r.timed_out);
    }

    #[test]
    fn embedded_quotes_reach_the_program_unescaped() {
        // Regression: Rust's default argv quoting turned "x y" into \"x y\" under cmd.exe.
        let r = run("echo \"quoted arg\"", 10);
        let expected = if cfg!(windows) { "\"quoted arg\"" } else { "quoted arg" };
        assert!(r.stdout.contains(expected), "got {:?}", r.stdout);
        assert!(!r.stdout.contains("\\\""));
    }

    #[test]
    fn passes_environment_variables() {
        let var = if cfg!(windows) { "echo %FORGE_X%" } else { "echo $FORGE_X" };
        let r = run_shell(var, &std::env::temp_dir(), Duration::from_secs(10), &[("FORGE_X".into(), "hello".into())], 1024).unwrap();
        assert!(r.stdout.contains("hello"));
    }

    #[test]
    fn kills_commands_that_exceed_the_timeout() {
        let sleeper = if cfg!(windows) { "ping -n 30 127.0.0.1 >nul" } else { "sleep 30" };
        let r = run_shell(sleeper, &std::env::temp_dir(), Duration::from_millis(300), &[], 1024).unwrap();
        assert!(r.timed_out);
        assert!(r.millis < 5000);
    }

    #[test]
    fn caps_runaway_output() {
        let spam = if cfg!(windows) { "for /L %i in (1,1,3000) do @echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } else { "yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | head -n 3000" };
        let r = run(spam, 20);
        assert!(r.stdout.len() < 2000);
        assert!(r.stdout.contains("[output truncated]"));
    }
}
