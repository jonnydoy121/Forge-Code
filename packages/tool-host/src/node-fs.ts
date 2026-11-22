import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FsBackend } from "./index";

/** FsBackend over Node fs. Used by tests and any Node-hosted worker. */
export const nodeFs: FsBackend = {
  readFile: (p) => readFile(p, "utf8"),
  readdir: async (p) => (await readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() })),
  writeFile: async (p, c) => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, c, "utf8");
  },
};
