import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CheckpointFs } from "./index";

/** CheckpointFs / DiskFs over Node fs (tests and any Node-hosted worker). */
export const nodeCheckpointFs: CheckpointFs = {
  read: async (p) => {
    try {
      return await readFile(p, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  },
  write: async (p, c) => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, c, "utf8");
  },
  remove: (p) => rm(p, { force: true }),
  list: async (d) => {
    try {
      return await readdir(d);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  },
};
