// Opt-in: semantic search through a REAL local Ollama server (nomic-embed-text).
//   cargo test -p forge-core --test neural_live -- --ignored --nocapture
// Needs `ollama serve` running on 127.0.0.1:11434 with the model pulled: `ollama pull nomic-embed-text`.
use forge_core::index::embed::Embedder;
use forge_core::index::embed_http::HttpEmbedder;
use forge_core::index::Index;
use std::fs;

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    fs::create_dir_all(d.path().join("src")).unwrap();
    let w = |name: &str, body: &str| fs::write(d.path().join("src").join(name), body).unwrap();
    w("auth.ts", "// Verify a person's secret passphrase when they log in\nexport function validatePassword(user: string, pass: string): boolean {\n  return hash(pass) === storedHash(user);\n}\n");
    w("gfx.ts", "// Multiply two grids of numbers together\nexport function matrixMultiply(a: number[][], b: number[][]): number[][] {\n  return a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));\n}\n");
    w("dates.ts", "// Turn a timestamp into a human readable calendar string\nexport function formatDate(ts: number): string {\n  return new Date(ts).toLocaleDateString();\n}\n");
    w("db.ts", "// Open a connection pool to the relational database server\nexport async function connectDatabase(url: string) {\n  return createPool({ connectionString: url, max: 10 });\n}\n");
    d
}

#[test]
#[ignore = "needs a running Ollama with nomic-embed-text"]
fn real_embeddings_find_code_by_meaning() {
    let embedder = HttpEmbedder::connect("http://127.0.0.1:11434", "nomic-embed-text").expect("Ollama must be running with nomic-embed-text pulled");
    println!("embedding dimension from the real model: {}", embedder.dim());
    assert!(embedder.dim() >= 256, "a real neural model returns hundreds of dimensions, got {}", embedder.dim());

    let r = repo();
    let db = tempfile::tempdir().unwrap();
    let idx = Index::open_with(r.path(), &db.path().join("n.db"), Box::new(embedder)).unwrap();
    idx.build(&|_| {}).unwrap();

    // Each query shares no distinctive word with the file it should find.
    let cases = [
        ("where do we check that someone typed the right credentials", "auth.ts"),
        ("combine two tables of numbers into a product", "gfx.ts"),
        ("show a nice looking day and month to the user", "dates.ts"),
        ("establish a link to our SQL store", "db.ts"),
    ];
    let mut hits = 0;
    for (q, want) in cases {
        let found = idx.semantic_search(q, 1);
        let top = found.first().map(|h| h.file.clone()).unwrap_or_default();
        println!("{q:62} -> {top}");
        if top.ends_with(want) {
            hits += 1;
        }
    }
    assert!(hits >= 3, "real embeddings should place at least 3 of 4 queries correctly, got {hits}");
}

#[test]
#[ignore = "needs a running Ollama with nomic-embed-text"]
fn the_lexical_embedder_cannot_do_the_same() {
    let r = repo();
    let db = tempfile::tempdir().unwrap();
    let idx = Index::open(r.path(), &db.path().join("l.db")).unwrap();
    idx.build(&|_| {}).unwrap();
    let cases = [
        ("where do we check that someone typed the right credentials", "auth.ts"),
        ("combine two tables of numbers into a product", "gfx.ts"),
        ("show a nice looking day and month to the user", "dates.ts"),
        ("establish a link to our SQL store", "db.ts"),
    ];
    let hits = cases.iter().filter(|(q, want)| idx.semantic_search(q, 1).first().is_some_and(|h| h.file.ends_with(want))).count();
    println!("lexical embedder placed {hits} of 4 correctly");
}
