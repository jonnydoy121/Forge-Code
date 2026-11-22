//! Forge core services. Phase 1: filesystem helpers and LSP plumbing.

pub mod fs;
pub mod bg;
pub mod exec;
pub mod git;
pub mod index;
pub mod lsp;
pub mod sandbox;
pub mod secrets;

pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn core_version() -> &'static str {
    CORE_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_version() {
        assert_eq!(core_version(), "0.0.0");
    }
}
