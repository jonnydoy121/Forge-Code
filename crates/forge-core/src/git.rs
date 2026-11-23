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
    !name.is_empty() && name.len() <= 100 && !name.starts_with('-') && !name.contains("..") && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
}

/// Thread branches: `forge/<name>`. Only these may be merged or deleted from the UI.
fn valid_thread_branch(name: &str) -> bool {
    valid_branch(name) && name.strip_prefix("forge/").is_some_and(|rest| !rest.is_empty() && !rest.contains('/'))
}

/// Thread worktrees live in exactly `<root>/.forge/worktrees/<name>`: one level, simple characters, no `..`.
fn valid_worktree_path(root: &Path, path: &str) -> bool {
    let p = path.replace('\\', "/");
    let r = root.to_string_lossy().replace('\\', "/");
    let prefix = format!("{}/.forge/worktrees/", r.trim_end_matches('/'));
    p.strip_prefix(&prefix).is_some_and(|rest| !rest.is_empty() && !rest.starts_with('.') && rest.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
}

/// Validate and run a git command in `root`. Returns Err for anything outside the allowlist.
pub fn run(root: &Path, args: &[String]) -> Result<GitOutput, String> {
    let a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let allowed = match a.as_slice() {
        ["status", "--porcelain"]
        | ["diff", "--stat"]
        | ["diff"]
        | ["diff", "--cached"]
        | ["rev-parse", "--abbrev-ref", "HEAD"]
        | ["rev-parse", "--is-inside-work-tree"]
        | ["rev-parse", "HEAD"]
        | ["rev-parse", "--git-path", "info/exclude"]
        | ["add", "-A"] => true,
        ["checkout", "-b", name] => valid_branch(name),
        ["commit", "-m", msg] => !msg.trim().is_empty(),
        ["log", "--oneline", "-n", n] => n.parse::<u32>().map(|n| n <= 50).unwrap_or(false),
        // Isolated agent threads: a worktree on its own branch, merged back or thrown away by the developer.
        ["worktree", "add", "-b", branch, path, "HEAD"] => valid_thread_branch(branch) && valid_worktree_path(root, path),
        ["worktree", "remove", "--force", path] => valid_worktree_path(root, path),
        ["worktree", "prune"] => true,
        ["branch", "-D", branch] => valid_thread_branch(branch),
        ["merge", "--no-ff", "-m", msg, branch] => !msg.trim().is_empty() && msg.len() <= 500 && valid_thread_branch(branch),
        ["merge", "--abort"] => true,
        ["diff", "--stat", range] => range.strip_prefix("HEAD...").is_some_and(valid_thread_branch),
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

    fn repo() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        git(d.path(), &["init", "-q"]);
        git(d.path(), &["config", "user.email", "t@t"]);
        git(d.path(), &["config", "user.name", "t"]);
        git(d.path(), &["config", "core.autocrlf", "false"]); // keep line endings as written, whatever the machine's global setting
        std::fs::write(d.path().join("a.txt"), "one\n").unwrap();
        assert!(run(d.path(), &s(&["add", "-A"])).unwrap().ok);
        assert!(run(d.path(), &s(&["commit", "-m", "initial"])).unwrap().ok);
        d
    }
    fn wt_path(root: &Path, name: &str) -> String {
        format!("{}/.forge/worktrees/{name}", root.to_string_lossy().replace('\\', "/"))
    }

    #[test]
    fn a_thread_gets_its_own_worktree_and_branch_which_merge_back_and_clean_up() {
        let d = repo();
        let wt = wt_path(d.path(), "t2");
        assert!(run(d.path(), &s(&["worktree", "add", "-b", "forge/t2", &wt, "HEAD"])).unwrap().ok);
        // The thread edits and commits inside its worktree; the main checkout is untouched.
        std::fs::write(
            Path::new(&wt).join("a.txt"),
            "two
",
        )
        .unwrap();
        std::fs::write(
            Path::new(&wt).join("new.txt"),
            "added
",
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            "one
"
        );
        assert!(run(Path::new(&wt), &s(&["add", "-A"])).unwrap().ok);
        assert!(run(Path::new(&wt), &s(&["commit", "-m", "thread work"])).unwrap().ok);
        let stat = run(d.path(), &s(&["diff", "--stat", "HEAD...forge/t2"])).unwrap().stdout;
        assert!(stat.contains("a.txt") && stat.contains("new.txt"), "{stat}");
        // Merge into main, then remove the worktree and branch.
        assert!(run(d.path(), &s(&["merge", "--no-ff", "-m", "Merge thread t2", "forge/t2"])).unwrap().ok);
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            "two
"
        );
        assert!(d.path().join("new.txt").exists());
        assert!(run(d.path(), &s(&["worktree", "remove", "--force", &wt])).unwrap().ok);
        assert!(run(d.path(), &s(&["branch", "-D", "forge/t2"])).unwrap().ok);
        assert!(!Path::new(&wt).exists());
    }

    #[test]
    fn a_conflicting_merge_can_be_aborted_leaving_main_clean() {
        let d = repo();
        let wt = wt_path(d.path(), "t3");
        run(d.path(), &s(&["worktree", "add", "-b", "forge/t3", &wt, "HEAD"])).unwrap();
        std::fs::write(
            Path::new(&wt).join("a.txt"),
            "thread
",
        )
        .unwrap();
        run(Path::new(&wt), &s(&["add", "-A"])).unwrap();
        run(Path::new(&wt), &s(&["commit", "-m", "t"])).unwrap();
        std::fs::write(
            d.path().join("a.txt"),
            "main
",
        )
        .unwrap(); // the developer changed the same line meanwhile
        run(d.path(), &s(&["add", "-A"])).unwrap();
        run(d.path(), &s(&["commit", "-m", "main change"])).unwrap();
        let merged = run(d.path(), &s(&["merge", "--no-ff", "-m", "m", "forge/t3"])).unwrap();
        assert!(!merged.ok, "same-line edits must conflict");
        assert!(run(d.path(), &s(&["merge", "--abort"])).unwrap().ok);
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            "main
"
        );
        assert_eq!(run(d.path(), &s(&["status", "--porcelain"])).unwrap().stdout.trim(), "");
    }

    #[test]
    fn worktree_and_merge_commands_are_tightly_validated() {
        let d = repo();
        let ok = wt_path(d.path(), "t4");
        let outside = format!("{}/elsewhere/t4", d.path().to_string_lossy().replace('\\', "/"));
        let escape = format!("{}/.forge/worktrees/../../evil", d.path().to_string_lossy().replace('\\', "/"));
        let nested = format!("{ok}/deeper");
        for bad in [
            s(&["worktree", "add", "-b", "forge/x", &outside, "HEAD"]),
            s(&["worktree", "add", "-b", "forge/x", &escape, "HEAD"]),
            s(&["worktree", "add", "-b", "forge/x", &nested, "HEAD"]),
            s(&["worktree", "add", "-b", "main", &ok, "HEAD"]),      // not a thread branch
            s(&["worktree", "add", "-b", "forge/a/b", &ok, "HEAD"]), // no nesting
            s(&["worktree", "add", "-b", "forge/x", &ok, "some-other-commit"]),
            s(&["worktree", "add", "--force", "-b", "forge/x", &ok, "HEAD"]),
            s(&["worktree", "remove", "--force", &outside]),
            s(&["worktree", "remove", &ok]),
            s(&["branch", "-D", "main"]),
            s(&["branch", "-d", "forge/x"]),
            s(&["merge", "forge/x"]), // must be --no-ff with a message
            s(&["merge", "--no-ff", "-m", "m", "main"]),
            s(&["merge", "--no-ff", "-m", "  ", "forge/x"]),
            s(&["merge", "--no-ff", "-m", "m", "--strategy=ours"]),
            s(&["diff", "--stat", "HEAD...main"]),
            s(&["diff", "--stat", "main...forge/x"]),
        ] {
            assert!(run(d.path(), &bad).is_err(), "{bad:?} should be refused");
        }
        // A well-formed one is accepted by validation.
        assert!(run(d.path(), &s(&["worktree", "add", "-b", "forge/t4", &ok, "HEAD"])).unwrap().ok);
    }
}
