import os from "os";
import path from "path";
import { fileURLToPath } from "url";

export const HOME = os.homedir();
export const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(HOME, "cksoft", "projects");
export const IDEAS_DIR = process.env.IDEAS_DIR || path.join(PROJECTS_DIR, "ideas");
export const OPENCLAW_DIR = process.env.OPENCLAW_HOME || path.join(HOME, ".openclaw");
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TRADE_JOURNAL_FILE = path.resolve(
  MODULE_DIR,
  "../../data/trade-journal.json"
);
