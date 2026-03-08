import os from "os";
import path from "path";

export const HOME = os.homedir();
export const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(HOME, "projects");
export const IDEAS_DIR = process.env.IDEAS_DIR || path.join(PROJECTS_DIR, "ideas");
export const OPENCLAW_DIR = process.env.OPENCLAW_HOME || path.join(HOME, ".openclaw");
