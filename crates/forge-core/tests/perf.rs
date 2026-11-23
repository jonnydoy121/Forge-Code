//! Performance check against a large repo. Ignored by default:
//!   FORGE_PERF_REPO=<path> cargo test --release -p forge-core --test perf -- --ignored --nocapture
use forge_core::index::Index;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn count_lines(root: &std::path::Path) -> (usize, usize) {
    let mut b = ignore::WalkBuilder::new(root);
    b.hidden(false).require_git(false).filter_entry(|d| d.file_name() != ".git" && d.file_name() != "node_modules");
    let (mut files, mut lines) = (0, 0);
    for e in b.build().flatten() {
        if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            if let Ok(bytes) = std::fs::read(e.path()) {
                files += 1;
                lines += bytes.iter().filter(|&&c| c == b'\n').count();
            }
        }
    }
    (files, lines)
}

fn time<T>(f: impl FnOnce() -> T) -> (T, Duration) {
    let t = Instant::now();
    let r = f();
    (r, t.elapsed())
}

#[test]
#[ignore]
fn large_repo_meets_targets() {
    let root = std::path::PathBuf::from(std::env::var("FORGE_PERF_REPO").expect("set FORGE_PERF_REPO"));
    let (files, lines) = count_lines(&root);
    println!("repo: {files} files, {lines} lines");

    let db = tempfile::tempdir().unwrap();
    let idx = Arc::new(Index::open(&root, &db.path().join("i.db")).unwrap());

    // First index runs in the background; search must work on the partial index.
    let bg = Arc::clone(&idx);
    let started = Instant::now();
    let handle = std::thread::spawn(move || bg.build(&|_| {}).unwrap());
    let mut first_grep = None;
    while !handle.is_finished() {
        if idx.status().walked_files > 0 && first_grep.is_none() {
            let (hits, d) = time(|| idx.grep("createProgram", None, 50).unwrap());
            if !hits.is_empty() {
                first_grep = Some((hits.len(), d, started.elapsed(), idx.status().indexed_files));
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let stats = handle.join().unwrap();
    let st = idx.status();
    println!("first index: {:?} ({} files indexed, {} symbols, {} chunks)", stats.millis, st.indexed_files, st.symbols, st.chunks);
    println!("first index phases: {}", stats.phases.iter().map(|(n, ms)| format!("{n} {ms} ms")).collect::<Vec<_>>().join(" | "));
    if let Some((n, d, at, indexed)) = first_grep {
        println!("grep during build: {n} hits in {d:?}, issued {at:?} into the build when {indexed} files were parsed");
    }

    let mut worst = Duration::ZERO;
    for pat in ["createProgram", r"\bclass \w+Service\b", "TODO|FIXME", r"function\s+\w+\(.*\)\s*:\s*boolean"] {
        let (hits, d) = time(|| idx.grep(pat, None, 200).unwrap());
        println!("grep {pat:?}: {} hits in {d:?}", hits.len());
        worst = worst.max(d);
    }
    let (sym, d_sym) = time(|| idx.symbol("createProgram"));
    println!("symbol createProgram: {} defs in {d_sym:?}", sym.len());
    let (_, d_sem) = time(|| idx.semantic_search("where do we report type errors", 5));
    println!("semantic_search: {d_sem:?}");
    let (g, d_glob) = time(|| idx.grep("createProgram", Some("**/*.ts"), 50).unwrap());
    println!("grep with glob: {} hits in {d_glob:?}", g.len());
    // The app builds the import graph and Merkle root right after announcing "ready"; do the same before timing the query.
    let (_, d_warm) = time(|| idx.warm());
    println!("graph + merkle root, after ready: {d_warm:?}");
    let (map, d_map) = time(|| idx.repo_map(&[], 2000));
    println!("repo_map: {} bytes in {d_map:?}", map.len());

    // Incremental re-index of a saved file.
    let target_owned = idx
        .grep("createProgram", None, 50)
        .unwrap()
        .into_iter()
        .map(|h| h.file)
        .find(|f| f.ends_with(".ts") || f.ends_with(".go"))
        .expect("a ts/go file mentioning createProgram");
    let target = target_owned.as_str();
    let probe = if target.ends_with(".go") { "
func forgePerfProbe() int { return 1 }
" } else { "
export function forgePerfProbe() { return 1; }
" };
    let path = root.join(target);
    let original = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, format!("{original}{probe}")).unwrap();
    assert!(path.exists(), "perf target file missing: {target}");
    let (changed, d_inc) = time(|| idx.reindex_file(target).unwrap());
    let found = !idx.symbol("forgePerfProbe").is_empty();
    std::fs::write(&path, original).unwrap();
    println!("incremental reindex: changed={changed} searchable={found} in {d_inc:?}");

    // Warm rebuild and restart.
    let (s2, d2) = time(|| idx.build(&|_| {}).unwrap());
    println!("rebuild (1 file changed back): reparsed {} in {d2:?}", s2.reparsed);
    drop(idx);
    let (idx2, d_open) = time(|| Index::open(&root, &db.path().join("i.db")).unwrap());
    let (s3, d3) = time(|| idx2.build(&|_| {}).unwrap());
    println!("reopen from SQLite: {d_open:?}, warm build {d3:?}, reparsed {}", s3.reparsed);
    let (_, d_graph) = time(|| idx2.warm());
    println!("import graph (built after ready): {d_graph:?}");
    println!("warm build phases: {}", s3.phases.iter().map(|(n, ms)| format!("{n} {ms} ms")).collect::<Vec<_>>().join(" | "));

    assert!(changed && found);
    assert!(d_inc < Duration::from_millis(500), "incremental reindex {d_inc:?}");
    // Spec: grep under 200 ms on a 1M-line repo. Scale the budget linearly for bigger repos.
    let budget = Duration::from_millis((200 * lines as u64 / 1_000_000).max(200));
    assert!(worst < budget, "grep {worst:?} exceeds {budget:?} for {lines} lines");
    assert!(d_sym < Duration::from_millis(200), "symbol {d_sym:?}");
}
