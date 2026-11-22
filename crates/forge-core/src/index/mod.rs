//! Workspace indexer: Merkle change detection, tree-sitter symbols, symbol graph, embeddings, repo map and
//! retrieval APIs. Per-file results persist in SQLite so restarts only re-process changed files.

pub mod cache;
pub mod embed;
pub mod embed_http;
pub mod graph;
pub mod merkle;
pub mod parse;
pub mod watch;

use embed::{cosine, from_bytes, to_bytes, Embedder, HashEmbedder, DIM};
use globset::{Glob, GlobBuilder, GlobMatcher};
use ignore::WalkBuilder;
use parse::{ChunkMeta, Parsed};
use rayon::prelude::*;
use regex::Regex;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::UNIX_EPOCH;

const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next", ".venv", "__pycache__", ".forge"];
const MAX_FILE_BYTES: u64 = 1_000_000;

pub fn is_secret_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    if n.ends_with(".env.example") || n.ends_with(".env.sample") {
        return false;
    }
    n == ".env" || n.starts_with(".env.") || n.ends_with(".pem") || n.ends_with(".key") || n.ends_with(".p12") || n.starts_with("id_rsa") || n.starts_with("id_dsa") || n.starts_with("id_ecdsa") || n.starts_with("id_ed25519") || n.starts_with("credentials") || n == ".npmrc" || n == ".netrc"
}

#[derive(Clone)]
pub(crate) struct FileEntry {
    pub hash: String,
    pub size: u64,
    pub mtime: u64,
    pub parsed: Parsed,
    pub vecs: Vec<Vec<f32>>,
}

