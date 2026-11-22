import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DiskFs } from "@forge/review";
import type { FsBackend } from "@forge/tool-host";

/** Disk access for the review model: missing file = null. */
export const diskFs: DiskFs = {
  read: async (p) => {
    try {
      return await readFile(p, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  },
  write: async (p, content) => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, "utf8");
  },
  remove: (p) => rm(p, { force: true }),
};

/** Saved prompts (.forge/prompts): file names in a folder, and file contents. */
export const promptFs = {
  read: diskFs.read,
  list: (dir: string) => readdir(dir),
};

/** What the read tools (read_file, ls, grep) see. */
export const toolFs: FsBackend = {
  readFile: (p) => readFile(p, "utf8"),
  readdir: async (p) => (await readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() })),
};
