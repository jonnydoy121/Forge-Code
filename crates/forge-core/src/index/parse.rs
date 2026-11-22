//! tree-sitter parsing: symbols, imports, identifier references and syntax-aware chunks.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::OnceLock;
use tree_sitter::{Language, Node, Parser};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    /// 1-based
    pub line: u32,
    pub end_line: u32,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkMeta {
    pub start: u32,
    pub end: u32,
    pub hash: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Parsed {
    pub lang: String,
    pub symbols: Vec<Symbol>,
    pub imports: Vec<String>,
    pub refs: Vec<String>,
    pub chunks: Vec<ChunkMeta>,
}

struct Spec {
    name: &'static str,
    lang: Language,
    /// (node kind, symbol kind)
    defs: &'static [(&'static str, &'static str)],
}

pub fn language_for(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "py" => "python",
        "go" => "go",
        "rs" => "rust",
        "java" => "java",
        "cs" => "csharp",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" => "cpp",
        _ => return None,
    })
}

fn spec(lang: &str) -> Option<Spec> {
    Some(match lang {
        "typescript" => Spec { name: "typescript", lang: tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), defs: TS_DEFS },
        "tsx" => Spec { name: "tsx", lang: tree_sitter_typescript::LANGUAGE_TSX.into(), defs: TS_DEFS },
        "javascript" => Spec { name: "javascript", lang: tree_sitter_javascript::LANGUAGE.into(), defs: TS_DEFS },
        "python" => Spec { name: "python", lang: tree_sitter_python::LANGUAGE.into(), defs: &[("function_definition", "function"), ("class_definition", "class")] },
        "go" => Spec { name: "go", lang: tree_sitter_go::LANGUAGE.into(), defs: &[("function_declaration", "function"), ("method_declaration", "method"), ("type_spec", "type")] },
        "rust" => Spec {
            name: "rust",
            lang: tree_sitter_rust::LANGUAGE.into(),
            defs: &[("function_item", "function"), ("struct_item", "struct"), ("enum_item", "enum"), ("trait_item", "trait"), ("mod_item", "module"), ("type_item", "type")],
        },
        "java" => Spec {
            name: "java",
            lang: tree_sitter_java::LANGUAGE.into(),
            defs: &[("class_declaration", "class"), ("interface_declaration", "interface"), ("enum_declaration", "enum"), ("method_declaration", "method"), ("constructor_declaration", "constructor")],
        },
        "csharp" => Spec {
            name: "csharp",
            lang: tree_sitter_c_sharp::LANGUAGE.into(),
            defs: &[("class_declaration", "class"), ("interface_declaration", "interface"), ("struct_declaration", "struct"), ("enum_declaration", "enum"), ("method_declaration", "method"), ("namespace_declaration", "namespace")],
        },
        "c" => Spec { name: "c", lang: tree_sitter_c::LANGUAGE.into(), defs: &[("function_definition", "function"), ("struct_specifier", "struct"), ("enum_specifier", "enum")] },
        "cpp" => Spec {
            name: "cpp",
            lang: tree_sitter_cpp::LANGUAGE.into(),
            defs: &[("function_definition", "function"), ("class_specifier", "class"), ("struct_specifier", "struct"), ("namespace_definition", "namespace"), ("enum_specifier", "enum")],
        },
        _ => return None,
    })
}

const TS_DEFS: &[(&str, &str)] = &[
    ("function_declaration", "function"),
    ("generator_function_declaration", "function"),
    ("class_declaration", "class"),
    ("abstract_class_declaration", "class"),
    ("interface_declaration", "interface"),
    ("type_alias_declaration", "type"),
    ("enum_declaration", "enum"),
    ("method_definition", "method"),
    ("method_signature", "method"),
];

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).unwrap())
}

fn text<'a>(n: Node, src: &'a [u8]) -> &'a str {
    n.utf8_text(src).unwrap_or("")
}

/// Name of a definition node. C/C++ nest it inside declarators; TS variable declarators holding functions are handled separately.
fn def_name(n: Node, src: &[u8]) -> Option<String> {
    if let Some(name) = n.child_by_field_name("name") {
        return Some(text(name, src).to_string());
    }
    // C / C++: function_definition -> declarator -> ... -> identifier
    let mut cur = n.child_by_field_name("declarator")?;
    loop {
        match cur.kind() {
            "identifier" | "field_identifier" | "qualified_identifier" | "type_identifier" => return Some(text(cur, src).to_string()),
            _ => cur = cur.child_by_field_name("declarator").or_else(|| cur.named_child(0))?,
        }
    }
}