#[derive(Default)]
pub(crate) struct State {
    pub files: HashMap<String, FileEntry>,
    /// Files discovered by the walk, searchable by grep even before parsing finishes.
    pub all_files: Vec<String>,
    pub defs: HashMap<String, Vec<(String, usize)>>,
    pub rev_refs: HashMap<String, HashSet<String>>,
    pub graph: Option<graph::Graph>,
    pub merkle: Option<merkle::Node>,
    pub building: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub phase: &'static str,
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct BuildStats {
    pub total_files: usize,
    pub reparsed: usize,
    pub removed: usize,
    pub embedded_chunks: usize,
    pub millis: u128,
    /// where the time went, in order: (phase, milliseconds)
    pub phases: Vec<(&'static str, u128)>,
}

/// Stopwatch that records how long each phase of a build took.
struct Phases {
    start: std::time::Instant,
    last: u128,
    out: Vec<(&'static str, u128)>,
}

impl Phases {
    fn new() -> Self {
        Phases { start: std::time::Instant::now(), last: 0, out: Vec::new() }
    }
    fn mark(&mut self, name: &'static str) {
        let now = self.start.elapsed().as_millis();
        self.out.push((name, now - self.last));
        self.last = now;
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GrepHit {
    pub file: String,
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SymbolHit {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: u32,
    pub end_line: u32,
    pub signature: String,
    pub doc: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefHit {
    pub file: String,
    pub line: u32,
    pub text: String,
    pub is_definition: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChunkHit {
    pub file: String,
    pub start: u32,
    pub end: u32,
    pub score: f32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Cone {
    pub imports: Vec<String>,
    pub imported_by: Vec<String>,
    pub transitive_upstream: Vec<String>,
    pub transitive_downstream: Vec<String>,
    pub tests: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub indexed_files: usize,
    pub walked_files: usize,
    pub symbols: usize,
    pub chunks: usize,
    pub embed_calls: usize,
    pub building: bool,
    pub merkle_root: String,
}

pub struct Index {
    root: PathBuf,
    db: Mutex<Connection>,
    pub(crate) state: RwLock<State>,
    embedder: Box<dyn Embedder>,
    embed_calls: AtomicUsize,
    cache: cache::ContentCache,
}

type Err = String;
fn e<T: ToString>(x: T) -> Err {
    x.to_string()
}

fn mtime_ms(m: &std::fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Walked {
    rel: String,
    size: u64,
    mtime: u64,
}

impl Index {
    pub fn open(root: &Path, db_path: &Path) -> Result<Index, Err> {
        Self::open_with(root, db_path, Box::new(HashEmbedder))
    }

    pub fn open_with(root: &Path, db_path: &Path, embedder: Box<dyn Embedder>) -> Result<Index, Err> {
        if let Some(dir) = db_path.parent() {
            std::fs::create_dir_all(dir).map_err(e)?;
        }
        let conn = Connection::open(db_path).map_err(e)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER, mtime INTEGER, data TEXT NOT NULL, vecs BLOB NOT NULL);",
        )
        .map_err(e)?;
        let idx = Index { root: root.to_path_buf(), db: Mutex::new(conn), state: RwLock::new(State::default()), embedder, embed_calls: AtomicUsize::new(0), cache: cache::ContentCache::new(768 * 1024 * 1024) };
        idx.load_from_db()?;
        Ok(idx)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn load_from_db(&self) -> Result<(), Err> {
        let db = self.db.lock().unwrap();
        let dim_key: Option<String> = db.query_row("SELECT value FROM meta WHERE key='dim'", [], |r| r.get(0)).ok();
        if dim_key.as_deref() != Some(&self.embedder.dim().to_string()) {
            db.execute("DELETE FROM files", []).map_err(e)?;
            db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('dim', ?1)", params![self.embedder.dim().to_string()]).map_err(e)?;
            return Ok(());
        }
        let dim = self.embedder.dim();
        let total: usize = db.query_row("SELECT COUNT(*) FROM files", [], |r| r.get::<_, i64>(0)).map(|n| n as usize).unwrap_or(0);
        let mut stmt = db.prepare("SELECT path,hash,size,mtime,data,vecs FROM files").map_err(e)?;
        let mut rows = stmt.query([]).map_err(e)?;
        let mut st = self.state.write().unwrap();
        // Size the maps once instead of growing them row by row.
        st.files.reserve(total);
        st.defs.reserve(total * 4);
        st.rev_refs.reserve(total);

        type Raw = (String, String, i64, i64, String, Vec<u8>);
        let decode = |(path, hash, size, mtime, data, vecs): Raw| -> Option<(String, FileEntry)> {
            let parsed = serde_json::from_str::<Parsed>(&data).ok()?;
            let flat = from_bytes(&vecs);
            if flat.len() != parsed.chunks.len() * dim {
                return None; // inconsistent row: will be re-indexed
            }
            let vecs = flat.chunks(dim.max(1)).map(|c| c.to_vec()).collect();
            Some((path, FileEntry { hash, size: size as u64, mtime: mtime as u64, parsed, vecs }))
        };
        // SQLite hands rows over one after another, but decoding them (JSON, vectors) is independent work: read a chunk,
        // decode it on every core, insert it. Chunking keeps the extra memory small.
        const CHUNK: usize = 4096;
        loop {
            let mut raw: Vec<Raw> = Vec::with_capacity(CHUNK);
            while raw.len() < CHUNK {
                let Some(r) = rows.next().map_err(e)? else { break };
                raw.push((r.get(0).map_err(e)?, r.get(1).map_err(e)?, r.get(2).map_err(e)?, r.get(3).map_err(e)?, r.get(4).map_err(e)?, r.get(5).map_err(e)?));
            }
            if raw.is_empty() {
                break;
            }
            let decoded: Vec<Option<(String, FileEntry)>> = raw.into_par_iter().map(decode).collect();
            for (path, entry) in decoded.into_iter().flatten() {
                Self::apply(&mut st, path, entry);
            }
        }
        Ok(())
    }

    fn walk(&self) -> Vec<Walked> {
        let mut b = WalkBuilder::new(&self.root);
        b.hidden(false).git_ignore(true).git_global(false).git_exclude(true).require_git(false).add_custom_ignore_filename(".forgeignore");
        b.filter_entry(|d| !(d.file_type().map(|t| t.is_dir()).unwrap_or(false) && SKIP_DIRS.contains(&d.file_name().to_string_lossy().as_ref())));
        let mut out = Vec::new();
        for ent in b.build().flatten() {
            if !ent.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let name = ent.file_name().to_string_lossy();
            if is_secret_name(&name) {
                continue;
            }
            let Ok(md) = ent.metadata() else { continue };
            if md.len() > MAX_FILE_BYTES {
                continue;
            }
            let Ok(rel) = ent.path().strip_prefix(&self.root) else { continue };
            out.push(Walked { rel: rel.to_string_lossy().replace('\\', "/"), size: md.len(), mtime: mtime_ms(&md) });
        }
        out
    }

    fn abs(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    /// Read, hash, parse and embed one file, reusing embeddings of unchanged chunks from `prev`.
    fn process(&self, rel: &str, size: u64, mtime: u64, prev: Option<&FileEntry>) -> Option<FileEntry> {
        let bytes = std::fs::read(self.abs(rel)).ok()?;
        if bytes[..bytes.len().min(8192)].contains(&0) {
            return None; // binary
        }
        let content = String::from_utf8(bytes).ok()?;
        self.cache.put(rel, &content);
        let hash = blake3::hash(content.as_bytes()).to_hex().to_string();
        let parsed = parse::parse(rel, &content);
        let cache: HashMap<&str, &Vec<f32>> = prev.map(|p| p.parsed.chunks.iter().zip(&p.vecs).map(|(c, v)| (c.hash.as_str(), v)).collect()).unwrap_or_default();
        let lines: Vec<&str> = content.split('\n').collect();
        // Reuse embeddings of unchanged chunks; embed all the new ones together (one request for a network embedder).
        let mut vecs: Vec<Option<Vec<f32>>> = parsed.chunks.iter().map(|c: &ChunkMeta| cache.get(c.hash.as_str()).map(|v| (*v).clone())).collect();
        let todo: Vec<usize> = (0..vecs.len()).filter(|&i| vecs[i].is_none()).collect();
        if !todo.is_empty() {
            self.embed_calls.fetch_add(todo.len(), Ordering::Relaxed);
            let texts: Vec<String> = todo
                .iter()
                .map(|&i| {
                    let c: &ChunkMeta = &parsed.chunks[i];
                    let body = lines[(c.start as usize - 1)..(c.end as usize).min(lines.len())].join("\n");
                    format!("{rel}\n{body}")
                })
                .collect();
            for (slot, v) in todo.iter().zip(self.embedder.embed_batch(&texts)) {
                vecs[*slot] = Some(v);
            }
        }
        let vecs: Vec<Vec<f32>> = vecs.into_iter().map(|v| v.unwrap_or_default()).collect();
        Some(FileEntry { hash, size, mtime, parsed, vecs })
    }

    fn remove_contrib(st: &mut State, path: &str) {
        if let Some(old) = st.files.get(path) {
            for s in &old.parsed.symbols {
                if let Some(v) = st.defs.get_mut(&s.name) {
                    v.retain(|(f, _)| f != path);
                    if v.is_empty() {
                        st.defs.remove(&s.name);
                    }
                }
            }
            for r in &old.parsed.refs {
                if let Some(set) = st.rev_refs.get_mut(r) {
                    set.remove(path);
                    if set.is_empty() {
                        st.rev_refs.remove(r);
                    }
                }
            }
        }
    }

    fn apply(st: &mut State, path: String, entry: FileEntry) {
        Self::remove_contrib(st, &path);
        for (i, s) in entry.parsed.symbols.iter().enumerate() {
            st.defs.entry(s.name.clone()).or_default().push((path.clone(), i));
        }
        for r in &entry.parsed.refs {
            st.rev_refs.entry(r.clone()).or_default().insert(path.clone());
        }
        st.files.insert(path, entry);
        st.graph = None;
    }

    fn persist(&self, rows: &[(String, FileEntry)], removed: &[String]) -> Result<(), Err> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction().map_err(e)?;
        {
            let mut up = tx.prepare_cached("INSERT OR REPLACE INTO files(path,hash,size,mtime,data,vecs) VALUES(?1,?2,?3,?4,?5,?6)").map_err(e)?;
            for (p, f) in rows {
                let flat: Vec<f32> = f.vecs.iter().flatten().copied().collect();
                up.execute(params![p, f.hash, f.size as i64, f.mtime as i64, serde_json::to_string(&f.parsed).map_err(e)?, to_bytes(&flat)]).map_err(e)?;
            }
            let mut del = tx.prepare_cached("DELETE FROM files WHERE path=?1").map_err(e)?;
            for p in removed {
                del.execute(params![p]).map_err(e)?;
            }
        }
        tx.commit().map_err(e)
    }

    fn current_merkle(st: &State) -> merkle::Node {
        let mut pairs: Vec<(String, String)> = st.files.iter().map(|(p, f)| (p.clone(), f.hash.clone())).collect();
        pairs.sort();
        merkle::build(&pairs)
    }

    /// Full or incremental build. Safe to call repeatedly; only changed branches are re-processed.
    pub fn build(&self, progress: &(dyn Fn(Progress) + Sync)) -> Result<BuildStats, Err> {
        let started = std::time::Instant::now();
        self.state.write().unwrap().building = true;
        let result = self.build_inner(progress);
        self.state.write().unwrap().building = false;
        result.map(|mut s| {
            s.millis = started.elapsed().as_millis();
            s
        })
    }

    fn build_inner(&self, progress: &(dyn Fn(Progress) + Sync)) -> Result<BuildStats, Err> {
        let mut phases = Phases::new();
        progress(Progress { phase: "walk", done: 0, total: 0 });
        let walked = self.walk();
        phases.mark("walk");
        {
            let mut st = self.state.write().unwrap();
            st.all_files = walked.iter().map(|w| w.rel.clone()).collect();
        }
        let total = walked.len();
        progress(Progress { phase: "walk", done: total, total });

        // Phase 1: hash files whose (size, mtime) changed since last time.
        let hashed = AtomicUsize::new(0);
        let fresh: Vec<(String, Option<(String, u64, u64)>)> = {
            let st = self.state.read().unwrap();
            let needs: Vec<&Walked> = walked.iter().filter(|w| st.files.get(&w.rel).map(|f| f.size != w.size || f.mtime != w.mtime).unwrap_or(true)).collect();
            let n = needs.len();
            needs
                .par_iter()
                .map(|w| {
                    let r = std::fs::read(self.abs(&w.rel)).ok().filter(|b| !b[..b.len().min(8192)].contains(&0)).map(|b| (blake3::hash(&b).to_hex().to_string(), w.size, w.mtime));
                    let d = hashed.fetch_add(1, Ordering::Relaxed) + 1;
                    if d % 2000 == 0 {
                        progress(Progress { phase: "hash", done: d, total: n });
                    }
                    (w.rel.clone(), r)
                })
                .collect()
        };

        phases.mark("hash changed files");
        // Nothing needed hashing and the walk found exactly the files we already know: the tree cannot have changed, so
        // do not rebuild and diff an identical one (the common case when the app is reopened on an unchanged repo).
        let unchanged = fresh.is_empty() && {
            let st = self.state.read().unwrap();
            st.files.len() == total && walked.iter().all(|w| st.files.contains_key(&w.rel))
        };
        let mut meta_only: Vec<(String, u64, u64)> = Vec::new();
        let (new_merkle, d) = if unchanged {
            (None, merkle::Diff::default())
        } else {
            let old_merkle = Self::current_merkle(&self.state.read().unwrap());
            // Build the new Merkle tree from known + fresh hashes, then diff against the old one.
            let mut new_pairs: Vec<(String, String)> = Vec::with_capacity(total);
            {
                let st = self.state.read().unwrap();
                let fresh_map: HashMap<&str, &Option<(String, u64, u64)>> = fresh.iter().map(|(p, r)| (p.as_str(), r)).collect();
                for w in &walked {
                    match fresh_map.get(w.rel.as_str()) {
                        Some(Some((h, _, _))) => {
                            if st.files.get(&w.rel).map(|f| &f.hash == h).unwrap_or(false) {
                                meta_only.push((w.rel.clone(), w.size, w.mtime));
                            }
                            new_pairs.push((w.rel.clone(), h.clone()));
                        }
                        Some(None) => {} // unreadable or binary: not indexed
                        None => {
                            if let Some(f) = st.files.get(&w.rel) {
                                new_pairs.push((w.rel.clone(), f.hash.clone()));
                            }
                        }
                    }
                }
            }
            new_pairs.sort();
            let new_merkle = merkle::build(&new_pairs);
            let d = merkle::diff(&old_merkle, &new_merkle);
            (Some(new_merkle), d)
        };
        phases.mark("new merkle tree + diff");

        // Phase 2: parse + embed only the changed files, in batches.
        let changed = d.added_or_changed;
        let meta: HashMap<&str, (u64, u64)> = walked.iter().map(|w| (w.rel.as_str(), (w.size, w.mtime))).collect();
        let embed_before = self.embed_calls.load(Ordering::Relaxed);
        let done = AtomicUsize::new(0);
        for batch in changed.chunks(512) {
            let results: Vec<(String, FileEntry)> = {
                let st = self.state.read().unwrap();
                batch
                    .par_iter()
                    .filter_map(|rel| {
                        let (size, mtime) = *meta.get(rel.as_str())?;
                        let r = self.process(rel, size, mtime, st.files.get(rel))?;
                        let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                        if n % 500 == 0 {
                            progress(Progress { phase: "parse", done: n, total: changed.len() });
                        }
                        Some((rel.clone(), r))
                    })
                    .collect()
            };
            self.persist(&results, &[])?;
            let mut st = self.state.write().unwrap();
            for (p, f) in results {
                Self::apply(&mut st, p, f);
            }
        }
        // Metadata-only updates (touched but identical) and removals.
        if !meta_only.is_empty() {
            let mut rows = Vec::new();
            let mut st = self.state.write().unwrap();
            for (p, size, mtime) in meta_only {
                if let Some(f) = st.files.get_mut(&p) {
                    f.size = size;
                    f.mtime = mtime;
                    rows.push((p, f.clone()));
                }
            }
            drop(st);
            self.persist(&rows, &[])?;
        }
        let gone: Vec<String> = d.removed.into_iter().filter(|p| !changed.contains(p)).collect();
        if !gone.is_empty() {
            self.persist(&[], &gone)?;
            let mut st = self.state.write().unwrap();
            for p in &gone {
                self.cache.remove(p);
                Self::remove_contrib(&mut st, p);
                st.files.remove(p);
            }
            st.graph = None;
        }
        phases.mark("parse, embed, persist");
        {
            let mut st = self.state.write().unwrap();
            if new_merkle.is_some() {
                st.merkle = new_merkle; // unchanged: the root already held (if any) is still right
            }
        }
        progress(Progress { phase: "done", done: total, total });
        Ok(BuildStats { total_files: total, reparsed: changed.len(), removed: gone.len(), embedded_chunks: self.embed_calls.load(Ordering::Relaxed) - embed_before, millis: 0, phases: phases.out })
    }

    /// Incremental update after a save. Returns true if content changed.
    pub fn reindex_file(&self, rel: &str) -> Result<bool, Err> {
        let rel = rel.replace('\\', "/");
        if is_secret_name(rel.rsplit('/').next().unwrap_or("")) || rel.split('/').any(|c| SKIP_DIRS.contains(&c)) {
            return Ok(false);
        }
        let md = match std::fs::metadata(self.abs(&rel)) {
            Ok(m) if m.is_file() && m.len() <= MAX_FILE_BYTES => m,
            _ => return self.remove_file(&rel).map(|_| true),
        };
        let prev = self.state.read().unwrap().files.get(&rel).cloned();
        let Some(entry) = self.process(&rel, md.len(), mtime_ms(&md), prev.as_ref()) else {
            return self.remove_file(&rel).map(|_| true);
        };
        if prev.as_ref().map(|p| p.hash == entry.hash).unwrap_or(false) {
            return Ok(false);
        }
        self.persist(&[(rel.clone(), entry.clone())], &[])?;
        let mut st = self.state.write().unwrap();
        if !st.all_files.contains(&rel) {
            st.all_files.push(rel.clone());
        }
        Self::apply(&mut st, rel, entry);
        Ok(true)
    }

    pub fn remove_file(&self, rel: &str) -> Result<(), Err> {
        self.persist(&[], &[rel.to_string()])?;
        let mut st = self.state.write().unwrap();
        Self::remove_contrib(&mut st, rel);
        self.cache.remove(rel);
        st.files.remove(rel);
        st.all_files.retain(|f| f != rel);
        st.graph = None;
        Ok(())
    }

    // ---------- retrieval ----------

    /// File content for searching: from memory when cached, otherwise read once from disk and cached.
    fn content(&self, rel: &str) -> Option<std::sync::Arc<str>> {
        if let Some(c) = self.cache.get(rel) {
            return Some(c);
        }
        let text = std::fs::read_to_string(self.abs(rel)).ok()?;
        Some(self.cache.put(rel, &text))
    }

    fn glob_matcher(glob: &str) -> Result<GlobMatcher, Err> {
        let g = if glob.contains('/') { glob.to_string() } else { format!("**/{glob}") };
        Ok(GlobBuilder::new(&g).literal_separator(true).build().map_err(e)?.compile_matcher())
    }

    pub fn grep(&self, pattern: &str, glob: Option<&str>, max: usize) -> Result<Vec<GrepHit>, Err> {
        let re = Regex::new(pattern).map_err(e)?;
        // Whole-file prefilter: (?m) keeps ^/$ line-anchored, so any per-line match implies a whole-file match.
        // Most files contain no match, and the regex engine scans a whole buffer far faster than line by line.
        let prefilter = Regex::new(&format!("(?m){pattern}")).map_err(e)?;
        let matcher = glob.map(Self::glob_matcher).transpose()?;
        let files: Vec<String> = self.state.read().unwrap().all_files.iter().filter(|f| matcher.as_ref().map(|m| m.is_match(f.as_str())).unwrap_or(true)).cloned().collect();
        let count = AtomicUsize::new(0);
        let mut hits: Vec<GrepHit> = files
            .par_iter()
            .flat_map_iter(|rel| {
                let mut out = Vec::new();
                if count.load(Ordering::Relaxed) >= max {
                    return out.into_iter();
                }
                if let Some(text) = self.content(rel) {
                    let text: &str = &text;
                    if !prefilter.is_match(text) {
                        return out.into_iter();
                    }
                    for (i, line) in text.lines().enumerate() {
                        if re.is_match(line) {
                            out.push(GrepHit { file: rel.clone(), line: i as u32 + 1, text: line.trim().chars().take(200).collect() });
                            if count.fetch_add(1, Ordering::Relaxed) >= max {
                                break;
                            }
                        }
                    }
                }
                out.into_iter()
            })
            .collect();
        hits.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
        hits.truncate(max);
        Ok(hits)
    }

    fn doc_above(&self, rel: &str, line: u32) -> String {
        let Ok(text) = std::fs::read_to_string(self.abs(rel)) else { return String::new() };
        let lines: Vec<&str> = text.lines().collect();
        let mut doc = Vec::new();
        let mut i = line as usize - 1;
        while i > 0 {
            let l = lines[i - 1].trim();
            if l.starts_with("//") || l.starts_with('#') || l.starts_with('*') || l.starts_with("/*") || l.ends_with("*/") || l.starts_with("///") {
                doc.push(l.trim_start_matches(['/', '*', '#', ' ']).trim_end_matches("*/").trim().to_string());
                i -= 1;
            } else {
                break;
            }
        }
        doc.reverse();
        doc.join("\n")
    }

    pub fn symbol(&self, name: &str) -> Vec<SymbolHit> {
        let st = self.state.read().unwrap();
        let mut hits: Vec<SymbolHit> = st
            .defs
            .get(name)
            .map(|v| {
                v.iter()
                    .filter_map(|(f, i)| {
                        let s = st.files.get(f)?.parsed.symbols.get(*i)?;
                        Some(SymbolHit { name: s.name.clone(), kind: s.kind.clone(), file: f.clone(), line: s.line, end_line: s.end_line, signature: s.signature.clone(), doc: String::new() })
                    })
                    .collect()
            })
            .unwrap_or_default();
        drop(st);
        hits.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
        for h in hits.iter_mut() {
            h.doc = self.doc_above(&h.file, h.line);
        }
        hits
    }

    pub fn references(&self, name: &str) -> Result<Vec<RefHit>, Err> {
        let re = Regex::new(&format!(r"\b{}\b", regex::escape(name))).map_err(e)?;
        let (candidates, defs): (Vec<String>, HashSet<(String, u32)>) = {
            let st = self.state.read().unwrap();
            let mut c: HashSet<String> = st.rev_refs.get(name).cloned().unwrap_or_default();
            let mut d = HashSet::new();
            for (f, i) in st.defs.get(name).into_iter().flatten() {
                c.insert(f.clone());
                if let Some(s) = st.files.get(f).and_then(|x| x.parsed.symbols.get(*i)) {
                    d.insert((f.clone(), s.line));
                }
            }
            (c.into_iter().collect(), d)
        };
        let mut hits: Vec<RefHit> = candidates
            .par_iter()
            .flat_map_iter(|rel| {
                let mut out = Vec::new();
                if let Some(text) = self.content(rel) {
                    for (i, line) in text.lines().enumerate() {
                        if re.is_match(line) {
                            out.push(RefHit { file: rel.clone(), line: i as u32 + 1, text: line.trim().chars().take(200).collect(), is_definition: defs.contains(&(rel.clone(), i as u32 + 1)) });
                        }
                    }
                }
                out.into_iter()
            })
            .collect();
        hits.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
        Ok(hits)
    }

    /// Build the import graph now (otherwise the first `repo_map` or dependency query builds it on demand). The app calls
    /// this after announcing that indexing finished, so the graph never delays "ready".
    pub fn warm(&self) {
        self.ensure_graph();
        self.ensure_merkle();
    }

    /// The Merkle root of the indexed files, computed the first time it is needed and kept until the next build.
    fn ensure_merkle(&self) {
        if self.state.read().unwrap().merkle.is_some() {
            return;
        }
        let m = Self::current_merkle(&self.state.read().unwrap());
        self.state.write().unwrap().merkle.get_or_insert(m);
    }

    fn ensure_graph(&self) {
        if self.state.read().unwrap().graph.is_some() {
            return;
        }
        let g = graph::build(&self.state.read().unwrap());
        self.state.write().unwrap().graph = Some(g);
    }

    pub fn dependency_cone(&self, rel: &str) -> Cone {
        self.ensure_graph();
        let st = self.state.read().unwrap();
        st.graph.as_ref().map(|g| g.cone(rel)).unwrap_or_default()
    }

    pub fn repo_map(&self, focus: &[String], token_budget: usize) -> String {
        self.ensure_graph();
        let st = self.state.read().unwrap();
        graph::repo_map(&st, focus, token_budget)
    }

    pub fn semantic_search(&self, query: &str, k: usize) -> Vec<ChunkHit> {
        let q = self.embedder.embed(query);
        let qr = &q;
        let st = self.state.read().unwrap();
        // Each thread keeps only its best k (a bounded set), then the sets are merged: no list of every chunk's score
        // is ever built or sorted.
        type Cand<'a> = (f32, &'a String, &'a ChunkMeta);
        let by_rank = |a: &Cand, b: &Cand| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(b.1));
        let keep = k.max(1);
        let mut scored: Vec<Cand> = st
            .files
            .par_iter()
            .fold(
                || (Vec::<Cand>::with_capacity(keep), f32::MIN),
                |(mut top, mut floor), (path, f)| {
                    for (c, v) in f.parsed.chunks.iter().zip(&f.vecs) {
                        let s = cosine(qr, v);
                        if s <= 0.0 || (top.len() >= keep && s <= floor) {
                            continue;
                        }
                        if top.len() < keep {
                            top.push((s, path, c));
                            if top.len() == keep {
                                floor = top.iter().map(|t| t.0).fold(f32::MAX, f32::min);
                            }
                        } else if let Some(worst) = top.iter().enumerate().min_by(|a, b| a.1 .0.partial_cmp(&b.1 .0).unwrap_or(std::cmp::Ordering::Equal)).map(|(i, _)| i) {
                            top[worst] = (s, path, c);
                            floor = top.iter().map(|t| t.0).fold(f32::MAX, f32::min);
                        }
                    }
                    (top, floor)
                },
            )
            .map(|(top, _)| top)
            .reduce(Vec::new, |mut a, b| {
                a.extend(b);
                a.sort_by(by_rank);
                a.truncate(keep);
                a
            });
        scored.sort_by(by_rank);
        scored.truncate(k);
        let hits: Vec<(f32, String, u32, u32)> = scored.into_iter().filter(|s| s.0 > 0.0).map(|(s, p, c)| (s, p.clone(), c.start, c.end)).collect();
        drop(st);
        hits.into_iter()
            .map(|(score, file, start, end)| {
                let text = std::fs::read_to_string(self.abs(&file)).map(|t| t.lines().skip(start as usize - 1).take(((end - start + 1) as usize).min(40)).collect::<Vec<_>>().join("\n")).unwrap_or_default();
                ChunkHit { file, start, end, score, text }
            })
            .collect()
    }

    pub fn status(&self) -> Status {
        self.ensure_merkle();
        let st = self.state.read().unwrap();
        Status {
            indexed_files: st.files.len(),
            walked_files: st.all_files.len(),
            symbols: st.files.values().map(|f| f.parsed.symbols.len()).sum(),
            chunks: st.files.values().map(|f| f.parsed.chunks.len()).sum(),
            embed_calls: self.embed_calls.load(Ordering::Relaxed),
            building: st.building,
            merkle_root: st.merkle.as_ref().map(|m| m.hash().to_string()).unwrap_or_default(),
        }
    }

    pub fn embed_calls(&self) -> usize {
        self.embed_calls.load(Ordering::Relaxed)
    }
}

#[allow(dead_code)]
fn _assert_dim() {
    let _ = DIM;
    let _: Option<Glob> = None;
}
