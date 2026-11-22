//! Merkle tree of file hashes. Leaf = file content hash; directory node = hash of its sorted children.
//! Comparing two trees yields only the branches whose hashes differ, so unchanged subtrees are skipped.

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    File(String),
    Dir { hash: String, children: BTreeMap<String, Node> },
}

impl Node {
    pub fn hash(&self) -> &str {
        match self {
            Node::File(h) => h,
            Node::Dir { hash, .. } => hash,
        }
    }
}

fn dir_hash(children: &BTreeMap<String, Node>) -> String {
    let mut h = blake3::Hasher::new();
    for (name, node) in children {
        h.update(name.as_bytes());
        h.update(&[0]);
        h.update(node.hash().as_bytes());
        h.update(&[0]);
    }
    h.finalize().to_hex().to_string()
}

/// Build from (relative path with `/` separators, content hash) pairs.
pub fn build(files: &[(String, String)]) -> Node {
    #[derive(Default)]
    struct Tmp {
        files: BTreeMap<String, String>,
        dirs: BTreeMap<String, Tmp>,
    }
    let mut root = Tmp::default();
    for (path, hash) in files {
        let mut parts = path.split('/').peekable();
        let mut cur = &mut root;
        while let Some(p) = parts.next() {
            if parts.peek().is_some() {
                cur = cur.dirs.entry(p.to_string()).or_default();
            } else {
                cur.files.insert(p.to_string(), hash.clone());
            }
        }
    }
    fn finish(t: Tmp) -> Node {
        let mut children = BTreeMap::new();
        for (n, h) in t.files {
            children.insert(n, Node::File(h));
        }
        for (n, d) in t.dirs {
            children.insert(n, finish(d));
        }
        Node::Dir { hash: dir_hash(&children), children }
    }
    finish(root)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Diff {
    pub added_or_changed: Vec<String>,
    pub removed: Vec<String>,
    /// How many nodes were compared; subtrees with equal hashes count once.
    pub visited: usize,
}

pub fn diff(old: &Node, new: &Node) -> Diff {
    let mut d = Diff::default();
    walk(Some(old), Some(new), "", &mut d);
    d.added_or_changed.sort();
    d.removed.sort();
    d
}

fn collect(node: &Node, prefix: &str, out: &mut Vec<String>) {
    match node {
        Node::File(_) => out.push(prefix.to_string()),
        Node::Dir { children, .. } => {
            for (n, c) in children {
                collect(c, &join(prefix, n), out);
            }
        }
    }
}

fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() { name.to_string() } else { format!("{prefix}/{name}") }
}

fn walk(old: Option<&Node>, new: Option<&Node>, path: &str, d: &mut Diff) {
    d.visited += 1;
    match (old, new) {
        (None, None) => {}
        (None, Some(n)) => collect(n, path, &mut d.added_or_changed),
        (Some(o), None) => collect(o, path, &mut d.removed),
        (Some(o), Some(n)) if o.hash() == n.hash() => {}
        (Some(Node::Dir { children: oc, .. }), Some(Node::Dir { children: nc, .. })) => {
            let names: std::collections::BTreeSet<&String> = oc.keys().chain(nc.keys()).collect();
            for name in names {
                walk(oc.get(name), nc.get(name), &join(path, name), d);
            }
        }
        (Some(o), Some(n)) => {
            // file<->dir or file content changed
            collect(o, path, &mut d.removed);
            collect(n, path, &mut d.added_or_changed);
            if matches!((o, n), (Node::File(_), Node::File(_))) {
                d.removed.retain(|p| p != path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn identical_trees_have_equal_root_hash_and_empty_diff() {
        let a = build(&files(&[("a/x.ts", "1"), ("b.ts", "2")]));
        let b = build(&files(&[("b.ts", "2"), ("a/x.ts", "1")]));
        assert_eq!(a.hash(), b.hash());
        let d = diff(&a, &b);
        assert!(d.added_or_changed.is_empty() && d.removed.is_empty());
        assert_eq!(d.visited, 1); // root hashes matched: nothing below was visited
    }

    #[test]
    fn reports_changed_added_removed_and_skips_unchanged_branches() {
        let old = build(&files(&[("a/x.ts", "1"), ("a/y.ts", "1"), ("c/z.ts", "1"), ("gone.ts", "1")]));
        let new = build(&files(&[("a/x.ts", "2"), ("a/y.ts", "1"), ("c/z.ts", "1"), ("new/n.ts", "1")]));
        let d = diff(&old, &new);
        assert_eq!(d.added_or_changed, vec!["a/x.ts", "new/n.ts"]);
        assert_eq!(d.removed, vec!["gone.ts"]);
        // `c/` is identical so its children were never visited.
        assert!(d.visited < 10);
    }
}
