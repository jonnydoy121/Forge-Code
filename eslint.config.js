import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/target/**", "**/node_modules/**", "**/src-tauri/**", "**/playwright-report/**", "**/test-results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node scripts that stand in for external servers and agents in tests.
    files: ["**/fixtures/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", setTimeout: "readonly" } },
  },
);
