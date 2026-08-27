import os from "os";
import path from "path";
import { fileURLToPath } from "url";

export const HOME = os.homedir();

function resolveEnvPath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;

  if (value === "~") return HOME;
  if (value.startsWith("~/")) return path.join(HOME, value.slice(2));
  if (value === "$HOME") return HOME;
  if (value.startsWith("$HOME/")) return path.join(HOME, value.slice(6));

  return value;
}

export const PROJECTS_DIR = resolveEnvPath(
  process.env.PROJECTS_DIR,
  path.join(HOME, "cksoft", "projects")
);
export const IDEAS_DIR = resolveEnvPath(
  process.env.IDEAS_DIR,
  path.join(PROJECTS_DIR, "ideas")
);
export const OPENCLAW_DIR = resolveEnvPath(
  process.env.OPENCLAW_HOME,
  path.join(HOME, ".openclaw")
);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TRADE_JOURNAL_FILE = path.resolve(
  MODULE_DIR,
  "../../data/trade-journal.json"
);
