import { describe, expect, it } from "vitest";
import { cronMatches, nextRun, parseCron } from "../src/cron";

// Dates are built from local-time parts, so the tests mean the same thing in any time zone.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const matches = (expr: string, d: Date) => cronMatches(parseCron(expr), d);

describe("parseCron", () => {
  it("accepts wildcards, lists, ranges and steps", () => {
    expect(matches("* * * * *", at(2026, 3, 4, 5, 6))).toBe(true);
    expect(matches("30 2 * * *", at(2026, 3, 4, 2, 30))).toBe(true);
    expect(matches("30 2 * * *", at(2026, 3, 4, 2, 31))).toBe(false);
    expect(matches("0,15,30,45 * * * *", at(2026, 3, 4, 9, 45))).toBe(true);
    expect(matches("0,15,30,45 * * * *", at(2026, 3, 4, 9, 46))).toBe(false);
    expect(matches("0 9-17 * * *", at(2026, 3, 4, 17, 0))).toBe(true);
    expect(matches("0 9-17 * * *", at(2026, 3, 4, 18, 0))).toBe(false);
    expect(matches("*/20 * * * *", at(2026, 3, 4, 1, 40))).toBe(true);
    expect(matches("*/20 * * * *", at(2026, 3, 4, 1, 30))).toBe(false);
    expect(matches("10-50/20 * * * *", at(2026, 3, 4, 1, 30))).toBe(true); // 10, 30, 50
    expect(matches("10-50/20 * * * *", at(2026, 3, 4, 1, 20))).toBe(false);
    expect(matches("5/20 * * * *", at(2026, 3, 4, 1, 45))).toBe(true); // 5, 25, 45
  });

  it("understands month and weekday names and the @ shortcuts, and 7 as Sunday", () => {
    expect(matches("0 0 1 jan *", at(2026, 1, 1))).toBe(true);
    expect(matches("0 0 1 jan *", at(2026, 2, 1))).toBe(false);
    expect(matches("0 8 * * mon-fri", at(2026, 3, 2, 8, 0))).toBe(true); // 2 March 2026 is a Monday
    expect(matches("0 8 * * mon-fri", at(2026, 3, 1, 8, 0))).toBe(false); // Sunday
    expect(matches("0 8 * * 7", at(2026, 3, 1, 8, 0))).toBe(true);
    expect(matches("0 8 * * 0", at(2026, 3, 1, 8, 0))).toBe(true);
    expect(matches("@daily", at(2026, 3, 4, 0, 0))).toBe(true);
    expect(matches("@hourly", at(2026, 3, 4, 7, 0))).toBe(true);
    expect(matches("@hourly", at(2026, 3, 4, 7, 1))).toBe(false);
    expect(matches("@weekly", at(2026, 3, 1, 0, 0))).toBe(true); // Sunday midnight
    expect(matches("@monthly", at(2026, 3, 1, 0, 0))).toBe(true);
    expect(matches("@yearly", at(2026, 1, 1, 0, 0))).toBe(true);
  });

  it("when both the day of the month and the day of the week are given, either one matches (standard cron)", () => {
    // the 13th, or any Friday
    expect(matches("0 0 13 * fri", at(2026, 3, 13))).toBe(true); // Friday the 13th
    expect(matches("0 0 13 * fri", at(2026, 3, 6))).toBe(true); // a Friday, not the 13th
    expect(matches("0 0 13 * fri", at(2026, 4, 13))).toBe(true); // the 13th, a Monday
    expect(matches("0 0 13 * fri", at(2026, 3, 12))).toBe(false);
    // one of them restricted, the other "any": both must hold
    expect(matches("0 0 13 * *", at(2026, 3, 13))).toBe(true);
    expect(matches("0 0 * * fri", at(2026, 3, 13))).toBe(true);
    // `*/2` counts as "any" for this rule, so both fields must hold: a Friday that is also an odd-numbered day
    expect(matches("0 0 */2 * fri", at(2026, 3, 13))).toBe(true); // Friday the 13th
    expect(matches("0 0 */2 * fri", at(2026, 3, 6))).toBe(false); // a Friday, but day 6 is even
  });

  it("explains what is wrong with an invalid expression", () => {
    const bad = (e: string) => {
      try {
        parseCron(e);
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    };
    expect(bad("* * * *")).toContain("five fields");
    expect(bad("* * * * * *")).toContain("five fields");
    expect(bad("60 * * * *")).toContain('minute: "60"');
    expect(bad("* 24 * * *")).toContain("hour");
    expect(bad("* * 0 * *")).toContain("day of month");
    expect(bad("* * * 13 *")).toContain("month");
    expect(bad("* * * * 8")).toContain("day of week");
    expect(bad("*/0 * * * *")).toContain("step");
    expect(bad("5-1 * * * *")).toContain("backwards");
    expect(bad("a * * * *")).toContain("not a number");
    expect(bad("1,,2 * * * *")).toContain("empty item");
    expect(bad("*/2/3 * * * *")).toContain("more than one step");
    expect(bad("")).toContain("five fields");
  });
});

describe("nextRun", () => {
  it("finds the next matching minute, strictly after the given time", () => {
    const c = parseCron("30 2 * * *");
    expect(nextRun(c, at(2026, 3, 4, 1, 0))).toEqual(at(2026, 3, 4, 2, 30));
    expect(nextRun(c, at(2026, 3, 4, 2, 30))).toEqual(at(2026, 3, 5, 2, 30)); // strictly after
    expect(nextRun(c, at(2026, 3, 4, 2, 31))).toEqual(at(2026, 3, 5, 2, 30));
    expect(nextRun(parseCron("*/15 * * * *"), at(2026, 3, 4, 10, 7))).toEqual(at(2026, 3, 4, 10, 15));
  });

  it("crosses month and year ends, weekdays and leap days", () => {
    expect(nextRun(parseCron("0 0 1 * *"), at(2026, 12, 15))).toEqual(at(2027, 1, 1));
    expect(nextRun(parseCron("0 9 * * mon"), at(2026, 3, 4, 10, 0))).toEqual(at(2026, 3, 9, 9, 0)); // the next Monday
    expect(nextRun(parseCron("0 0 29 feb *"), at(2026, 3, 1))).toEqual(at(2028, 2, 29)); // the next leap day
  });

  it("agrees with cronMatches for a spread of expressions: the result matches and nothing earlier does", () => {
    const from = at(2026, 6, 15, 12, 34);
    for (const expr of ["*/7 */3 * * *", "0 0 13 * fri", "15 4 1,15 * *", "0 22 * * 1-5", "59 23 31 12 *"]) {
      const c = parseCron(expr);
      const n = nextRun(c, from)!;
      expect(n, expr).not.toBeNull();
      expect(cronMatches(c, n), expr).toBe(true);
      for (let ms = from.getTime() + 60_000; ms < n.getTime(); ms += 60_000) {
        const m = new Date(ms);
        if (m.getSeconds() === 0 && cronMatches(c, m)) throw new Error(`${expr}: ${m.toString()} matches but ${n.toString()} was returned`);
      }
    }
  });

  it("is null for a date that never happens", () => {
    expect(nextRun(parseCron("0 0 30 feb *"), at(2026, 1, 1))).toBeNull();
  });
});

describe("when the clocks change", () => {
  /** Run `fn` with the process in another time zone (and check it took effect: a test that silently ran in UTC would prove nothing). */
  const inZone = (tz: string, fn: () => void) => {
    const before = process.env.TZ;
    process.env.TZ = tz;
    try {
      fn();
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  };

  it("never goes backwards when the clocks go back and an hour repeats, even when starting inside the repeated hour", () => {
    inZone("Europe/London", () => {
      const firstOneThirty = new Date(Date.UTC(2026, 9, 25, 0, 30)); // 01:30 BST, then the clocks go back...
      const secondOneThirty = new Date(Date.UTC(2026, 9, 25, 1, 30)); // ...and it is 01:30 GMT
      expect(firstOneThirty.getTimezoneOffset()).not.toBe(secondOneThirty.getTimezoneOffset()); // the zone really applies
      expect(firstOneThirty.getHours()).toBe(secondOneThirty.getHours());

      const every10 = parseCron("*/10 * * * *");
      const from = new Date(Date.UTC(2026, 9, 25, 1, 35)); // inside the second 01:xx
      const next = nextRun(every10, from)!;
      expect(next.getTime()).toBeGreaterThan(from.getTime()); // not an hour in the past
      expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(10 * 60_000);

      // A long search that passes through the change finishes, and still lands on the right day.
      const nye = nextRun(parseCron("59 23 31 12 *"), new Date(Date.UTC(2026, 5, 15, 12, 0)))!;
      expect([nye.getFullYear(), nye.getMonth() + 1, nye.getDate(), nye.getHours(), nye.getMinutes()]).toEqual([2026, 12, 31, 23, 59]);
    });
  });

  it("runs a job at 01:xx during the repeated hour at least once, and every run found is later than the one before", () => {
    inZone("Europe/London", () => {
      const c = parseCron("*/30 1 * * *");
      let t = new Date(Date.UTC(2026, 9, 24, 12, 0));
      const found: number[] = [];
      for (let i = 0; i < 6; i++) {
        const n = nextRun(c, t)!;
        expect(n.getTime()).toBeGreaterThan(t.getTime());
        found.push(n.getTime());
        t = n;
      }
      expect(found.every((ms, i) => i === 0 || ms > found[i - 1]!)).toBe(true);
    });
  });

  it("skips a time that does not exist when the clocks go forward, and runs the next day", () => {
    // New York, 8 March 2026: 02:00 becomes 03:00, so 02:30 does not exist that day.
    inZone("America/New_York", () => {
      const next = nextRun(parseCron("30 2 * * *"), new Date(Date.UTC(2026, 2, 7, 18, 0)))!;
      expect([next.getMonth() + 1, next.getDate(), next.getHours(), next.getMinutes()]).toEqual([3, 9, 2, 30]);
    });
    // London, 29 March 2026: 01:00 becomes 02:00, so 01:30 does not exist that day.
    inZone("Europe/London", () => {
      const next = nextRun(parseCron("30 1 * * *"), new Date(Date.UTC(2026, 2, 28, 12, 0)))!;
      expect([next.getMonth() + 1, next.getDate(), next.getHours(), next.getMinutes()]).toEqual([3, 30, 1, 30]);
    });
  });

  it("behaves the same in a zone far from London (New York, Sydney)", () => {
    for (const tz of ["America/New_York", "Australia/Sydney"]) {
      inZone(tz, () => {
        const c = parseCron("0 9 * * mon-fri");
        let t = new Date(Date.UTC(2026, 0, 1));
        for (let i = 0; i < 400; i++) {
          const n = nextRun(c, t)!;
          expect(n.getTime(), `${tz} run ${i}`).toBeGreaterThan(t.getTime());
          expect([n.getHours(), n.getMinutes()], tz).toEqual([9, 0]);
          expect(n.getDay(), tz).toBeGreaterThanOrEqual(1);
          expect(n.getDay(), tz).toBeLessThanOrEqual(5);
          t = n;
        }
      });
    }
  });
});
