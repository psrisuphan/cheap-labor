/** Directories excluded from directory scans (dependency/build noise). */
export const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "build", ".cache", "target"]);