//! File watcher: debounces filesystem events and incrementally re-indexes the touched files.

use super::Index;
use notify::{recommended_watcher, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

const SKIP: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next", ".venv", "__pycache__", ".forge"];

impl Index {
    /// Watch the workspace. `on_update` receives the relative paths that were re-indexed (changed or removed).
    /// Keep the returned watcher alive; dropping it stops watching.
    pub fn watch(self: &Arc<Self>, on_update: impl Fn(Vec<String>) + Send + 'static) -> Result<RecommendedWatcher, String> {
        let (tx, rx) = channel::<std::path::PathBuf>();
        let mut w = recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                for p in ev.paths {
                    let _ = tx.send(p);
                }
            }
        })
        .map_err(|e| e.to_string())?;
        w.watch(self.root(), RecursiveMode::Recursive).map_err(|e| e.to_string())?;

        let idx = Arc::clone(self);
        std::thread::spawn(move || {
            let mut pending: HashSet<String> = HashSet::new();
            loop {
                match rx.recv_timeout(Duration::from_millis(150)) {
                    Ok(p) => {
                        if let Ok(rel) = p.strip_prefix(idx.root()) {
                            let rel = rel.to_string_lossy().replace('\\', "/");
                            if !rel.is_empty() && !rel.split('/').any(|c| SKIP.contains(&c)) && !p.is_dir() {
                                pending.insert(rel);
                            }
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if pending.is_empty() {
                            continue;
                        }
                        let mut changed: Vec<String> = Vec::new();
                        for rel in pending.drain() {
                            if matches!(idx.reindex_file(&rel), Ok(true)) {
                                changed.push(rel);
                            }
                        }
                        if !changed.is_empty() {
                            changed.sort();
                            on_update(changed);
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        });
        Ok(w)
    }
}
