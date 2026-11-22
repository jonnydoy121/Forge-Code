use forge_core::index::Index;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

fn write(root: &Path, rel: &str, body: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, body).unwrap();
}

fn fixture() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let r = d.path();
    write(r, "src/auth.ts", "// Checks a password for a login attempt.\nexport function validatePassword(user: string, password: string): boolean {\n  return password.length > 8 && checkLogin(user);\n}\nexport function checkLogin(user: string) { return user !== ''; }\n");
    write(r, "src/user.ts", "import { validatePassword } from './auth';\n\n/** Looks a user up. */\nexport class UserService {\n  getById(id: string) { return validatePassword(id, 'x') ? id : null; }\n}\n");
    write(r, "src/api.ts", "import { UserService } from './user';\nconst svc = new UserService();\nexport function handle(id: string) { return svc.getById(id); }\n");
    write(r, "src/user.test.ts", "import { UserService } from './user';\nnew UserService().getById('1');\n");
    write(r, "pkg/util.py", "def helper():\n    return 1\n");
    write(r, "pkg/mod.py", "from .util import helper\n\ndef run():\n    return helper()\n");
    write(r, "matrix.ts", "export function matrixMultiply(a: number[][], b: number[][]) { return a.map(row => row.map((_, j) => b.reduce((s, r, k) => s + row[k]! * r[j]!, 0))); }\n");
    write(r, ".env", "TOKEN=supersecretvalue\n");
    write(r, ".gitignore", "ignored/\n");
    write(r, "ignored/x.ts", "export const hidden = 1;\n");
    write(r, ".forgeignore", "private.ts\n");
    write(r, "private.ts", "export const privateThing = 1;\n");
    write(r, "node_modules/dep/index.js", "module.exports = 1;\n");
    d
}

fn open(root: &Path, db: &Path) -> Index {
    Index::open(root, db).unwrap()
}

fn built() -> (tempfile::TempDir, tempfile::TempDir, Index) {
    let repo = fixture();
    let dbdir = tempfile::tempdir().unwrap();
    let idx = open(repo.path(), &dbdir.path().join("idx.db"));
    idx.build(&|_| {}).unwrap();
    (repo, dbdir, idx)
}

#[test]
fn respects_ignores_and_never_indexes_secrets() {
    let (_r, _d, idx) = built();
    let hits = idx.grep("supersecretvalue|hidden|privateThing|module.exports", None, 100).unwrap();
    assert!(hits.is_empty(), "leaked: {hits:?}");
    assert_eq!(idx.status().walked_files, 9); // fixture files minus .env, ignored/, private.ts, node_modules
}

#[test]
fn grep_honours_glob_and_returns_sorted_hits() {
    let (_r, _d, idx) = built();
    let hits = idx.grep("getById", Some("src/*.ts"), 100).unwrap();
    let files: Vec<_> = hits.iter().map(|h| h.file.as_str()).collect();
    assert_eq!(files, ["src/api.ts", "src/user.test.ts", "src/user.ts"]);
    assert!(idx.grep("helper", Some("*.ts"), 100).unwrap().is_empty());
    assert_eq!(idx.grep("helper", Some("*.py"), 100).unwrap().len(), 3);
}

#[test]
fn symbol_lookup_returns_signature_and_doc() {
    let (_r, _d, idx) = built();
    let s = idx.symbol("validatePassword");
    assert_eq!(s.len(), 1);
    assert_eq!(s[0].file, "src/auth.ts");
    assert_eq!(s[0].line, 2);
    assert!(s[0].signature.contains("validatePassword(user: string, password: string)"));
    assert_eq!(s[0].doc, "Checks a password for a login attempt.");
    assert!(idx.symbol("nope").is_empty());
}

#[test]
fn references_find_call_sites_and_mark_the_definition() {
    let (_r, _d, idx) = built();
    let refs = idx.references("getById").unwrap();
    let call_sites: Vec<_> = refs.iter().filter(|r| !r.is_definition).map(|r| r.file.as_str()).collect();
    assert_eq!(call_sites, ["src/api.ts", "src/user.test.ts"]);
    assert!(refs.iter().any(|r| r.is_definition && r.file == "src/user.ts"));
}

#[test]
fn dependency_cone_reports_both_directions_and_tests() {
    let (_r, _d, idx) = built();
    let c = idx.dependency_cone("src/user.ts");
    assert_eq!(c.imports, ["src/auth.ts"]);
    assert_eq!(c.imported_by, ["src/api.ts", "src/user.test.ts"]);
    assert_eq!(c.tests, ["src/user.test.ts"]);
    // transitive: auth.ts is upstream-reachable from api.ts through user.ts
    assert!(idx.dependency_cone("src/auth.ts").transitive_upstream.contains(&"src/api.ts".to_string()));
    // python relative import
    assert_eq!(idx.dependency_cone("pkg/mod.py").imports, ["pkg/util.py"]);
}

#[test]
fn repo_map_is_personalised_and_budgeted() {
    let (_r, _d, idx) = built();
    let focused_py = idx.repo_map(&["pkg/mod.py".to_string()], 2000);
    assert!(focused_py.starts_with("pkg/mod.py:"), "{focused_py}");
    let focused_ts = idx.repo_map(&["src/api.ts".to_string()], 2000);
    assert!(focused_ts.starts_with("src/api.ts:"));
    assert!(focused_ts.contains("getById(id: string)"));
    // a tiny budget keeps the map small
    let tiny = idx.repo_map(&["src/api.ts".to_string()], 30);
    assert!(tiny.len() <= 30 * 4 + 1);
    assert!(tiny.len() < focused_ts.len());
    // un-personalised ranking puts the most-depended-on file (auth.ts) ahead of the leaf test file
    let plain = idx.repo_map(&[], 2000);
    assert!(plain.find("src/auth.ts").unwrap() < plain.find("src/user.test.ts").unwrap_or(usize::MAX));
}

