import type { Price } from "./adapters";

export interface PriceParse {
  prices: Record<string, Price>;
  errors: { line: number; message: string }[];
}

/**
 * Prices a user typed, one model per line: `model input output [cache-read]`, in USD per million tokens. The optional last
 * number is what a cache hit costs as a fraction of the input price (default 0.1). Blank lines and lines starting with # are skipped.
 */
export function parsePrices(text: string): PriceParse {
  const prices: Record<string, Price> = {};
  const errors: PriceParse["errors"] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const parts = line.split(/\s+/);
    if (parts.length < 3 || parts.length > 4) return void errors.push({ line: i + 1, message: "expected: model input-price output-price" });
    const nums = parts.slice(1).map(Number);
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) return void errors.push({ line: i + 1, message: "prices must be numbers, zero or more" });
    prices[parts[0]!] = { input: nums[0]!, output: nums[1]!, cacheRead: nums[2] ?? 0.1 };
  });
  return { prices, errors };
}
