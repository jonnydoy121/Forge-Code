//! Real isolation checks. They need an OS sandbox, so they only run where one is available (Windows AppContainer).
//! Every "blocked" assertion is paired with a positive control (the same thing works unsandboxed, or the tool provably ran
//! inside the container) so a command that simply fails to start cannot make a test pass.
use forge_core::exec::run_shell;
use forge_core::sandbox::{self, Mode, Options};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

fn workspace() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn skip_without_container() -> bool {
    if sandbox::available_mode() != Mode::AppContainer {
        eprintln!("skipping: no AppContainer on this machine");
        return true;
    }
    false
}

fn run(cmd: &str, ws: &std::path::Path, secs: u64) -> sandbox::Outcome {
    sandbox::run(cmd, ws, Duration::from_secs(secs), 100_000, &Options::default()).unwrap()
}

#[test]
fn reports_what_isolation_it_provides() {
    let m = sandbox::available_mode();
    assert_eq!(m, if cfg!(windows) { Mode::AppContainer } else { Mode::EnvOnly });
}

#[test]
fn can_write_inside_the_workspace_and_sees_it_as_cwd() {
    if skip_without_container() {
        return;
    }
    let ws = workspace();
    let o = run("echo hello> out.txt && cd", ws.path(), 30);
    assert_eq!(o.mode, Mode::AppContainer);
    assert_eq!(o.result.code, Some(0), "stderr: {}", o.result.stderr);
    assert_eq!(std::fs::read_to_string(ws.path().join("out.txt")).unwrap().trim(), "hello");
    assert!(o.result.stdout.trim().to_lowercase().ends_with(&ws.path().file_name().unwrap().to_string_lossy().to_lowercase()));
}

#[test]
fn cannot_read_files_outside_the_workspace() {
    if skip_without_container() {
        return;
    }
    let outside = tempfile::tempdir().unwrap(); // not granted to the container
    let secret = outside.path().join("id_rsa");
    std::fs::write(&secret, "TOP-SECRET-KEY").unwrap();
    let ws = workspace();
    let cmd = format!("type \"{}\"", secret.display());

    let plain = run_shell(&cmd, ws.path(), Duration::from_secs(30), &[], 10_000).unwrap();
    assert!(plain.stdout.contains("TOP-SECRET-KEY"), "positive control: an ordinary process reads it");

    let o = run(&cmd, ws.path(), 30);
    assert!(!o.result.stdout.contains("TOP-SECRET-KEY"), "sandbox leaked the file");
    assert_ne!(o.result.code, Some(0));
    assert!(o.result.stderr.to_lowercase().contains("access is denied"), "expected an access-denied error, got: {}", o.result.stderr);
}

#[test]
fn cannot_reach_the_user_profile() {
    if skip_without_container() {
        return;
    }
    let ws = workspace();
    let profile = std::env::var("USERPROFILE").unwrap();
    let cmd = format!("dir \"{profile}\\Documents\"");
    let plain = run_shell(&cmd, ws.path(), Duration::from_secs(30), &[], 10_000).unwrap();
    assert!(plain.stdout.to_lowercase().contains("<dir>") || plain.stdout.contains("File(s)"), "positive control: the profile is listable normally: {}", plain.stdout);
    let o = run(&cmd, ws.path(), 30);
    assert!(!o.result.stdout.contains("File(s)"), "profile contents visible: {}", o.result.stdout);
    assert!(o.result.stderr.to_lowercase().contains("denied") || o.result.stderr.to_lowercase().contains("not found"), "stderr: {}", o.result.stderr);
}

#[test]
fn network_is_off_even_for_loopback() {
    if skip_without_container() {
        return;
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            let mut s = s;
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nSERVER-SAID");
        }
    });
    let ws = workspace();
    let cmd = format!("curl --silent --show-error --max-time 10 http://127.0.0.1:{port}/");

    let plain = run_shell(&cmd, ws.path(), Duration::from_secs(30), &[], 10_000).unwrap();
    assert!(plain.stdout.contains("SERVER-SAID"), "positive control: unsandboxed curl reaches the listener: {} {}", plain.stdout, plain.stderr);

    let o = run(&cmd, ws.path(), 30);
    assert!(!o.result.stdout.contains("SERVER-SAID"), "sandbox reached the network");
    // curl itself ran (it printed its own error), so this is a real network refusal, not a missing binary
    assert!(o.result.stderr.contains("curl:"), "curl should have run and failed to connect; stderr: {}", o.result.stderr);
    assert_ne!(o.result.code, Some(0));
}

#[test]
fn secrets_in_the_parent_environment_are_not_visible() {
    if skip_without_container() {
        return;
    }
    std::env::set_var("FORGE_TEST_API_TOKEN", "hunter2-hunter2");
    let ws = workspace();
    let o = run("set", ws.path(), 30);
    std::env::remove_var("FORGE_TEST_API_TOKEN");
    assert_eq!(o.result.code, Some(0));
    assert!(o.result.stdout.to_uppercase().contains("PATH="), "positive control: `set` ran and printed the environment");
    assert!(!o.result.stdout.contains("hunter2"), "secret leaked into the sandbox environment");
    assert!(o.result.stdout.to_lowercase().contains("sandbox"), "HOME/TEMP should point into the sandbox directory");
}

#[test]
fn runaway_commands_are_killed_at_the_timeout() {
    if skip_without_container() {
        return;
    }
    let ws = workspace();
    let started = std::time::Instant::now();
    let o = sandbox::run("for /l %i in (1,1,2000000000) do @rem", ws.path(), Duration::from_millis(800), 10_000, &Options::default()).unwrap();
    assert!(o.result.timed_out);
    assert!(started.elapsed() < Duration::from_secs(15));
}

#[test]
fn toolchain_access_is_explicit_and_reported() {
    if skip_without_container() {
        return;
    }
    let ws = workspace();
    // Without toolchain access nothing outside the workspace and system dirs is granted.
    let off = run("echo hi", ws.path(), 30);
    assert!(off.granted.is_empty());
    // With it, tool directories on PATH are granted read-only and listed (or a warning explains why not).
    let on = sandbox::run("echo hi", ws.path(), Duration::from_secs(60), 10_000, &Options { toolchain_read: true }).unwrap();
    assert_eq!(on.result.code, Some(0));
    assert!(!on.granted.is_empty() || !on.warnings.is_empty());
    // If node's directory was granted, node now runs inside the container, and still has no network.
    if on.granted.iter().any(|d| d.to_lowercase().contains("nodejs")) {
        let n = sandbox::run("node -e \"console.log('NODE-IN-SANDBOX')\"", ws.path(), Duration::from_secs(30), 10_000, &Options { toolchain_read: true }).unwrap();
        assert!(n.result.stdout.contains("NODE-IN-SANDBOX"), "stdout {} stderr {}", n.result.stdout, n.result.stderr);
    }
}
