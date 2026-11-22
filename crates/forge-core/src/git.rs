//! A deliberately small git surface for the UI: only the operations Forge itself needs, validated.
//! Anything else (push, reset --hard, ...) is not reachable from here.

use std::path::Path;
use std::process::Command;

#[derive(Debug, PartialEq, Eq)]
pub struct GitOutput {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

fn valid_branch(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('-')
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
}

/// Validate and run a git command in `root`. Returns Err for anything outside the allowlist.
pub fn run(root: &Path, args: &[String]) -> Result<GitOutput, String> {
    let a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let allowed = match a.as_slice() {
        ["status", "--porcelain"] | ["diff", "--stat"] | ["diff"] | ["diff", "--cached"] | ["rev-parse", "--abbrev-ref", "HEAD"] | ["rev-parse", "--is-inside-work-tree"] | ["add", "-A"] => true,
        ["checkout", "-b", name] => valid_branch(name),
        ["commit", "-m", msg] => !msg.trim().is_empty(),
        ["log", "--oneline", "-n", n] => n.parse::<u32>().map(|n| n <= 50).unwrap_or(false),
        _ => false,
    };
    if !allowed {
        return Err(format!("git command not allowed: {}", a.join(" ")));
    }
    let out = Command::new("git").args(&a).current_dir(root).output().map_err(|e| format!("could not run git: {e}"))?;
    Ok(GitOutput { ok: out.status.success(), stdout: String::from_utf8_lossy(&out.stdout).into_owned(), stderr: String::from_utf8_lossy(&out.stderr).into_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        assert!(Command::new("git").args(args).current_dir(dir).status().unwrap().success());
    }
    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn allowlist_blocks_dangerous_commands() {
        let d = tempfile::tempdir().unwrap();
        for bad in [&["push"][..], &["reset", "--hard"], &["checkout", "main"], &["checkout", "-b", "--force"], &["checkout", "-b", "a b"], &["commit", "--amend"], &["clean", "-fd"], &["log", "-n", "999"]] {
            assert!(run(d.path(), &s(bad)).is_err(), "{bad:?} should be blocked");
        }
    }

    #[test]
    fn creates_a_branch_and_commits_accepted_changes() {
        let d = tempfile::tempdir().unwrap();
        git(d.path(), &["init", "-q"]);
        git(d.path(), &["config", "user.email", "t@t"]);
        git(d.path(), &["config", "user.name", "t"]);
        std::fs::write(d.path().join("a.txt"), "1").unwrap();
        assert!(run(d.path(), &s(&["add", "-A"])).unwrap().ok);
        assert!(run(d.path(), &s(&["commit", "-m", "initial"])).unwrap().ok);
        assert!(run(d.path(), &s(&["checkout", "-b", "forge/rename-get-by-id"])).unwrap().ok);
        assert_eq!(run(d.path(), &s(&["rev-parse", "--abbrev-ref", "HEAD"])).unwrap().stdout.trim(), "forge/rename-get-by-id");
        std::fs::write(d.path().join("a.txt"), "2").unwrap();
        assert!(run(d.path(), &s(&["status", "--porcelain"])).unwrap().stdout.contains("a.txt"));
        run(d.path(), &s(&["add", "-A"])).unwrap();
        assert!(run(d.path(), &s(&["commit", "-m", "Rename getById"])).unwrap().ok);
        assert!(run(d.path(), &s(&["log", "--oneline", "-n", "5"])).unwrap().stdout.contains("Rename getById"));
    }
}
