//! Local, deterministic embeddings via feature hashing of identifier sub-tokens (unigrams + bigrams).
//! Not a neural model: it captures lexical/semantic overlap of names and words, runs offline, and costs
//! nothing. The `Embedder` trait lets a neural local model (e.g. Ollama) replace it without touching callers.

pub const DIM: usize = 128;

pub trait Embedder: Send + Sync {
    fn dim(&self) -> usize;
    fn embed(&self, text: &str) -> Vec<f32>;
    /// Embed several texts at once. Backends with a network round trip per call override this to send them together.
    fn embed_batch(&self, texts: &[String]) -> Vec<Vec<f32>> {
        texts.iter().map(|t| self.embed(t)).collect()
    }
}

pub struct HashEmbedder;

fn fnv(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Split identifiers and words: `getUserById` / `get_user_by_id` -> get, user, by, id.
pub fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    let flush = |cur: &mut String, out: &mut Vec<String>| {
        if cur.len() >= 2 {
            out.push(std::mem::take(cur));
        } else {
            cur.clear();
        }
    };
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            if ch.is_uppercase() && prev_lower {
                flush(&mut cur, &mut out);
            }
            cur.extend(ch.to_lowercase());
            prev_lower = ch.is_lowercase() || ch.is_numeric();
        } else {
            flush(&mut cur, &mut out);
            prev_lower = false;
        }
    }
    flush(&mut cur, &mut out);
    out
}

impl Embedder for HashEmbedder {
    fn dim(&self) -> usize {
        DIM
    }
    fn embed(&self, text: &str) -> Vec<f32> {
        let toks = tokens(text);
        let mut v = vec![0f32; DIM];
        let mut add = |feature: &str, w: f32| {
            let h = fnv(feature);
            let idx = (h % DIM as u64) as usize;
            let sign = if (h >> 32) & 1 == 0 { 1.0 } else { -1.0 };
            v[idx] += sign * w;
        };
        for t in &toks {
            add(t, 1.0);
            // character trigrams give fuzzy morphology: matrix ~ matrices, validate ~ validation
            let cs: Vec<char> = t.chars().collect();
            for w in cs.windows(3) {
                add(&format!("#{}", w.iter().collect::<String>()), 0.3);
            }
        }
        for w in toks.windows(2) {
            add(&format!("{} {}", w[0], w[1]), 0.5);
        }
        // sublinear scaling then L2 normalise
        for x in v.iter_mut() {
            *x = x.signum() * x.abs().sqrt();
        }
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            v.iter_mut().for_each(|x| *x /= norm);
        }
        v
    }
}

/// Dot product (vectors are unit length, so this is the cosine). Eight independent accumulators let the compiler use
/// SIMD: a plain `.sum()` of floats must add in order, which blocks vectorisation.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let (a, b) = (&a[..n], &b[..n]);
    let ca = a.chunks_exact(8);
    let cb = b.chunks_exact(8);
    let (ra, rb) = (ca.remainder(), cb.remainder());
    let mut acc = [0f32; 8];
    for (x, y) in ca.zip(cb) {
        for i in 0..8 {
            acc[i] += x[i] * y[i];
        }
    }
    let mut sum: f32 = acc.iter().sum();
    for (x, y) in ra.iter().zip(rb) {
        sum += x * y;
    }
    sum
}

pub fn to_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

pub fn from_bytes(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_camel_and_snake_case() {
        assert_eq!(tokens("getUserById"), ["get", "user", "by", "id"]);
        assert_eq!(tokens("get_user_by_id"), ["get", "user", "by", "id"]);
    }

    #[test]
    fn related_text_scores_higher_than_unrelated() {
        let e = HashEmbedder;
        let q = e.embed("validate user password login");
        let auth = e.embed("function validatePassword(user) { return checkLogin(user.password); }");
        let math = e.embed("function matrixMultiply(a, b) { return a.map(row => dot(row, b)); }");
        assert!(cosine(&q, &auth) > cosine(&q, &math));
        assert!((cosine(&auth, &auth) - 1.0).abs() < 1e-4);
    }

    #[test]
    fn bytes_roundtrip() {
        let v = HashEmbedder.embed("hello world");
        assert_eq!(from_bytes(&to_bytes(&v)), v);
    }

    #[test]
    fn the_unrolled_dot_product_matches_the_naive_one_for_every_length() {
        // Lengths around the unroll width, including empty, shorter than 8, an exact multiple, and with a remainder.
        for n in [0usize, 1, 7, 8, 9, 15, 16, 17, 31, 128, 129, 1000] {
            let a: Vec<f32> = (0..n).map(|i| ((i * 37 % 101) as f32 - 50.0) / 50.0).collect();
            let b: Vec<f32> = (0..n).map(|i| ((i * 53 % 97) as f32 - 48.0) / 48.0).collect();
            let naive: f32 = a.iter().zip(&b).map(|(x, y)| x * y).sum();
            assert!((cosine(&a, &b) - naive).abs() < 1e-3, "length {n}: {} vs {naive}", cosine(&a, &b));
        }
    }

    #[test]
    fn mismatched_lengths_use_the_shorter_one_instead_of_panicking() {
        assert!((cosine(&[1.0, 2.0, 3.0], &[1.0, 1.0]) - 3.0).abs() < 1e-6);
        assert_eq!(cosine(&[], &[1.0]), 0.0);
    }
}
