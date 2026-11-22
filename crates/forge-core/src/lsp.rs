use std::io::{self, BufRead};
use std::path::{Path, PathBuf};

/// Encode one LSP message with its Content-Length header.
pub fn encode_frame(body: &str) -> Vec<u8> {
    format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes()
}

/// Read one LSP frame. Returns Ok(None) on clean EOF.
pub fn read_frame<R: BufRead>(r: &mut R) -> io::Result<Option<String>> {
    let mut len: Option<usize> = None;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            len = v.trim().parse().ok();
        }
    }
    let len = len.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing Content-Length"))?;
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    String::from_utf8(buf).map(Some).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Server command and args for a language id, if Forge knows one.
pub fn server_spec(language: &str) -> Option<(&'static str, &'static [&'static str])> {
    match language {
        "typescript" | "javascript" | "typescriptreact" | "javascriptreact" => Some(("typescript-language-server", &["--stdio"])),
        "python" => Some(("pyright-langserver", &["--stdio"])),
        _ => None,
    }
}

/// Find an executable: first in `dirs` (e.g. node_modules/.bin), then on PATH.
pub fn resolve_command(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &[".cmd", ".exe", ".bat"] } else { &[""] };
    let path_dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for dir in dirs.iter().chain(path_dirs.iter()) {
        for ext in exts {
            let cand = dir.join(format!("{name}{ext}"));
            if Path::new(&cand).is_file() {
                return Some(cand);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip_with_multibyte_body() {
        let body = r#"{"jsonrpc":"2.0","method":"x","params":"héllo"}"#;
        let mut bytes = encode_frame(body);
        bytes.extend(encode_frame("{}"));
        let mut r = io::BufReader::new(&bytes[..]);
        assert_eq!(read_frame(&mut r).unwrap().as_deref(), Some(body));
        assert_eq!(read_frame(&mut r).unwrap().as_deref(), Some("{}"));
        assert_eq!(read_frame(&mut r).unwrap(), None);
    }

    #[test]
    fn ignores_extra_headers() {
        let raw = b"Content-Type: application/vscode-jsonrpc\r\ncontent-length: 2\r\n\r\n{}";
        assert_eq!(read_frame(&mut io::BufReader::new(&raw[..])).unwrap().as_deref(), Some("{}"));
    }

    #[test]
    fn missing_length_is_an_error() {
        assert!(read_frame(&mut io::BufReader::new(&b"X: y\r\n\r\n{}"[..])).is_err());
    }

    #[test]
    fn knows_ts_and_python_servers() {
        assert_eq!(server_spec("typescript").unwrap().0, "typescript-language-server");
        assert_eq!(server_spec("python").unwrap().0, "pyright-langserver");
        assert!(server_spec("cobol").is_none());
    }

    #[test]
    fn resolves_from_given_dirs_first() {
        let d = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) { "fake-ls.cmd" } else { "fake-ls" };
        std::fs::write(d.path().join(name), "").unwrap();
        assert!(resolve_command("fake-ls", &[d.path().to_path_buf()]).is_some());
        assert!(resolve_command("definitely-not-installed-xyz", &[]).is_none());
    }
}