fn signature(n: Node, src: &[u8]) -> String {
    let t = text(n, src);
    let first = t.lines().next().unwrap_or("").trim();
    let first = first.trim_end_matches('{').trim_end();
    first.chars().take(160).collect()
}

fn is_test_path(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    p.contains(".test.") || p.contains(".spec.") || p.contains("_test.") || p.contains("/test_") || p.starts_with("test_") || p.contains("/tests/") || p.contains("/__tests__/") || p.starts_with("tests/")
}
pub fn path_is_test(path: &str) -> bool {
    is_test_path(path)
}

pub fn parse(path: &str, content: &str) -> Parsed {
    let Some(lang_name) = language_for(path) else { return Parsed::default() };
    let Some(spec) = spec(lang_name) else { return Parsed::default() };
    let mut parser = Parser::new();
    if parser.set_language(&spec.lang).is_err() {
        return Parsed::default();
    }
    let Some(tree) = parser.parse(content, None) else { return Parsed::default() };
    let src = content.as_bytes();
    let root = tree.root_node();

    let mut out = Parsed { lang: spec.name.to_string(), ..Default::default() };
    let mut refs: HashSet<String> = HashSet::new();
    let mut def_name_nodes: HashSet<usize> = HashSet::new();
    let mut def_nodes: Vec<(usize, usize)> = Vec::new(); // byte ranges for chunking

    // Iterative DFS.
    let mut stack = vec![root];
    while let Some(n) = stack.pop() {
        let kind = n.kind();
        if let Some((_, sk)) = spec.defs.iter().find(|(k, _)| *k == kind) {
            if let Some(name) = def_name(n, src) {
                if let Some(nn) = n.child_by_field_name("name") {
                    def_name_nodes.insert(nn.id());
                }
                out.symbols.push(Symbol { name, kind: sk.to_string(), line: n.start_position().row as u32 + 1, end_line: n.end_position().row as u32 + 1, signature: signature(n, src) });
                def_nodes.push((n.start_byte(), n.end_byte()));
            }
        } else if kind == "variable_declarator" && matches!(spec.name, "typescript" | "tsx" | "javascript") {
            // const foo = () => {}  /  const foo = function () {}
            if let (Some(name), Some(val)) = (n.child_by_field_name("name"), n.child_by_field_name("value")) {
                if matches!(val.kind(), "arrow_function" | "function_expression" | "function") {
                    def_name_nodes.insert(name.id());
                    let decl = n.parent().unwrap_or(n);
                    out.symbols.push(Symbol { name: text(name, src).to_string(), kind: "function".into(), line: n.start_position().row as u32 + 1, end_line: n.end_position().row as u32 + 1, signature: signature(decl, src) });
                    def_nodes.push((decl.start_byte(), decl.end_byte()));
                }
            }
        }
        if kind.ends_with("identifier") && n.child_count() == 0 && !def_name_nodes.contains(&n.id()) {
            let t = text(n, src);
            if t.len() >= 2 && refs.len() < 4000 {
                refs.insert(t.to_string());
            }
        }
        extract_import(kind, n, src, &spec, &mut out.imports);
        let mut c = n.walk();
        for ch in n.children(&mut c) {
            stack.push(ch);
        }
    }
    out.symbols.sort_by_key(|s| s.line);
    // A definition name is also a "reference" only if used elsewhere; keep refs minus own defs for graph noise reduction.
    let own: HashSet<&str> = out.symbols.iter().map(|s| s.name.as_str()).collect();
    out.refs = refs.into_iter().filter(|r| !own.contains(r.as_str())).collect();
    out.refs.sort();
    out.imports.sort();
    out.imports.dedup();
    out.chunks = chunk(content, &mut def_nodes);
    out
}

