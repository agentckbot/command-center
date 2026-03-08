import os from "os";
import path from "path";

export const HOME = os.homedir();

export function getProjectsDir(): string {
  return process.env.PROJECTS_DIR || path.join(HOME, "projects");
}

export function getIdeasDir(): string {
  return process.env.IDEAS_DIR || path.join(getProjectsDir(), "ideas");
}

export function getOpenclawDir(): string {
  return process.env.OPENCLAW_HOME || path.join(HOME, ".openclaw");
}

// Convenience constants for backwards compatibility (evaluated at import time)
export const PROJECTS_DIR = getProjectsDir();
export const IDEAS_DIR = getIdeasDir();
export const OPENCLAW_DIR = getOpenclawDir();
