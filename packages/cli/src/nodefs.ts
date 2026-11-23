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

/** Saved prompts, skills and rules: file names in a folder, and file contents. A folder that does not exist is simply empty (most repos have no .forge/rules). */
export const promptFs = {
  read: diskFs.read,
  list: async (dir: string) => {
    try {
      return await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return [];
      throw e;
    }
  },
};

/** What the read tools (read_file, ls, grep) see. */
export const toolFs: FsBackend = {
  readFile: (p) => readFile(p, "utf8"),
  readdir: async (p) => (await readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() })),
};
