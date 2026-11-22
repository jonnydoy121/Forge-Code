//! Bounded in-memory cache of file contents, so repeated searches never re-open 100k files. Entries are replaced when
//! a file is re-indexed and dropped when it is removed; the file watcher and `build` keep it current.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};

const SHARDS: usize = 64;

pub struct ContentCache {
    shards: Vec<RwLock<HashMap<String, Arc<str>>>>,
    bytes: AtomicUsize,
    cap: usize,
}

fn shard_of(key: &str) -> usize {
    let mut h: usize = 0xcbf29ce4;
    for b in key.bytes() {
        h = (h ^ b as usize).wrapping_mul(0x100000001b3);
    }
    h % SHARDS
}

impl ContentCache {
    pub fn new(cap_bytes: usize) -> Self {
        ContentCache { shards: (0..SHARDS).map(|_| RwLock::new(HashMap::new())).collect(), bytes: AtomicUsize::new(0), cap: cap_bytes }
    }

    pub fn get(&self, key: &str) -> Option<Arc<str>> {
        self.shards[shard_of(key)].read().unwrap().get(key).cloned()
    }

    /// Store (or replace) a file's content. Skipped when the cache is full and the key is new.
    pub fn put(&self, key: &str, content: &str) -> Arc<str> {
        let arc: Arc<str> = Arc::from(content);
        let mut shard = self.shards[shard_of(key)].write().unwrap();
        match shard.get(key) {
            Some(old) => {
                self.bytes.fetch_sub(old.len(), Ordering::Relaxed);
            }
            None if self.bytes.load(Ordering::Relaxed) + content.len() > self.cap => return arc,
            None => {}
        }
        self.bytes.fetch_add(content.len(), Ordering::Relaxed);
        shard.insert(key.to_string(), arc.clone());
        arc
    }

    pub fn remove(&self, key: &str) {
        if let Some(old) = self.shards[shard_of(key)].write().unwrap().remove(key) {
            self.bytes.fetch_sub(old.len(), Ordering::Relaxed);
        }
    }

    pub fn bytes(&self) -> usize {
        self.bytes.load(Ordering::Relaxed)
    }

    pub fn len(&self) -> usize {
        self.shards.iter().map(|s| s.read().unwrap().len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_replaces_and_removes_with_byte_accounting() {
        let c = ContentCache::new(1000);
        c.put("a", "hello");
        c.put("b", "world!!");
        assert_eq!((c.len(), c.bytes()), (2, 12));
        c.put("a", "hi"); // replace
        assert_eq!(c.bytes(), 9);
        assert_eq!(&*c.get("a").unwrap(), "hi");
        c.remove("a");
        assert!(c.get("a").is_none());
        assert_eq!(c.bytes(), 7);
    }

    #[test]
    fn respects_the_cap_for_new_entries_but_still_replaces_existing_ones() {
        let c = ContentCache::new(10);
        c.put("a", "12345678");
        let big = c.put("b", "123456"); // would exceed the cap: returned but not cached
        assert_eq!(&*big, "123456");
        assert!(c.get("b").is_none());
        c.put("a", "1234"); // replacing a cached entry is always allowed
        assert_eq!(&*c.get("a").unwrap(), "1234");
    }
}
