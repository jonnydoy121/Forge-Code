use forge_core::index::{BuildStats, ChunkHit, Cone, GrepHit, Index, RefHit, Status, SymbolHit};
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
pub fn index_start(app: AppHandle, state: State<IndexState>, root: String) -> Result<(), String> {
    *state.watcher.lock().unwrap() = None;
    let root_path = Path::new(&root);
    let db = root_path.join(".forge").join("index").join("index.db");
    let idx = Arc::new(Index::open(root_path, &db)?);
    *state.idx.lock().unwrap() = Some(Arc::clone(&idx));
    let bg = Arc::clone(&idx);
    let app2 = app.clone();
    std::thread::spawn(move || {
        let res = bg.build(&|p| {
            let _ = app2.emit("index-progress", p);
        });
        let _ = app2.emit("index-built", res.as_ref().map(|s: &BuildStats| s.clone()).map_err(|e| e.clone()));
    });
    let app3 = app.clone();
    let w = idx.watch(move |files| {
        let _ = app3.emit("index-updated", files);
    })?;
    *state.watcher.lock().unwrap() = Some(w);
    Ok(())
}

#[tauri::command]
pub fn index_status(state: State<IndexState>) -> Result<Status, String> {
    Ok(get(&state)?.status())
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
