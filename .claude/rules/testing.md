---
paths: ["**/*.test.*", "**/*.spec.*", "__tests__/**/*"]
---
- Mock external network calls; never hit live APIs in unit tests.
- Keep test descriptions concise and test behavior, not implementation details.
