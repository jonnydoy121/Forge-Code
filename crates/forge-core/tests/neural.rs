// Semantic search through a (mock) local Ollama-compatible embedding server: finds code the lexical embedder cannot.
use forge_core::index::embed_http::HttpEmbedder;
use forge_core::index::Index;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;

/// Mock /api/embed: a 3-concept "model". Credentials-ish text -> axis 0, graphics/maths text -> axis 1, else axis 2.
fn mock_server() -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming() {
            let mut s = s.unwrap();
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
                let body = String::from_utf8_lossy(&data).to_lowercase();
                let v = if ["password", "credential", "sign-in", "login"].iter().any(|w| body.contains(w)) {
                    "[1.0,0.0,0.0]"
                } else if ["matrix", "vector"].iter().any(|w| body.contains(w)) {
                    "[0.0,1.0,0.0]"
                } else {
                    "[0.0,0.0,1.0]"
                };
                let out = format!("{{\"embeddings\":[{v}]}}");
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len());
            });
        }
    });
    format!("http://127.0.0.1:{port}")
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
    let embedder = HttpEmbedder::connect(&mock_server(), "mock-embed").unwrap();
    let neural = Index::open_with(r.path(), &neural_db.path().join("b.db"), Box::new(embedder)).unwrap();
    neural.build(&|_| {}).unwrap();
    let hits = neural.semantic_search(q, 3);
    assert!(hits.first().is_some_and(|h| h.file.ends_with("auth.ts")), "neural ranks auth.ts first, got {hits:?}");
    assert!(!hits.iter().take(1).any(|h| h.file.ends_with("gfx.ts")));
}
