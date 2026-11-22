import { describe, expect, it } from "vitest";
import { containsSecret, globToRegExp, isSecretPath, redactSecrets, resolveInRoot } from "../src";

describe("resolveInRoot", () => {
  it("resolves relative paths and normalizes separators", () => {
    expect(resolveInRoot(String.raw`C:\ws`, String.raw`src\a.ts`)).toBe("C:/ws/src/a.ts");
    expect(resolveInRoot("/ws", "./a/../b.ts")).toBe("/ws/b.ts");
  });
  it("rejects escapes, including absolute paths outside", () => {
    expect(() => resolveInRoot("/ws", "../etc/passwd")).toThrow("escapes");
    expect(() => resolveInRoot("/ws", "/etc/passwd")).toThrow("escapes");
    expect(() => resolveInRoot("/ws", "/ws-evil/x")).toThrow("escapes");
  });
});

describe("isSecretPath", () => {
  it("flags env files and keys but not examples", () => {
    for (const p of [".env", "a/.env.local", "k.pem", "id_rsa", "credentials.json"]) expect(isSecretPath(p)).toBe(true);
    for (const p of [".env.example", "src/env.ts", "README.md"]) expect(isSecretPath(p)).toBe(false);
  });
});

describe("globToRegExp", () => {
  it("matches common patterns", () => {
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/**/*.tsx").test("src/components/x/A.tsx")).toBe(true);
    expect(globToRegExp("src/**/*.tsx").test("server/A.tsx")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
  });
});

describe("secret redaction", () => {
  it("redacts keys and assignments but leaves normal code", () => {
    const t = 'const apiKey = "abcd1234efgh5678"; // sk-ant-api03-abcdefghijklmnopqrstuvwx\nconst n = 5;';
    expect(containsSecret(t)).toBe(true);
    const r = redactSecrets(t);
    expect(r).not.toContain("abcd1234efgh5678");
    expect(r).not.toContain("sk-ant");
    expect(r).toContain("const n = 5;");
    expect(containsSecret("const n = 5;")).toBe(false);
  });
});
