//! Symbol graph (file level): import edges + name-based reference edges (calls, inheritance and type uses
//! all appear as identifier references). Personalised PageRank over it ranks files for the repo map.

use super::parse::path_is_test;
use super::{Cone, State};
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Default)]
pub struct Graph {
    pub nodes: Vec<String>,
    pub index: HashMap<String, usize>,
    pub out: Vec<Vec<(usize, f32)>>,
    pub inn: Vec<Vec<usize>>,
}

fn dir_of(p: &str) -> &str {
    p.rfind('/').map(|i| &p[..i]).unwrap_or("")
}

fn normalize(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            p => out.push(p),
        }
    }
    out.join("/")
}

fn join(dir: &str, rel: &str) -> String {
    if dir.is_empty() { normalize(rel) } else { normalize(&format!("{dir}/{rel}")) }
}

/// Resolve an import specifier to repo files. Best effort and conservative: unresolved specs yield nothing.
pub fn resolve_import(lang: &str, from: &str, spec: &str, paths: &HashSet<String>, dirs: &HashMap<String, Vec<String>>) -> Vec<String> {
    let try_all = |cands: Vec<String>| cands.into_iter().filter(|c| paths.contains(c)).take(1).collect::<Vec<_>>();
    match lang {
        "typescript" | "tsx" | "javascript" => {
            if !spec.starts_with('.') {
                return vec![];
            }
            let base = join(dir_of(from), spec);
            let stripped = ["js", "jsx", "mjs", "cjs"].iter().find_map(|e| base.strip_suffix(&format!(".{e}")).map(|s| s.to_string()));
            let mut c = vec![base.clone()];
            for stem in std::iter::once(base.clone()).chain(stripped) {
                for e in ["ts", "tsx", "js", "jsx", "mjs"] {
                    c.push(format!("{stem}.{e}"));
                    c.push(format!("{stem}/index.{e}"));
                }
            }
            try_all(c)
        }
        "python" => {
            let dots = spec.chars().take_while(|c| *c == '.').count();
            let rest = spec[dots..].replace('.', "/");
            let mut bases = Vec::new();
            if dots > 0 {
                let mut d = dir_of(from).to_string();
                for _ in 1..dots {
                    d = dir_of(&d).to_string();
                }
                bases.push(join(&d, &rest));
            } else {
                bases.push(normalize(&rest));
                bases.push(join(dir_of(from), &rest));
            }
            let mut c = Vec::new();
            for b in bases {
                c.push(format!("{b}.py"));
                c.push(format!("{b}/__init__.py"));
            }
            try_all(c)
        }
        "rust" => {
            let Some(name) = spec.strip_prefix("mod:") else { return vec![] };
            let d = dir_of(from);
            let stem = from.rsplit('/').next().unwrap_or("").trim_end_matches(".rs");
            let mut c = vec![join(d, &format!("{name}.rs")), join(d, &format!("{name}/mod.rs"))];
            if !matches!(stem, "mod" | "lib" | "main") {
                c.push(join(d, &format!("{stem}/{name}.rs")));
            }
            try_all(c)
        }
        "c" | "cpp" => try_all(vec![join(dir_of(from), spec), normalize(spec)]),
        "java" | "csharp" => {
            let ext = if lang == "java" { "java" } else { "cs" };
            let suffix = format!("{}.{ext}", spec.replace('.', "/"));
            let last = format!("/{}.{ext}", spec.rsplit('.').next().unwrap_or(spec));
            paths.iter().filter(|p| p.ends_with(&suffix) || (lang == "csharp" && p.ends_with(&last))).take(1).cloned().collect()
        }
        "go" => dirs
            .iter()
            .filter(|(d, _)| d.as_str() == spec || d.ends_with(&format!("/{spec}")))
            .flat_map(|(_, files)| files.iter().filter(|f| f.ends_with(".go") && !f.ends_with("_test.go")).take(20).cloned())
            .collect(),
        _ => vec![],
    }
}

pub(crate) fn build(st: &State) -> Graph {
    let mut nodes: Vec<String> = st.files.iter().filter(|(_, f)| !f.parsed.lang.is_empty()).map(|(p, _)| p.clone()).collect();
    nodes.sort();
    let index: HashMap<String, usize> = nodes.iter().cloned().enumerate().map(|(i, p)| (p, i)).collect();
    let paths: HashSet<String> = st.files.keys().cloned().collect();
    let mut dirs: HashMap<String, Vec<String>> = HashMap::new();
    for p in &paths {
        dirs.entry(dir_of(p).to_string()).or_default().push(p.clone());
    }
    let mut out: Vec<Vec<(usize, f32)>> = vec![Vec::new(); nodes.len()];
    let mut inn: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    for (i, p) in nodes.iter().enumerate() {
        let f = &st.files[p];
        let mut targets: HashMap<usize, f32> = HashMap::new();
        for spec in &f.parsed.imports {
            for t in resolve_import(&f.parsed.lang, p, spec, &paths, &dirs) {
                if let Some(&j) = index.get(&t) {
                    if j != i {
                        *targets.entry(j).or_default() += 3.0;
                    }
                }
            }
        }
        for r in &f.parsed.refs {
            if r.len() < 3 {
                continue;
            }
            if let Some(defs) = st.defs.get(r) {
                // Common names defined in many files carry no signal.
                if defs.len() <= 3 {
                    for (df, _) in defs {
                        if let Some(&j) = index.get(df) {
                            if j != i {
                                *targets.entry(j).or_default() += 1.0;
                            }
                        }
                    }
                }
            }
        }
        for (j, w) in targets {
            out[i].push((j, w));
            inn[j].push(i);
        }
    }
    Graph { nodes, index, out, inn }
}

