// Five-field cron expressions ("minute hour day-of-month month day-of-week"), in the machine's local time.
//   *  any    a,b  a list    a-b  a range    */n or a-b/n  every n    names: jan..dec, sun..sat    @hourly @daily @weekly @monthly @yearly
// When both day-of-month and day-of-week are restricted, a day matches if EITHER does (standard cron).

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>; // 0 = Sunday
  daysAny: boolean;
  weekdaysAny: boolean;
  source: string;
}

const NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const ALIASES: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *" };

function field(raw: string, min: number, max: number, label: string, names: boolean): { set: Set<number>; any: boolean } {
  const set = new Set<number>();
  const num = (t: string): number => {
    const v = names && NAMES[t.toLowerCase()] !== undefined ? NAMES[t.toLowerCase()]! : /^\d+$/.test(t) ? Number(t) : NaN;
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${label}: "${t}" is not a number from ${min} to ${max}`);
    return v;
  };
  for (const part of raw.split(",")) {
    if (!part) throw new Error(`${label}: empty item in "${raw}"`);
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) throw new Error(`${label}: "${part}" has more than one step`);
    let step = 1;
    if (stepText !== undefined) {
      step = /^\d+$/.test(stepText) ? Number(stepText) : NaN;
      if (!(step >= 1)) throw new Error(`${label}: step "${stepText}" must be a whole number of at least 1`);
    }
    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range!.includes("-")) {
      const [a, b] = range!.split("-");
      from = num(a!);
      to = num(b!);
      if (from > to) throw new Error(`${label}: range "${range}" runs backwards`);
    } else {
      from = num(range!);
      to = stepText !== undefined ? max : from; // "5/10" means from 5 to the end, every 10
    }
    for (let v = from; v <= to; v += step) set.add(v);
  }
  return { set, any: raw === "*" || raw.startsWith("*/") };
}

/** Throws an Error with a plain explanation when the expression is not valid. */
export function parseCron(expression: string): Cron {
  const text = ALIASES[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error(`a cron expression has five fields (minute hour day-of-month month day-of-week), got ${parts.length}: "${expression}"`);
  const minutes = field(parts[0]!, 0, 59, "minute", false);
  const hours = field(parts[1]!, 0, 23, "hour", false);
  const days = field(parts[2]!, 1, 31, "day of month", false);
  const months = field(parts[3]!, 1, 12, "month", true);
  const weekdays = field(parts[4]!, 0, 7, "day of week", true);
  if (weekdays.set.has(7)) weekdays.set.add(0); // 7 is Sunday too
  weekdays.set.delete(7);
  return { minutes: minutes.set, hours: hours.set, days: days.set, months: months.set, weekdays: weekdays.set, daysAny: days.any, weekdaysAny: weekdays.any, source: expression.trim() };
}

/** Does the minute that `d` falls in match? (Seconds are ignored.) */
export function cronMatches(c: Cron, d: Date): boolean {
  if (!c.minutes.has(d.getMinutes()) || !c.hours.has(d.getHours()) || !c.months.has(d.getMonth() + 1)) return false;
  const dayOk = c.days.has(d.getDate());
  const weekdayOk = c.weekdays.has(d.getDay());
  if (!c.daysAny && !c.weekdaysAny) return dayOk || weekdayOk;
  return dayOk && weekdayOk;
}

/**
 * The first matching minute strictly after `from`, or null if there is none in the next five years (such as 30 February).
 * Time only ever moves forward, in epoch milliseconds; local calendar fields are read to decide how far to skip, never written back,
 * because an hour that repeats when the clocks go back could otherwise resolve to its first occurrence and send the search backwards.
 */
export function nextRun(c: Cron, from: Date): Date | null {
  const MINUTE = 60_000;
  let t = Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE;
  const limit = from.getTime() + 5 * 366 * 24 * 60 * MINUTE;
  while (t <= limit) {
    const d = new Date(t);
    const dayMatches = !c.daysAny && !c.weekdaysAny ? c.days.has(d.getDate()) || c.weekdays.has(d.getDay()) : c.days.has(d.getDate()) && c.weekdays.has(d.getDay());
    if (!c.months.has(d.getMonth() + 1) || !dayMatches) {
      // Not this day: on to the next local midnight (always later than now, even where a clock change skips midnight).
      t = Math.max(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime(), t + MINUTE);
    } else if (!c.hours.has(d.getHours())) {
      t += (60 - d.getMinutes()) * MINUTE; // not this hour: to the top of the next one
    } else if (!c.minutes.has(d.getMinutes())) {
      t += MINUTE;
    } else {
      return new Date(t);
    }
  }
  return null;
}
