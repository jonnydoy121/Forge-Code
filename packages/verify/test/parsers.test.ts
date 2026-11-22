import { describe, expect, it } from "vitest";
import { formatError, parseOutput, stripAnsi, tail } from "../src";

// Samples below are captured from real tool runs unless noted.

const TSC = String.raw`src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.ts(10,3): error TS2304: Cannot find name 'foo'.`;

const ESLINT = String.raw`C:\Users\me\proj\tmp-bad.js
  1:5   error    'unused' is assigned a value but never used  @typescript-eslint/no-unused-vars
  7:1   warning  Unexpected console statement                 no-console

✖ 2 problems (1 error, 1 warning)`;

const CARGO = String.raw`   Compiling s v0.1.0 (C:\Users\me\cargosample)
error[E0308]: mismatched types
 --> src\main.rs:1:26
  |
1 | fn main() { let x: i32 = "a"; undefined_fn(); }
  |                    ---   ^^^ expected ` + "`i32`, found `&str`" + String.raw`

error[E0425]: cannot find function ` + "`undefined_fn`" + String.raw` in this scope
 --> src\main.rs:1:31

error: could not compile ` + "`s`" + ` (bin "s") due to 2 previous errors`;

const NODE_TEST = String.raw`✖ adds numbers (0.6564ms)
ℹ tests 1
ℹ fail 1

✖ failing tests:

test at sum.test.js:4:1
✖ adds numbers (0.6564ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  -1 !== 3

      at TestContext.<anonymous> (file:///C:/Users/me/samples/sum.test.js:4:37)
      at Test.runInAsyncScope (node:async_hooks:226:14) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: -1,
    expected: 3,
    operator: 'strictEqual',
  }`;

const PYTEST = `=================================== FAILURES ===================================
tests/test_calc.py:12: AssertionError
=========================== short test summary info ============================
FAILED tests/test_calc.py::test_add - AssertionError: assert 1 == 2
FAILED tests/test_calc.py::test_sub`;

const VITEST = ` FAIL  src/user.test.ts > UserService > getById
AssertionError: expected 'a' to be 'b' // Object.is equality
 ❯ src/user.test.ts:14:22
    12|   const u = svc.getById('1');
 ❯ src/user.test.ts:14:22`;

const GO = `--- FAIL: TestAdd (0.00s)
    calc_test.go:12: got 1, want 2
FAIL
FAIL	example.com/calc	0.004s`;

const RUFF = `pkg/mod.py:3:8: F401 'os' imported but unused
pkg/mod.py:9:1: E302 expected 2 blank lines, found 1`;

const TRACEBACK = `Traceback (most recent call last):
  File "main.py", line 7, in <module>
    run()
  File "/app/run.py", line 3, in run
    1/0
ZeroDivisionError: division by zero`;

describe("parseOutput", () => {
  it("parses tsc output and deduplicates repeated diagnostics", () => {
    const { errors } = parseOutput(TSC);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ file: "src/a.ts", line: 1, col: 7, rule: "TS2322", severity: "error" });
    expect(errors[1]).toMatchObject({ file: "src/b.ts", line: 10, rule: "TS2304" });
  });

  it("parses eslint stylish output with rules, severities, and normalised Windows paths", () => {
    const { errors } = parseOutput(ESLINT);
    expect(errors.map((e) => [e.file, e.line, e.rule, e.severity])).toEqual([
      ["C:/Users/me/proj/tmp-bad.js", 1, "@typescript-eslint/no-unused-vars", "error"],
      ["C:/Users/me/proj/tmp-bad.js", 7, "no-console", "warning"], // warnings sort after errors
    ]);
  });

  it("parses cargo errors with their locations and drops the summary line", () => {
    const { errors } = parseOutput(CARGO);
    expect(errors.map((e) => [e.rule, e.file, e.line, e.col])).toEqual([
      ["E0308", "src/main.rs", 1, 26],
      ["E0425", "src/main.rs", 1, 31],
    ]);
  });

  it("parses the node:test spec reporter into a failing test with location, message and values", () => {
    const { errors } = parseOutput(NODE_TEST);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ test: "adds numbers", file: "sum.test.js", line: 4 });
    expect(errors[0]!.message).toContain("Expected values to be strictly equal");
    expect(errors[0]!.message).toContain("-1 !== 3");
    expect(errors[0]!.message).toContain("actual -1, expected 3");
    expect(errors[0]!.stack).toContain("sum.test.js:4:37");
  });

  it("parses pytest failures with the line of the failing assertion", () => {
    const { errors } = parseOutput(PYTEST);
    expect(errors.map((e) => [e.file, e.test, e.line, e.message])).toEqual([
      ["tests/test_calc.py", "test_add", 12, "AssertionError: assert 1 == 2"],
      ["tests/test_calc.py", "test_sub", 12, "test failed"],
    ]);
  });

  it("parses vitest/jest failures", () => {
    const { errors } = parseOutput(VITEST);
    expect(errors[0]).toMatchObject({ file: "src/user.test.ts", test: "UserService > getById", line: 14 });
    expect(errors[0]!.message).toContain("expected 'a' to be 'b'");
  });

  it("parses go test failures", () => {
    expect(parseOutput(GO).errors).toEqual([expect.objectContaining({ test: "TestAdd", file: "calc_test.go", line: 12, message: "got 1, want 2" })]);
  });

  it("parses ruff/flake8 style lines and python tracebacks", () => {
    expect(parseOutput(RUFF).errors.map((e) => [e.file, e.line, e.col, e.rule])).toEqual([
      ["pkg/mod.py", 3, 8, "F401"],
      ["pkg/mod.py", 9, 1, "E302"],
    ]);
    expect(parseOutput(TRACEBACK).errors[0]).toMatchObject({ file: "/app/run.py", line: 3, message: "ZeroDivisionError: division by zero" });
  });

  it("strips ANSI colour codes before parsing", () => {
    const { errors } = parseOutput("\u001b[31msrc/a.ts(1,7): error TS2322: bad\u001b[39m");
    expect(errors[0]).toMatchObject({ file: "src/a.ts", rule: "TS2322" });
    expect(stripAnsi("\u001b[1mhi\u001b[0m")).toBe("hi");
  });

  it("caps the error count and reports how many were omitted; truncates huge messages", () => {
    const many = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts(1,1): error TS1000: ${"x".repeat(1000)}`).join("\n");
    const { errors, omitted } = parseOutput(many);
    expect(errors).toHaveLength(40);
    expect(omitted).toBe(60);
    expect(errors[0]!.message.length).toBeLessThanOrEqual(401);
  });

  it("returns nothing for unparseable output so callers can fall back to the tail", () => {
    expect(parseOutput("something went wrong\nbut no locations").errors).toEqual([]);
    expect(tail("a".repeat(5000), 100).length).toBe(101);
  });
});

describe("formatError", () => {
  it("renders location, rule, test and message compactly", () => {
    expect(formatError({ file: "a.ts", line: 3, col: 4, rule: "TS1", message: "bad", severity: "error" })).toBe("a.ts:3:4 [TS1] bad");
    expect(formatError({ test: "adds", message: "wrong", severity: "error" })).toBe("(adds) wrong");
  });
});
