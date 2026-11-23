import { describe, expect, it } from "vitest";
import { fileKind, isDimmedFolder } from "./fileKind";

describe("fileKind", () => {
  it("tells apart code, data, docs, styles, markup, images and shell scripts by extension", () => {
    expect(fileKind("app.ts")).toBe("code");
    expect(fileKind("main.rs")).toBe("code");
    expect(fileKind("data.json")).toBe("data");
    expect(fileKind("README.md")).toBe("doc");
    expect(fileKind("site.css")).toBe("style");
    expect(fileKind("index.html")).toBe("markup");
    expect(fileKind("logo.PNG")).toBe("image");
    expect(fileKind("run.sh")).toBe("shell");
  });

  it("recognises tests before code, and lock files and config by name", () => {
    expect(fileKind("app.test.ts")).toBe("test");
    expect(fileKind("app.spec.tsx")).toBe("test");
    expect(fileKind("package-lock.json")).toBe("lock");
    expect(fileKind("Cargo.lock")).toBe("lock");
    expect(fileKind("package.json")).toBe("config");
    expect(fileKind("tsconfig.json")).toBe("config");
    expect(fileKind(".env")).toBe("config");
    expect(fileKind(".env.local")).toBe("config");
    expect(fileKind(".eslintrc.json")).toBe("config");
    expect(fileKind(".forgerules")).toBe("config");
  });

  it("falls back to a generic file for anything else, including odd names", () => {
    for (const n of ["", "LICENSE", "notes", "weird.", ".hidden", "a.unknownext"]) expect(fileKind(n), n).toBe("generic");
  });

  it("dims folders that hold generated or vendored files", () => {
    for (const f of ["node_modules", ".git", "target", "DIST", "__pycache__"]) expect(isDimmedFolder(f), f).toBe(true);
    for (const f of ["src", "docs", "tests", "packages"]) expect(isDimmedFolder(f), f).toBe(false);
  });
});
