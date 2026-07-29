import path from "node:path";

import { ensureGitRepository } from "./git.mjs";

const workspaceCache = new Map();

export function resolveWorkspaceRoot(cwd) {
  const key = path.resolve(cwd);
  if (workspaceCache.has(key)) {
    return workspaceCache.get(key);
  }
  let workspaceRoot;
  try {
    workspaceRoot = ensureGitRepository(key);
  } catch {
    workspaceRoot = key;
  }
  workspaceCache.set(key, workspaceRoot);
  return workspaceRoot;
}
