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
        let resp: serde_json::Value = self
            .agent
            .post(&self.url)
            .send_json(serde_json::json!({ "model": self.model, "input": [text] }))
            .map_err(|e| e.to_string())?
            .into_json()
            .map_err(|e| e.to_string())?;
        let first = resp["embeddings"].get(0).and_then(|v| v.as_array()).ok_or("response has no embeddings")?;
        Ok(normalise(first.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect()))
    }
}

impl Embedder for HttpEmbedder {
    fn dim(&self) -> usize {
        self.dim
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

    /// Tiny mock server: answers every POST with a fixed 3-d vector derived from whether the input mentions "auth".
    fn mock() -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
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
                    let done = text.split_once("\r\n\r\n").map_or(false, |(h, b)| {
                        let want = h.to_lowercase().split("content-length:").nth(1).and_then(|r| r.trim().split(|c: char| !c.is_ascii_digit()).next().and_then(|d| d.parse::<usize>().ok())).unwrap_or(0);
                        b.len() >= want
                    });
                    if n == 0 || done {
                        break;
                    }
                }
                let req = String::from_utf8_lossy(&data).to_string();
                let v = if req.contains("auth") { "[3.0,4.0,0.0]" } else { "[0.0,0.0,2.0]" };
                let body = format!("{{\"embeddings\":[{v}]}}");
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    #[test]
    fn learns_dimension_and_returns_unit_vectors() {
        let e = HttpEmbedder::connect(&mock(), "m").unwrap();
        assert_eq!(e.dim(), 3);
        let v = e.embed("login auth flow");
        assert!((v[0] - 0.6).abs() < 1e-6 && (v[1] - 0.8).abs() < 1e-6, "{v:?}");
        assert_eq!(e.embed("other"), vec![0.0, 0.0, 1.0]);
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
    }
}
