import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The top of the git working tree that holds a path, or null if none does.
 * The path need not exist yet: its nearest existing folder is asked.
 */
export function insideGitRepository(target: string): string | null {
  let dir = path.resolve(target);
  while (!existsSync(dir)) dir = path.dirname(dir);
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
