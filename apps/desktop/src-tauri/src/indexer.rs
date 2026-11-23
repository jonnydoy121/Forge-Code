use forge_core::index::embed::{Embedder, HashEmbedder};
use forge_core::index::embed_http::HttpEmbedder;
use forge_core::index::{ChunkHit, Cone, GrepHit, Index, RefHit, Status, SymbolHit};
use notify::RecommendedWatcher;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct IndexState {
    idx: Mutex<Option<Arc<Index>>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

fn get(state: &State<IndexState>) -> Result<Arc<Index>, String> {
    state.idx.lock().unwrap().clone().ok_or_else(|| "no workspace indexed yet".to_string())
}

/// Open (or create) the workspace index and build it in the background. Editing and search stay usable meanwhile.
#[tauri::command]
pub fn index_start(app: AppHandle, state: State<IndexState>, root: String, embed_model: Option<String>, embed_url: Option<String>) -> Result<String, String> {
    *state.watcher.lock().unwrap() = None;
    let root_path = Path::new(&root);
    let db = root_path.join(".forge").join("index").join("index.db");
    // Neural embeddings from a local Ollama-compatible server when configured and reachable; otherwise the built-in lexical embedder.
    let (embedder, which): (Box<dyn Embedder>, String) = match embed_model.filter(|m| !m.trim().is_empty()) {
        Some(model) => match HttpEmbedder::connect(embed_url.as_deref().unwrap_or("http://127.0.0.1:11434"), model.trim()) {
            Ok(e) => (Box::new(e), format!("neural ({})", model.trim())),
            Err(err) => (Box::new(HashEmbedder), format!("built-in (neural embeddings unavailable: {err})")),
        },
        None => (Box::new(HashEmbedder), "built-in".to_string()),
    };
    let idx = Arc::new(Index::open_with(root_path, &db, embedder)?);
    *state.idx.lock().unwrap() = Some(Arc::clone(&idx));
    let bg = Arc::clone(&idx);
    let app2 = app.clone();
    std::thread::spawn(move || {
        let res = bg.build(&|p| {
            let _ = app2.emit("index-progress", p);
        });
        let _ = app2.emit("index-built", res.clone().map_err(|e| e.clone()));
        bg.warm(); // after "ready": the first repo map is then instant, and it never delayed the ready signal
    });
    let app3 = app.clone();
    let w = idx.watch(move |files| {
        let _ = app3.emit("index-updated", files);
    })?;
    *state.watcher.lock().unwrap() = Some(w);
    Ok(which)
}

#[tauri::command]
pub fn index_status(state: State<IndexState>) -> Result<Status, String> {
    Ok(get(&state)?.status())
}

#[tauri::command]
pub fn index_find_files(state: State<IndexState>, pattern: String, max: Option<usize>) -> Result<Vec<String>, String> {
    get(&state)?.find_files(&pattern, max.unwrap_or(200))
}

#[tauri::command]
pub fn index_grep(state: State<IndexState>, pattern: String, glob: Option<String>, max: Option<usize>) -> Result<Vec<GrepHit>, String> {
    get(&state)?.grep(&pattern, glob.as_deref(), max.unwrap_or(200))
}

#[tauri::command]
pub fn index_symbol(state: State<IndexState>, name: String) -> Result<Vec<SymbolHit>, String> {
    Ok(get(&state)?.symbol(&name))
}

#[tauri::command]
pub fn index_references(state: State<IndexState>, symbol: String) -> Result<Vec<RefHit>, String> {
    get(&state)?.references(&symbol)
}

#[tauri::command]
pub fn index_repo_map(state: State<IndexState>, focus_files: Vec<String>, token_budget: usize) -> Result<String, String> {
    Ok(get(&state)?.repo_map(&focus_files, token_budget))
}

#[tauri::command]
pub fn index_semantic(state: State<IndexState>, query: String, k: usize) -> Result<Vec<ChunkHit>, String> {
    Ok(get(&state)?.semantic_search(&query, k))
}

#[tauri::command]
pub fn index_cone(state: State<IndexState>, path: String) -> Result<Cone, String> {
    Ok(get(&state)?.dependency_cone(&path))
}
