//! Forge core services (indexer, sandbox, checkpoints). Phase 0: version probe only.

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