impl Graph {
    pub fn pagerank(&self, focus: &[String]) -> Vec<f32> {
        let n = self.nodes.len();
        if n == 0 {
            return vec![];
        }
        let focus_idx: Vec<usize> = focus.iter().filter_map(|f| self.index.get(f).copied()).collect();
        let mut tele = vec![1.0 / n as f32; n];
        if !focus_idx.is_empty() {
            tele = vec![0.0; n];
            // Focus files and their direct neighbours get the teleport mass.
            let mut seeds: HashSet<usize> = focus_idx.iter().copied().collect();
            for &f in &focus_idx {
                seeds.extend(self.out[f].iter().map(|(j, _)| *j));
                seeds.extend(self.inn[f].iter().copied());
            }
            for &s in &seeds {
                tele[s] = if focus_idx.contains(&s) { 3.0 } else { 1.0 };
            }
            let sum: f32 = tele.iter().sum();
            tele.iter_mut().for_each(|x| *x /= sum);
        }
        let totals: Vec<f32> = self.out.iter().map(|o| o.iter().map(|(_, w)| w).sum()).collect();
        let d = 0.85f32;
        let mut rank = vec![1.0 / n as f32; n];
        for _ in 0..30 {
            let mut next: Vec<f32> = tele.iter().map(|t| (1.0 - d) * t).collect();
            let mut dangling = 0.0;
            for i in 0..n {
                if totals[i] == 0.0 {
                    dangling += rank[i];
                } else {
                    for &(j, w) in &self.out[i] {
                        next[j] += d * rank[i] * w / totals[i];
                    }
                }
            }
            for (i, t) in tele.iter().enumerate() {
                next[i] += d * dangling * t;
            }
            rank = next;
        }
        rank
    }

    fn bfs(&self, start: usize, upstream: bool, depth: usize) -> Vec<usize> {
        let mut seen = HashSet::from([start]);
        let mut q = VecDeque::from([(start, 0usize)]);
        let mut out = Vec::new();
        while let Some((n, d)) = q.pop_front() {
            if d == depth {
                continue;
            }
            let next: Vec<usize> = if upstream { self.inn[n].clone() } else { self.out[n].iter().map(|(j, _)| *j).collect() };
            for m in next {
                if seen.insert(m) {
                    out.push(m);
                    q.push_back((m, d + 1));
                }
            }
        }
        out
    }

    pub fn cone(&self, rel: &str) -> Cone {
        let Some(&i) = self.index.get(rel) else { return Cone::default() };
        let names = |v: Vec<usize>| {
            let mut s: Vec<String> = v.into_iter().map(|j| self.nodes[j].clone()).collect();
            s.sort();
            s
        };
        let up = self.bfs(i, true, 3);
        Cone {
            imports: names(self.out[i].iter().map(|(j, _)| *j).collect()),
            imported_by: names(self.inn[i].clone()),
            tests: names(up.iter().copied().filter(|&j| path_is_test(&self.nodes[j])).collect()),
            transitive_upstream: names(up),
            transitive_downstream: names(self.bfs(i, false, 3)),
        }
    }
}

/// Render the top-ranked signatures as a compact tree within a token budget (about 4 chars per token).
pub(crate) fn repo_map(st: &State, focus: &[String], token_budget: usize) -> String {
    let Some(g) = st.graph.as_ref() else { return String::new() };
    let rank = g.pagerank(focus);
    let mut order: Vec<usize> = (0..g.nodes.len()).collect();
    order.sort_by(|&a, &b| {
        let fa = focus.contains(&g.nodes[a]);
        let fb = focus.contains(&g.nodes[b]);
        fb.cmp(&fa).then(rank[b].partial_cmp(&rank[a]).unwrap_or(std::cmp::Ordering::Equal)).then(g.nodes[a].cmp(&g.nodes[b]))
    });
    let mut out = String::new();
    for i in order {
        let path = &g.nodes[i];
        let f = &st.files[path];
        if f.parsed.symbols.is_empty() {
            continue;
        }
        let mut block = format!("{path}:\n");
        for s in f.parsed.symbols.iter().take(12) {
            block.push_str(&format!("  {}: {}\n", s.line, s.signature));
        }
        if out.len() + block.len() > token_budget * 4 {
            break;
        }
        out.push_str(&block);
    }
    out
}
