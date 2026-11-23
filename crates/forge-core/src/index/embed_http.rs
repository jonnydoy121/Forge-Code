//! Neural embeddings from a local Ollama-compatible server (`POST /api/embed`). Loopback only: code never leaves the
//! machine to be embedded. Connect probes the server once to learn the vector size; if it is unreachable the caller
//! keeps the built-in lexical embedder.

use super::embed::Embedder;
use std::time::Duration;

#[derive(Debug)]
pub struct HttpEmbedder {
    url: String,
    model: String,
    dim: usize,
    agent: ureq::Agent,
}

fn is_loopback(url: &str) -> bool {
    let rest = url.strip_prefix("http://").unwrap_or("");
    let host = rest.split(['/', ':']).next().unwrap_or("");
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

fn normalise(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
    v
}

impl HttpEmbedder {
    pub fn connect(base_url: &str, model: &str) -> Result<Self, String> {
        let base = base_url.trim_end_matches('/');
        if !is_loopback(base) {
            return Err(format!("embedding server must be on this machine (http://127.0.0.1 or localhost), got {base_url}"));
        }
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(30)).build();
        let mut me = HttpEmbedder { url: format!("{base}/api/embed"), model: model.to_string(), dim: 0, agent };
        let probe = me.request("dimension probe")?;
        if probe.is_empty() {
            return Err("embedding server returned an empty vector".into());
        }
        me.dim = probe.len();
        Ok(me)
    }

    fn request(&self, text: &str) -> Result<Vec<f32>, String> {
        self.request_batch(&[text.to_string()])?.into_iter().next().ok_or_else(|| "response has no embeddings".to_string())
    }

    /// One HTTP request for many inputs: Ollama's /api/embed accepts an array and returns one vector per entry, in order.
    fn request_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let resp: serde_json::Value = self.agent.post(&self.url).send_json(serde_json::json!({ "model": self.model, "input": texts })).map_err(|e| e.to_string())?.into_json().map_err(|e| e.to_string())?;
        let all = resp["embeddings"].as_array().ok_or("response has no embeddings")?;
        if all.len() != texts.len() {
            return Err(format!("asked for {} embeddings, got {}", texts.len(), all.len()));
        }
        Ok(all.iter().map(|v| normalise(v.as_array().map(|a| a.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect()).unwrap_or_default())).collect())
    }
}

impl Embedder for HttpEmbedder {
    fn dim(&self) -> usize {
        self.dim
    }
    /// Sends up to BATCH texts per request. A group that fails is retried one by one, so a single bad chunk cannot
    /// zero out its neighbours; whatever still fails yields a zero vector.
    fn embed_batch(&self, texts: &[String]) -> Vec<Vec<f32>> {
        const BATCH: usize = 16;
        let clip = |t: &String| t.chars().take(6000).collect::<String>();
        let mut out = Vec::with_capacity(texts.len());
        for group in texts.chunks(BATCH) {
            let clipped: Vec<String> = group.iter().map(clip).collect();
            match self.request_batch(&clipped) {
                Ok(v) if v.iter().all(|x| x.len() == self.dim) => out.extend(v),
                _ => out.extend(group.iter().map(|t| self.embed(t))),
            }
        }
        out
    }

    /// A failed request yields a zero vector (matches nothing) rather than failing the whole index.
    fn embed(&self, text: &str) -> Vec<f32> {
        match self.request(&text.chars().take(6000).collect::<String>()) {
            Ok(v) if v.len() == self.dim => v,
            _ => vec![0.0; self.dim],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Mock /api/embed: one vector per input ([3,4,0] when the text mentions "auth", else [0,0,2]). Counts requests.
    fn mock() -> (String, Arc<AtomicUsize>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let requests = Arc::new(AtomicUsize::new(0));
        let counter = requests.clone();
        std::thread::spawn(move || {
            for s in l.incoming() {
                let mut s = s.unwrap();
                // The client may send headers and body in separate writes: read until the whole body has arrived.
                let mut data = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = s.read(&mut buf).unwrap_or(0);
                    data.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&data).to_string();
                    let done = text.split_once("\r\n\r\n").is_some_and(|(h, b)| {
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
                    .map(|a| a.iter().map(|t| if t.as_str().unwrap_or("").contains("auth") { serde_json::json!([3.0, 4.0, 0.0]) } else { serde_json::json!([0.0, 0.0, 2.0]) }).collect())
                    .unwrap_or_default();
                let out = serde_json::json!({ "embeddings": vectors }).to_string();
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len());
            }
        });
        (format!("http://127.0.0.1:{port}"), requests)
    }

    #[test]
    fn learns_dimension_and_returns_unit_vectors() {
        let (url, _) = mock();
        let e = HttpEmbedder::connect(&url, "m").unwrap();
        assert_eq!(e.dim(), 3);
        let v = e.embed("login auth flow");
        assert!((v[0] - 0.6).abs() < 1e-6 && (v[1] - 0.8).abs() < 1e-6, "{v:?}");
        assert_eq!(e.embed("other"), vec![0.0, 0.0, 1.0]);
    }

    #[test]
    fn a_batch_is_one_request_per_sixteen_texts_and_keeps_order() {
        let (url, requests) = mock();
        let e = HttpEmbedder::connect(&url, "m").unwrap();
        let before = requests.load(Ordering::SeqCst); // the connect probe
        let texts: Vec<String> = (0..40).map(|i| if i % 2 == 0 { format!("auth {i}") } else { format!("other {i}") }).collect();
        let vecs = e.embed_batch(&texts);
        assert_eq!(vecs.len(), 40);
        assert_eq!(requests.load(Ordering::SeqCst) - before, 3, "40 texts = 3 requests (16 + 16 + 8), not 40");
        for (i, v) in vecs.iter().enumerate() {
            let expect_auth = i % 2 == 0;
            assert_eq!(v[0] > 0.5, expect_auth, "vector {i} is in the wrong position: {v:?}");
        }
    }

    #[test]
    fn an_empty_batch_makes_no_request() {
        let (url, requests) = mock();
        let e = HttpEmbedder::connect(&url, "m").unwrap();
        let before = requests.load(Ordering::SeqCst);
        assert!(e.embed_batch(&[]).is_empty());
        assert_eq!(requests.load(Ordering::SeqCst), before);
    }

    #[test]
    fn refuses_non_local_servers_and_reports_unreachable_ones() {
        assert!(HttpEmbedder::connect("http://10.0.0.5:11434", "m").unwrap_err().contains("on this machine"));
        assert!(HttpEmbedder::connect("https://api.example.com", "m").is_err());
        assert!(HttpEmbedder::connect("http://127.0.0.1:1", "m").is_err());
    }

    #[test]
    fn an_outage_after_connect_degrades_to_zero_vectors() {
        let e = HttpEmbedder { url: "http://127.0.0.1:1/api/embed".into(), model: "m".into(), dim: 3, agent: ureq::AgentBuilder::new().timeout(Duration::from_secs(2)).build() };
        assert_eq!(e.embed("x"), vec![0.0; 3]);
        assert_eq!(e.embed_batch(&["a".to_string(), "b".to_string()]), vec![vec![0.0; 3], vec![0.0; 3]]);
    }
}
