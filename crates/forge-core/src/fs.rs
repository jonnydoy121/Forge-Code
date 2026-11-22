use serde::Serialize;
use std::io;
use std::path::Path;

/// Directories hidden from the file tree (heavy or generated).
const HIDDEN_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next"];

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// List one directory: folders first, then files, each sorted case-insensitively.
pub fn list_dir(dir: &Path) -> io::Result<Vec<DirEntry>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type()?.is_dir();
        if is_dir && HIDDEN_DIRS.contains(&name.as_str()) {
            continue;
        }
        out.push(DirEntry { name, path: entry.path().to_string_lossy().into_owned(), is_dir });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// Read a UTF-8 text file. Refuses files over 10 MiB or containing NUL bytes (binary).
pub fn read_text(path: &Path) -> io::Result<String> {
    let bytes = std::fs::read(path)?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "file too large (over 10 MiB)"));
    }
    if bytes.contains(&0) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "binary file"));
    }
    String::from_utf8(bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "not valid UTF-8"))
}

/// Read a text file, or None if it does not exist.
pub fn read_text_opt(path: &Path) -> io::Result<Option<String>> {
    match read_text(path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Remove a file; succeeds if it is already gone.
pub fn remove_file(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Names of entries in a directory (empty if it does not exist).
pub fn list_names(dir: &Path) -> io::Result<Vec<String>> {
    match std::fs::read_dir(dir) {
        Ok(rd) => Ok(rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e),
    }
}

/// Write atomically: write a sibling temp file, then rename over the target.
pub fn write_text(path: &Path, contents: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("{}.forge-tmp", path.extension().and_then(|e| e.to_str()).unwrap_or("")));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_folders_first_and_hides_heavy_dirs() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("src")).unwrap();
        std::fs::create_dir(d.path().join("node_modules")).unwrap();
        std::fs::write(d.path().join("b.txt"), "").unwrap();
        std::fs::write(d.path().join("A.txt"), "").unwrap();
        let names: Vec<_> = list_dir(d.path()).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["src", "A.txt", "b.txt"]);
    }

    #[test]
    fn write_then_read_roundtrip_leaves_no_temp_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.ts");
        write_text(&p, "one").unwrap();
        write_text(&p, "two").unwrap();
        assert_eq!(read_text(&p).unwrap(), "two");
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1);
    }

    #[test]
    fn write_creates_parent_dirs_and_missing_reads_are_none() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a/b/c.ts");
        assert_eq!(read_text_opt(&p).unwrap(), None);
        write_text(&p, "x").unwrap();
        assert_eq!(read_text_opt(&p).unwrap().as_deref(), Some("x"));
        remove_file(&p).unwrap();
        remove_file(&p).unwrap(); // idempotent
        assert_eq!(list_names(&d.path().join("nope")).unwrap(), Vec::<String>::new());
        assert_eq!(list_names(&d.path().join("a")).unwrap(), ["b"]);
    }

    #[test]
    fn rejects_binary_files() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("x.bin");
        std::fs::write(&p, [1, 0, 2]).unwrap();
        assert!(read_text(&p).is_err());
    }
}
