import { Router } from "express";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { PROJECTS_DIR, getOpenclawDir } from "../services/paths.js";

const execFileAsync = promisify(execFile);

export const statsRouter = Router();

// 30-second in-memory cache
let statsCache: { data: unknown; ts: number } | null = null;
const CACHE_TTL = 30_000;

// Exported for testing — allows clearing the cache between tests
export function clearStatsCache() {
  statsCache = null;
}

statsRouter.get("/", async (_req, res) => {
  try {
    // Return cached data if fresh
    if (statsCache && Date.now() - statsCache.ts < CACHE_TTL) {
      return res.json(statsCache.data);
    }

    const OPENCLAW_DIR = getOpenclawDir();
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const monthStr = now.toISOString().slice(0, 7);

    let costToday = 0;
    let costMonth = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let sessionsToday = 0;
    const dayMap = new Map<string, number>();

    // Read session JSONL files from all agent directories
    const agentsDir = path.join(OPENCLAW_DIR, "agents");
    let agentDirs: string[] = [];
    try {
      agentDirs = await fs.readdir(agentsDir);
    } catch { /* no agents dir */ }

    for (const agent of agentDirs) {
      const sessionsDir = path.join(agentsDir, agent, "sessions");
      let sessionFiles: string[] = [];
      try {
        sessionFiles = (await fs.readdir(sessionsDir)).filter(
          (f) => f.endsWith(".jsonl") && !f.endsWith(".deleted")
        );
      } catch {
        continue;
      }

      for (const file of sessionFiles) {
        const filePath = path.join(sessionsDir, file);
        let hasToday = false;
        try {
          const content = await fs.readFile(filePath, "utf-8");
          for (const line of content.split("\n")) {
            if (!line) continue;
            try {
              const entry = JSON.parse(line);
              const ts: string = entry.timestamp || "";
              const date = ts.slice(0, 10);

              if (entry.type !== "message" || !entry.message?.usage) continue;

              const usage = entry.message.usage;
              const inTok = usage.input || 0;
              const outTok = usage.output || 0;
              const cost = usage.cost?.total || 0;

              if (date === todayStr) {
                tokensIn += inTok;
                tokensOut += outTok;
                costToday += cost;
                hasToday = true;
              }
              if (date.startsWith(monthStr)) {
                costMonth += cost;
              }
              dayMap.set(date, (dayMap.get(date) || 0) + cost);
            } catch { /* skip bad lines */ }
          }
        } catch { /* skip unreadable files */ }

        if (hasToday) sessionsToday++;
      }
    }

    // Build last 14 days array
    const dailyCosts: { date: string; cost: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      dailyCosts.push({ date: ds, cost: Math.round((dayMap.get(ds) || 0) * 100) / 100 });
    }

    // Get uptime from systemd (user service)
    let uptime = "";
    try {
      const { stdout } = await execFileAsync("systemctl", [
        "--user", "show", "openclaw-gateway", "--property=ActiveEnterTimestamp",
      ]);
      const match = stdout.match(/=(.+)/);
      if (match) {
        const started = new Date(match[1]);
        const diff = Date.now() - started.getTime();
        const days = Math.floor(diff / 86400000);
        const hours = Math.floor((diff % 86400000) / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);
        uptime = days > 0 ? `${days}d ${hours}h` : `${hours}h ${mins}m`;
      }
    } catch {
      uptime = "N/A";
    }

    // Active errors check
    let activeErrors = 0;

    // 1. Gateway not running
    try {
      const { stdout } = await execFileAsync("systemctl", [
        "--user", "is-active", "openclaw-gateway",
      ]);
      if (stdout.trim() !== "active") activeErrors++;
    } catch {
      activeErrors++; // is-active returns non-zero for inactive
    }

    // 2. Auth profiles in cooldown
    try {
      const authPath = path.join(OPENCLAW_DIR, "agents", "agent-scully", "agent", "auth-profiles.json");
      const authData = JSON.parse(await fs.readFile(authPath, "utf-8"));
      const stats = authData.usageStats || {};
      const nowMs = Date.now();
      for (const key of Object.keys(stats)) {
        const s = stats[key];
        if ((s.cooldownUntil && s.cooldownUntil > nowMs) ||
            (s.disabledUntil && s.disabledUntil > nowMs)) {
          activeErrors++;
        }
      }
    } catch { /* no auth profiles */ }

    // 3. Deploy failures
    try {
      const lastRunPath = path.join(PROJECTS_DIR, "command-center", "tests", "last-run.json");
      const lastRun = JSON.parse(await fs.readFile(lastRunPath, "utf-8"));
      if (lastRun.passed === false) activeErrors++;
    } catch { /* no test results */ }

    const data = {
      uptime,
      sessionsToday,
      costToday: Math.round(costToday * 100) / 100,
      costMonth: Math.round(costMonth * 100) / 100,
      tokensIn,
      tokensOut,
      activeErrors,
      dailyCosts,
    };

    // Cache the result
    statsCache = { data, ts: Date.now() };

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to get stats" });
  }
});