fn extract_import(kind: &str, n: Node, src: &[u8], spec: &Spec, imports: &mut Vec<String>) {
    static TS_FROM: OnceLock<Regex> = OnceLock::new();
    static REQUIRE: OnceLock<Regex> = OnceLock::new();
    static PY_FROM: OnceLock<Regex> = OnceLock::new();
    static PY_IMPORT: OnceLock<Regex> = OnceLock::new();
    static GO: OnceLock<Regex> = OnceLock::new();
    static JAVA: OnceLock<Regex> = OnceLock::new();
    static CS: OnceLock<Regex> = OnceLock::new();
    static INC: OnceLock<Regex> = OnceLock::new();
    match (spec.name, kind) {
        ("typescript" | "tsx" | "javascript", "import_statement" | "export_statement") => {
            let t = text(n, src);
            // only the statement head, not a whole exported function body
            let head: String = t.lines().take(8).collect::<Vec<_>>().join(" ");
            if let Some(c) = re(&TS_FROM, r#"(?:from|import)\s*['"]([^'"]+)['"]"#).captures(&head) {
                imports.push(c[1].to_string());
            }
        }
        ("typescript" | "tsx" | "javascript", "call_expression") => {
            let t = text(n, src);
            if t.starts_with("require") {
                if let Some(c) = re(&REQUIRE, r#"^require\(\s*['"]([^'"]+)['"]"#).captures(t) {
                    imports.push(c[1].to_string());
                }
            }
        }
        ("python", "import_from_statement") => {
            if let Some(c) = re(&PY_FROM, r"^\s*from\s+(\S+)\s+import").captures(text(n, src)) {
                imports.push(c[1].to_string());
            }
        }
        ("python", "import_statement") => {
            if let Some(c) = re(&PY_IMPORT, r"^\s*import\s+(.+)").captures(text(n, src)) {
                for part in c[1].split(',') {
                    if let Some(m) = part.split_whitespace().next() {
                        imports.push(m.to_string());
                    }
                }
            }
        }
        ("go", "import_spec") => {
            if let Some(c) = re(&GO, r#""([^"]+)""#).captures(text(n, src)) {
                imports.push(c[1].to_string());
            }
        }
        ("rust", "mod_item") => {
            let t = text(n, src);
            if t.trim_end().ends_with(';') {
                if let Some(name) = n.child_by_field_name("name") {
                    imports.push(format!("mod:{}", text(name, src)));
                }
            }
        }
        ("java", "import_declaration") => {
            if let Some(c) = re(&JAVA, r"import\s+(?:static\s+)?([\w.]+)").captures(text(n, src)) {
                imports.push(c[1].to_string());
            }
        }
        ("csharp", "using_directive") => {
            if let Some(c) = re(&CS, r"using\s+(?:static\s+)?([\w.]+)\s*;").captures(text(n, src)) {
                imports.push(c[1].to_string());
            }
        }
        ("c" | "cpp", "preproc_include") => {
            if let Some(c) = re(&INC, r#"#\s*include\s+"([^"]+)""#).captures(text(n, src)) {
                imports.push(c[1].to_string());
            }
        }
        _ => {}
    }
}

const MAX_CHUNK_LINES: usize = 80;
const WINDOW: usize = 60;

