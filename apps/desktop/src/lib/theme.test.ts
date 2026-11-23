import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");
const block = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  return css.slice(start, css.indexOf("\n}", start));
};
const vars = (selector: string) => Object.fromEntries([...block(selector).matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]));

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const lum = (hex: string) => {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** `fg` at `alpha` over `base`, as a hex colour (how a translucent background looks). */
const over = (fg: string, alpha: number, base: string) => "#" + rgb(fg).map((v, i) => Math.round(v * alpha + rgb(base)[i]! * (1 - alpha)).toString(16).padStart(2, "0")).join("");

describe("light theme contrast", () => {
  const light = vars(".light");
  // The status colors components use as text (text-red-400 and so on), as remapped for the light theme.
  const textColors = ["color-red-200", "color-red-300", "color-red-400", "color-green-400", "color-amber-200", "color-amber-300", "color-amber-400", "color-blue-400"];

  it("defines every remapped status color", () => {
    for (const name of textColors) expect(light[name], name).toBeDefined();
  });

  it.each(textColors)("%s is readable (4.5:1) on the light page and panel backgrounds", (name) => {
    expect(contrast(light[name]!, light["bg"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light[name]!, light["panel"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("amber text stays readable on the tinted pending-changes banner", () => {
    const banner = over(light["color-amber-900"]!, 0.3, light["bg"]!);
    expect(contrast(light["color-amber-200"]!, banner)).toBeGreaterThanOrEqual(4.5);
  });

  it("body text and muted text are readable on the light backgrounds", () => {
    expect(contrast(light["fg"]!, light["bg"]!)).toBeGreaterThanOrEqual(7);
    expect(contrast(light["muted"]!, light["bg"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light["muted"]!, light["hover"]!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("dark theme contrast", () => {
  const dark = vars(":root");
  it("body text and muted text are readable on the dark backgrounds", () => {
    expect(contrast(dark["fg"]!, dark["bg"]!)).toBeGreaterThanOrEqual(7);
    expect(contrast(dark["muted"]!, dark["bg"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark["muted"]!, dark["hover"]!)).toBeGreaterThanOrEqual(4.5);
  });
});
