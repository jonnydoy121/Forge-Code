//! Sandboxed command execution for the agent.
//!
//! * Environment scrubbing and a private HOME/TEMP are portable and always applied.
//! * On Windows the command runs inside an AppContainer: no network (including loopback), no access to the user's
//!   profile, credential stores or any directory that has not been granted to the container, and the process tree is
//!   confined to a kill-on-close job object.
//! * Other platforms use the scrubbed environment only (Seatbelt / bubblewrap are not wired up yet).

use crate::exec::ExecResult;
use std::path::{Path, PathBuf};
use std::time::Duration;

const SECRET_NAME_PARTS: &[&str] = &["token", "secret", "passw", "api_key", "apikey", "api-key", "credential", "private_key", "auth", "session", "cookie", "ssh_auth_sock"];
const SECRET_PREFIXES: &[&str] = &["aws_", "azure_", "gcp_", "google_application", "anthropic", "openai", "github_", "gh_", "docker_", "kube", "npm_config__auth"];

/// True for environment variable names that probably hold credentials.
pub fn is_secret_env(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    SECRET_NAME_PARTS.iter().any(|p| n.contains(p)) || SECRET_PREFIXES.iter().any(|p| n.starts_with(p))
}

/// The environment an agent command sees: the parent's, minus secrets, with HOME and TEMP redirected into the sandbox.
pub fn sandbox_env(parent: impl Iterator<Item = (String, String)>, sandbox_dir: &Path) -> Vec<(String, String)> {
    let home = sandbox_dir.join("home");
    let tmp = sandbox_dir.join("tmp");
    let mut out: Vec<(String, String)> = parent.filter(|(k, _)| !is_secret_env(k)).collect();
    let override_vars = [
        ("HOME", home.clone()),
        ("USERPROFILE", home.clone()),
        ("APPDATA", home.join("AppData").join("Roaming")),
        ("LOCALAPPDATA", home.join("AppData").join("Local")),
        ("XDG_CONFIG_HOME", home.join(".config")),
        ("XDG_CACHE_HOME", home.join(".cache")),
        ("TEMP", tmp.clone()),
        ("TMP", tmp.clone()),
        ("TMPDIR", tmp),
    ];
    for (k, v) in override_vars {
        out.retain(|(ek, _)| !ek.eq_ignore_ascii_case(k));
        out.push((k.to_string(), v.to_string_lossy().into_owned()));
    }
    out
}

pub fn prepare_dirs(sandbox_dir: &Path) -> std::io::Result<()> {
    for d in ["home/AppData/Roaming", "home/AppData/Local", "home/.config", "home/.cache", "tmp"] {
        std::fs::create_dir_all(sandbox_dir.join(d))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    AppContainer,
    EnvOnly,
}

/// What kind of isolation `run` will provide on this machine.
pub fn available_mode() -> Mode {
    #[cfg(windows)]
    {
        if win::probe() {
            return Mode::AppContainer;
        }
    }
    Mode::EnvOnly
}

#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Also give the container read+execute access to tool directories on PATH that are outside the user profile
    /// (e.g. C:\Program Files\nodejs) so project tools run. Best effort: needs rights to change those ACLs.
    pub toolchain_read: bool,
}

#[derive(Debug)]
pub struct Outcome {
    pub result: ExecResult,
    pub mode: Mode,
    /// directories the container was granted read access to for this run
    pub granted: Vec<String>,
    pub warnings: Vec<String>,
}

