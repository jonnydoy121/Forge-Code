// Semantic search through a (mock) local Ollama-compatible embedding server: finds code the lexical embedder cannot.
use forge_core::index::embed_http::HttpEmbedder;
use forge_core::index::Index;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Mock /api/embed: a 3-concept "model", one vector per input.
/// Credentials-ish text -> axis 0, graphics/maths text -> axis 1, else axis 2. Counts requests.
fn mock_server() -> (String, Arc<AtomicUsize>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let requests = Arc::new(AtomicUsize::new(0));
    let counter = requests.clone();
    std::thread::spawn(move || {
        for s in l.incoming() {
            let mut s = s.unwrap();
            let counter = counter.clone();
            std::thread::spawn(move || {
                let mut data = Vec::new();
                let mut buf = [0u8; 8192];
                loop {
                    let n = s.read(&mut buf).unwrap_or(0);
                    data.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&data).to_string();
                    let done = text.split_once("\r\n\r\n").map_or(false, |(h, b)| {
                        let want = h.to_lowercase().split("content-length:").nth(1).and_then(|r| r.trim().split(|c: char| !c.is_ascii_digit()).next().and_then(|d| d.parse::<usize>().ok())).unwrap_or(0);
                        b.len() >= want
                    });
                    if n == 0 || done {
                        break;
                    }
                }
                counter.fetch_add(1, Ordering::SeqCst);
                let text = String::from_utf8_lossy(&data).to_string();
                let body: serde_json::Value = serde_json::from_str(text.split_once("\r\n\r\n").map_or("{}", |(_, b)| b)).unwrap_or_default();
                let vectors: Vec<serde_json::Value> = body["input"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|t| {
                                let t = t.as_str().unwrap_or("").to_lowercase();
                                if ["password", "credential", "sign-in", "login"].iter().any(|w| t.contains(w)) {
                                    serde_json::json!([1.0, 0.0, 0.0])
                                } else if ["matrix", "vector"].iter().any(|w| t.contains(w)) {
                                    serde_json::json!([0.0, 1.0, 0.0])
                                } else {
                                    serde_json::json!([0.0, 0.0, 1.0])
                                }
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let out = serde_json::json!({ "embeddings": vectors }).to_string();
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len());
            });
        }
    });
    (format!("http://127.0.0.1:{port}"), requests)
}

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    fs::create_dir_all(d.path().join("src")).unwrap();
    fs::write(d.path().join("src/auth.ts"), "export function validatePassword(p: string) { return p.length > 8; }\n").unwrap();
    fs::write(d.path().join("src/gfx.ts"), "export function matrixMultiply(a: number[][], b: number[][]) { return a; }\n").unwrap();
    fs::write(d.path().join("src/misc.ts"), "export const answer = 42;\n").unwrap();
    d
}

#[test]
fn neural_embeddings_find_code_by_meaning_and_the_lexical_fallback_cannot() {
    let r = repo();
    let q = "where do we check user credentials at sign-in"; // shares no word with the code

    let lexical_db = tempfile::tempdir().unwrap();
    let lexical = Index::open(r.path(), &lexical_db.path().join("a.db")).unwrap();
    lexical.build(&|_| {}).unwrap();
    assert!(lexical.semantic_search(q, 1).first().map_or(true, |h| !h.file.ends_with("auth.ts")), "lexical cannot match by meaning");

    let neural_db = tempfile::tempdir().unwrap();
    let (url, _) = mock_server();
    let embedder = HttpEmbedder::connect(&url, "mock-embed").unwrap();
    let neural = Index::open_with(r.path(), &neural_db.path().join("b.db"), Box::new(embedder)).unwrap();
    neural.build(&|_| {}).unwrap();
    let hits = neural.semantic_search(q, 3);
    assert!(hits.first().is_some_and(|h| h.file.ends_with("auth.ts")), "neural ranks auth.ts first, got {hits:?}");
    assert!(!hits.iter().take(1).any(|h| h.file.ends_with("gfx.ts")));
}

#[test]
fn indexing_sends_a_files_chunks_in_one_request_and_keeps_them_in_order() {
    let d = tempfile::tempdir().unwrap();
    // One file with many functions: many chunks, which must go to the server together.
    let mut src = String::new();
    for i in 0..30 {
        src.push_str(&format!("export function checkPassword{i}(p: string) {{\n  return p.length > {i};\n}}\n\n"));
    }
    src.push_str("export function matrixMultiplyAll(a: number[][]) {\n  return a;\n}\n");
    fs::write(d.path().join("big.ts"), &src).unwrap();

    let (url, requests) = mock_server();
    let embedder = HttpEmbedder::connect(&url, "mock-embed").unwrap();
    let probe_requests = requests.load(Ordering::SeqCst);
    let db = tempfile::tempdir().unwrap();
    let idx = Index::open_with(d.path(), &db.path().join("c.db"), Box::new(embedder)).unwrap();
    let stats = idx.build(&|_| {}).unwrap();
    let used = requests.load(Ordering::SeqCst) - probe_requests;
    assert!(stats.embedded_chunks >= 2, "the file should produce several chunks, got {}", stats.embedded_chunks);
    assert!(used < stats.embedded_chunks, "chunks must be batched: {} chunks took {} requests", stats.embedded_chunks, used);
    // Order is preserved across a batch: the matrix chunk is still found by a graphics query.
    assert!(idx.semantic_search("matrix vector maths", 1).first().is_some_and(|h| h.file.ends_with("big.ts")));
}