#[test]
fn semantic_search_ranks_by_meaning() {
    let (_r, _d, idx) = built();
    let hits = idx.semantic_search("check the password for a login", 3);
    assert_eq!(hits[0].file, "src/auth.ts");
    let hits = idx.semantic_search("multiply two matrices", 3);
    assert_eq!(hits[0].file, "matrix.ts");
}

#[test]
fn incremental_build_reprocesses_only_changed_files_and_reuses_embeddings() {
    let (repo, _d, idx) = built();
    let root1 = idx.status().merkle_root;
    let s = idx.build(&|_| {}).unwrap();
    assert_eq!((s.reparsed, s.embedded_chunks), (0, 0));
    assert_eq!(idx.status().merkle_root, root1);

    // Touch (same content, new mtime): no reparse.
    std::thread::sleep(Duration::from_millis(20));
    let p = repo.path().join("src/api.ts");
    fs::write(&p, fs::read_to_string(&p).unwrap()).unwrap();
    assert_eq!(idx.build(&|_| {}).unwrap().reparsed, 0);

    // Change one function; its sibling chunk is unchanged so only one chunk is re-embedded.
    std::thread::sleep(Duration::from_millis(20));
    let a = repo.path().join("src/auth.ts");
    let src = fs::read_to_string(&a).unwrap().replace("user !== ''", "user !== '' && user.length < 50");
    fs::write(&a, src).unwrap();
    let s = idx.build(&|_| {}).unwrap();
    assert_eq!(s.reparsed, 1);
    assert_eq!(s.embedded_chunks, 1);
    assert_ne!(idx.status().merkle_root, root1);

    // Removal
    fs::remove_file(repo.path().join("matrix.ts")).unwrap();
    let s = idx.build(&|_| {}).unwrap();
    assert_eq!(s.removed, 1);
    assert!(idx.symbol("matrixMultiply").is_empty());
}

#[test]
fn index_persists_across_restarts() {
    let (repo, dbdir, idx) = built();
    let symbols = idx.status().symbols;
    drop(idx);
    let again = open(repo.path(), &dbdir.path().join("idx.db"));
    assert_eq!(again.status().symbols, symbols); // loaded from SQLite before any build
    let s = again.build(&|_| {}).unwrap();
    assert_eq!((s.reparsed, s.embedded_chunks), (0, 0));
    assert_eq!(again.semantic_search("password login", 1)[0].file, "src/auth.ts");
}

#[test]
fn saved_file_is_searchable_within_500ms() {
    let (repo, _d, idx) = built();
    std::thread::sleep(Duration::from_millis(20));
    fs::write(repo.path().join("src/api.ts"), "export function brandNewHandler() { return 42; }\n").unwrap();
    let t = Instant::now();
    assert!(idx.reindex_file("src/api.ts").unwrap());
    let found = !idx.symbol("brandNewHandler").is_empty() && !idx.grep("brandNewHandler", None, 5).unwrap().is_empty();
    let took = t.elapsed();
    assert!(found);
    assert!(took < Duration::from_millis(500), "took {took:?}");
    assert!(idx.symbol("handle").is_empty()); // old definition gone
}

#[test]
fn watcher_reindexes_saved_files_automatically() {
    let (repo, _d, idx) = built();
    let idx = std::sync::Arc::new(idx);
    let (tx, rx) = std::sync::mpsc::channel();
    let _w = idx.watch(move |files| {
        let _ = tx.send(files);
    })
    .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    fs::write(repo.path().join("src/watched.ts"), "export function watchedFn() {}\n").unwrap();
    let files = rx.recv_timeout(Duration::from_secs(5)).expect("watcher should report the new file");
    assert!(files.contains(&"src/watched.ts".to_string()));
    assert!(!idx.symbol("watchedFn").is_empty());
}

#[test]
fn nested_globs_match_deep_paths() {
    let d = tempfile::tempdir().unwrap();
    write(d.path(), "src/compiler/deep/program.ts", "export function createProgram() {}\n");
    write(d.path(), "other/program.ts", "export function createProgram() {}\n");
    let db = tempfile::tempdir().unwrap();
    let idx = open(d.path(), &db.path().join("i.db"));
    idx.build(&|_| {}).unwrap();
    let files = |g: &str| idx.grep("createProgram", Some(g), 10).unwrap().into_iter().map(|h| h.file).collect::<Vec<_>>();
    assert_eq!(files("src/**/*.ts"), ["src/compiler/deep/program.ts"]);
    assert_eq!(files("**/program.ts").len(), 2);
    assert_eq!(files("src/compiler/**").len(), 1);
}

#[test]
fn bounded_top_k_matches_the_start_of_the_full_ranking() {
    let repo = tempfile::tempdir().unwrap();
    for i in 0..80 {
        write(repo.path(), &format!("src/m{i}.ts"), &format!("export function handler{i}(user: string) {{ return user + '{i}' + checkLogin{}(user); }}\n", i % 7));
    }
    let db = tempfile::tempdir().unwrap();
    let idx = open(repo.path(), &db.path().join("i.db"));
    idx.build(&|_| {}).unwrap();
    let q = "check login for the user handler";
    let full = idx.semantic_search(q, 1000);
    assert!(full.len() > 25, "need enough candidates to make the cut meaningful, got {}", full.len());
    for k in [1usize, 3, 10, 25] {
        let top = idx.semantic_search(q, k);
        assert_eq!(top.len(), k, "k={k}");
        for (a, b) in top.iter().zip(&full) {
            assert!((a.score - b.score).abs() < 1e-6, "k={k}: {} vs {}", a.score, b.score);
        }
    }
}