/// PATH directories outside the user's profile and the Windows directory: where installed tools usually live.
pub fn toolchain_dirs() -> Vec<PathBuf> {
    let profile = std::env::var("USERPROFILE").unwrap_or_default().to_lowercase();
    let windir = std::env::var("SystemRoot").unwrap_or_else(|_| r"c:\windows".into()).to_lowercase();
    let mut out: Vec<PathBuf> = Vec::new();
    for p in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let l = p.to_string_lossy().to_lowercase();
        if p.is_dir() && !l.starts_with(&windir) && (profile.is_empty() || !l.starts_with(&profile)) && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// Run `command` (a shell command line) confined to `workspace`. Reports the isolation actually used.
pub fn run(command: &str, workspace: &Path, timeout: Duration, max_output: usize, opts: &Options) -> Result<Outcome, String> {
    let sandbox_dir = workspace.join(".forge").join("sandbox");
    prepare_dirs(&sandbox_dir).map_err(|e| e.to_string())?;
    let env = sandbox_env(std::env::vars(), &sandbox_dir);
    #[cfg(windows)]
    {
        let toolchain = if opts.toolchain_read { toolchain_dirs() } else { vec![] };
        match win::run(command, workspace, &sandbox_dir, &env, timeout, max_output, &toolchain) {
            Ok((result, granted, warnings)) => return Ok(Outcome { result, mode: Mode::AppContainer, granted, warnings }),
            Err(e) if e.starts_with("appcontainer unavailable") => { /* fall through to env-only */ }
            Err(e) => return Err(e),
        }
    }
    let _ = opts;
    let result = crate::exec::run_shell_env_only(command, workspace, timeout, &env, max_output)?;
    Ok(Outcome { result, mode: Mode::EnvOnly, granted: vec![], warnings: vec!["no OS sandbox on this platform: only the environment is scrubbed and HOME/TEMP redirected".into()] })
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::collections::HashSet;
    use std::ffi::c_void;
    use std::io::Read;
    use std::os::windows::io::FromRawHandle;
    use std::ptr::{null, null_mut};
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::Isolation::{CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName};
    use windows_sys::Win32::Security::{SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::*;

    const NAME: &str = "ForgeSandbox";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The container SID, creating the profile on first use.
    unsafe fn container_sid() -> Result<*mut c_void, String> {
        let name = wide(NAME);
        let mut sid: *mut c_void = null_mut();
        let hr = CreateAppContainerProfile(name.as_ptr(), name.as_ptr(), name.as_ptr(), null(), 0, &mut sid);
        if hr == 0 {
            return Ok(sid);
        }
        // HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)
        if hr as u32 == 0x800700B7 {
            let hr2 = DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid);
            if hr2 == 0 {
                return Ok(sid);
            }
            return Err(format!("appcontainer unavailable: derive sid failed (0x{:08X})", hr2 as u32));
        }
        Err(format!("appcontainer unavailable: create profile failed (0x{:08X})", hr as u32))
    }

    unsafe fn sid_string(sid: *mut c_void) -> Result<String, String> {
        let mut p: *mut u16 = null_mut();
        if ConvertSidToStringSidW(sid, &mut p) == 0 {
            return Err("appcontainer unavailable: cannot format sid".into());
        }
        let mut len = 0;
        while *p.add(len) != 0 {
            len += 1;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
        LocalFree(p as *mut c_void);
        Ok(s)
    }

    /// Cheap check that the container API works here.
    pub fn probe() -> bool {
        static OK: OnceLock<bool> = OnceLock::new();
        *OK.get_or_init(|| unsafe { container_sid().is_ok() })
    }

    static GRANTED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

    /// Give the container modify rights on a directory (inherited by its contents).
    fn grant(sid: &str, dir: &Path, perm: &str) -> Result<(), String> {
        let set = GRANTED.get_or_init(|| Mutex::new(HashSet::new()));
        if !set.lock().unwrap().insert(dir.join(format!("#{perm}"))) {
            return Ok(());
        }
        let out = std::process::Command::new("icacls")
            .arg(dir)
            .arg("/grant")
            .arg(format!("*{sid}:(OI)(CI){perm}"))
            .arg("/Q")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("appcontainer unavailable: icacls: {e}"))?;
        if out.status.success() { Ok(()) } else { Err(format!("appcontainer unavailable: could not grant access to {}: {}", dir.display(), String::from_utf8_lossy(&out.stderr))) }
    }

    fn drain(mut f: std::fs::File, cap: usize) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut buf = [0u8; 8192];
            let mut dropped = false;
            while let Ok(n) = f.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if out.len() < cap {
                    let take = n.min(cap - out.len());
                    out.extend_from_slice(&buf[..take]);
                    dropped |= take < n;
                } else {
                    dropped = true;
                }
            }
            let mut s = String::from_utf8_lossy(&out).into_owned();
            if dropped {
                s.push_str("\n[output truncated]");
            }
            s
        })
    }

    pub fn run(command: &str, workspace: &Path, sandbox_dir: &Path, env: &[(String, String)], timeout: Duration, max_output: usize, toolchain: &[PathBuf]) -> Result<(ExecResult, Vec<String>, Vec<String>), String> {
        unsafe {
            let sid = container_sid()?;
            let sid_str = sid_string(sid)?;
            grant(&sid_str, workspace, "M")?;
            grant(&sid_str, sandbox_dir, "M")?;
            let (mut granted, mut warnings) = (Vec::new(), Vec::new());
            for d in toolchain {
                match grant(&sid_str, d, "RX") {
                    Ok(()) => granted.push(d.to_string_lossy().into_owned()),
                    Err(e) => warnings.push(format!("could not grant read access to {}: tools installed there may not run in the sandbox ({})", d.display(), e.trim())),
                }
            }

            let mut sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: null_mut(), bInheritHandle: 1 };
            let (mut out_r, mut out_w, mut err_r, mut err_w): (HANDLE, HANDLE, HANDLE, HANDLE) = (null_mut(), null_mut(), null_mut(), null_mut());
            if CreatePipe(&mut out_r, &mut out_w, &sa, 0) == 0 || CreatePipe(&mut err_r, &mut err_w, &sa, 0) == 0 {
                return Err("could not create pipes".into());
            }
            SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0);
            SetHandleInformation(err_r, HANDLE_FLAG_INHERIT, 0);
            let nul = wide("NUL");
            let stdin = CreateFileW(nul.as_ptr(), FILE_GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null_mut());

            // Attribute list: container identity (no capabilities = no network) + only these three inheritable handles.
            let mut size = 0usize;
            InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size);
            let mut attr_buf = vec![0u8; size];
            let attrs = attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
            if InitializeProcThreadAttributeList(attrs, 2, 0, &mut size) == 0 {
                return Err("InitializeProcThreadAttributeList failed".into());
            }
            let caps = SECURITY_CAPABILITIES { AppContainerSid: sid, Capabilities: null_mut(), CapabilityCount: 0, Reserved: 0 };
            if UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize, &caps as *const _ as *const c_void, std::mem::size_of::<SECURITY_CAPABILITIES>(), null_mut(), null()) == 0 {
                return Err("appcontainer unavailable: UpdateProcThreadAttribute(security capabilities) failed".into());
            }
            let mut handles = [stdin, out_w, err_w];
            if UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, handles.as_mut_ptr() as *const c_void, std::mem::size_of_val(&handles), null_mut(), null()) == 0 {
                return Err("UpdateProcThreadAttribute(handle list) failed".into());
            }

            let mut si: STARTUPINFOEXW = std::mem::zeroed();
            si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = stdin;
            si.StartupInfo.hStdOutput = out_w;
            si.StartupInfo.hStdError = err_w;
            si.lpAttributeList = attrs;

            let mut env_block: Vec<u16> = Vec::new();
            let mut sorted: Vec<&(String, String)> = env.iter().collect();
            sorted.sort_by_key(|(k, _)| k.to_ascii_uppercase());
            for (k, v) in sorted {
                env_block.extend(format!("{k}={v}").encode_utf16());
                env_block.push(0);
            }
            env_block.push(0);

            let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
            let cmd_exe = wide(&format!("{sysroot}\\System32\\cmd.exe"));
            // /S strips exactly the outer quotes we add, so the command line reaches cmd unmodified.
            let mut cmdline = wide(&format!("cmd.exe /D /S /C \"{command}\""));
            let cwd = wide(&workspace.to_string_lossy());
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            let ok = CreateProcessW(
                cmd_exe.as_ptr(),
                cmdline.as_mut_ptr(),
                null(),
                null(),
                1,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | CREATE_SUSPENDED,
                env_block.as_ptr() as *const c_void,
                cwd.as_ptr(),
                &si.StartupInfo,
                &mut pi,
            );
            let err = GetLastError();
            DeleteProcThreadAttributeList(attrs);
            CloseHandle(out_w);
            CloseHandle(err_w);
            CloseHandle(stdin);
            if ok == 0 {
                CloseHandle(out_r);
                CloseHandle(err_r);
                return Err(format!("appcontainer unavailable: CreateProcess failed ({err})"));
            }

            let job = CreateJobObjectW(null(), null());
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const c_void, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
            AssignProcessToJobObject(job, pi.hProcess);
            let started = Instant::now();
            ResumeThread(pi.hThread);

            let out = drain(std::fs::File::from_raw_handle(out_r as *mut c_void), max_output);
            let errh = drain(std::fs::File::from_raw_handle(err_r as *mut c_void), max_output);
            let wait = WaitForSingleObject(pi.hProcess, timeout.as_millis().min(u32::MAX as u128 - 1) as u32);
            let timed_out = wait == WAIT_TIMEOUT;
            if timed_out {
                TerminateJobObject(job, 1);
                WaitForSingleObject(pi.hProcess, 5000);
            }
            let mut code: u32 = 0;
            GetExitCodeProcess(pi.hProcess, &mut code);
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
            CloseHandle(job); // kills anything the command left running
            Ok((ExecResult { code: if timed_out { None } else { Some(code as i32) }, stdout: out.join().unwrap_or_default(), stderr: errh.join().unwrap_or_default(), timed_out, millis: started.elapsed().as_millis() }, granted, warnings))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_env_detection() {
        for n in ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY", "MY_PASSWORD", "SSH_AUTH_SOCK", "npm_config__authToken", "OPENAI_KEY", "kubeconfig"] {
            assert!(is_secret_env(n), "{n}");
        }
        for n in ["PATH", "HOME", "NODE_ENV", "CARGO_HOME", "SystemRoot", "TEMP"] {
            assert!(!is_secret_env(n), "{n}");
        }
    }

    #[test]
    fn sandbox_env_removes_secrets_and_redirects_home() {
        let parent = vec![("PATH".to_string(), "/bin".to_string()), ("GITHUB_TOKEN".to_string(), "x".to_string()), ("HOME".to_string(), "/real".to_string()), ("TEMP".to_string(), "/real/tmp".to_string())];
        let env = sandbox_env(parent.into_iter(), Path::new("/ws/.forge/sandbox"));
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert!(get("GITHUB_TOKEN").is_none());
        assert_eq!(get("PATH").as_deref(), Some("/bin"));
        assert!(get("HOME").unwrap().ends_with("home"));
        assert!(get("TEMP").unwrap().ends_with("tmp"));
        assert!(env.iter().filter(|(k, _)| k == "HOME").count() == 1);
    }
}