/// Chunk by syntax: one chunk per top-level definition (oversized ones are kept whole but their members
/// are also separate symbols); gaps become line-window chunks. Never splits inside a definition.
fn chunk(content: &str, defs: &mut [(usize, usize)]) -> Vec<ChunkMeta> {
    let line_starts: Vec<usize> = std::iter::once(0).chain(content.match_indices('\n').map(|(i, _)| i + 1)).collect();
    let line_of = |byte: usize| match line_starts.binary_search(&byte) {
        Ok(i) => i,
        Err(i) => i - 1,
    };
    let total_lines = line_starts.len();
    defs.sort();
    // top-level = not contained in an earlier kept range
    let mut ranges: Vec<(usize, usize)> = Vec::new(); // line ranges, inclusive 0-based
    let mut last_end_byte = 0usize;
    for &(s, e) in defs.iter() {
        if s < last_end_byte {
            continue;
        }
        ranges.push((line_of(s), line_of(e.saturating_sub(1).max(s))));
        last_end_byte = e;
    }
    let mut chunks: Vec<(usize, usize)> = Vec::new();
    let mut cursor = 0usize;
    let lines: Vec<&str> = content.split('\n').collect();
    let mut push_gap = |from: usize, to: usize, chunks: &mut Vec<(usize, usize)>| {
        let mut s = from;
        while s <= to {
            let e = (s + WINDOW - 1).min(to);
            if lines[s..=e].iter().any(|l| !l.trim().is_empty()) {
                chunks.push((s, e));
            }
            s = e + 1;
        }
    };
    for (s, e) in ranges {
        if s > cursor {
            push_gap(cursor, s - 1, &mut chunks);
        }
        chunks.push((s, e));
        cursor = e + 1;
    }
    if cursor < total_lines {
        push_gap(cursor, total_lines - 1, &mut chunks);
    }
    let _ = MAX_CHUNK_LINES;
    chunks
        .into_iter()
        .map(|(s, e)| {
            let body = lines[s..=e.min(lines.len() - 1)].join("\n");
            ChunkMeta { start: s as u32 + 1, end: e as u32 + 1, hash: blake3::hash(body.as_bytes()).to_hex()[..16].to_string() }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typescript_symbols_imports_refs_and_arrow_functions() {
        let src = "import { alpha } from './a';\nexport class UserService {\n  getById(id: string) { return helper(id); }\n}\nexport const make = () => new UserService();\nfunction helper(x: string) { return x; }\n";
        let p = parse("src/u.ts", src);
        let names: Vec<_> = p.symbols.iter().map(|s| (s.name.as_str(), s.kind.as_str())).collect();
        assert!(names.contains(&("UserService", "class")));
        assert!(names.contains(&("getById", "method")));
        assert!(names.contains(&("make", "function")));
        assert!(names.contains(&("helper", "function")));
        assert_eq!(p.imports, vec!["./a"]);
        assert!(p.refs.contains(&"alpha".to_string()));
        assert!(!p.refs.contains(&"helper".to_string())); // own definitions are not references
    }

    #[test]
    fn python_symbols_and_imports() {
        let p = parse("pkg/m.py", "import os, sys as s\nfrom .util import f\n\nclass A:\n    def m(self):\n        return f()\n\ndef top():\n    pass\n");
        assert!(p.symbols.iter().any(|s| s.name == "A" && s.kind == "class"));
        assert!(p.symbols.iter().any(|s| s.name == "top"));
        assert_eq!(p.imports, vec![".util", "os", "sys"]);
    }

    #[test]
    fn every_required_language_parses() {
        let cases = [
            ("a.go", "package main\nimport \"fmt\"\nfunc Hello() {}\ntype T struct{}\n", "Hello"),
            ("a.rs", "mod util;\nfn run() {}\nstruct S;\n", "run"),
            ("A.java", "import java.util.List;\nclass A { void go() {} }\n", "go"),
            ("A.cs", "using System;\nclass A { void Go() {} }\n", "Go"),
            ("a.c", "#include \"x.h\"\nint main(void) { return 0; }\n", "main"),
            ("a.cpp", "class Foo { public: void bar(); };\nint run() { return 1; }\n", "run"),
            ("a.js", "const f = function () {};\nmodule.exports = require('./x');\n", "f"),
        ];
        for (path, src, want) in cases {
            let p = parse(path, src);
            assert!(p.symbols.iter().any(|s| s.name == want), "{path}: expected symbol {want}, got {:?}", p.symbols);
        }
        assert_eq!(parse("a.go", "package main\nimport \"fmt\"\n").imports, vec!["fmt"]);
        assert_eq!(parse("a.rs", "mod util;\n").imports, vec!["mod:util"]);
        assert_eq!(parse("a.c", "#include \"x.h\"\n#include <stdio.h>\n").imports, vec!["x.h"]);
        assert_eq!(parse("a.js", "const x = require('./x');\n").imports, vec!["./x"]);
    }

    #[test]
    fn chunks_follow_definition_boundaries() {
        let src = "import x from 'x';\n\nfunction a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
        let p = parse("f.ts", src);
        let spans: Vec<_> = p.chunks.iter().map(|c| (c.start, c.end)).collect();
        assert_eq!(spans, vec![(1, 2), (3, 5), (7, 9)]);
    }

    #[test]
    fn unknown_extension_yields_nothing() {
        assert!(parse("x.txt", "hello").symbols.is_empty());
    }
}
