import { Router } from "express";
import fs from "fs/promises";
import path from "path";
import { getOpenclawDir } from "../services/paths.js";

export const modelStatusRouter = Router();

// 30-second in-memory cache
let cache: { data: unknown; ts: number } | null = null;
const CACHE_TTL = 30_000;

export function clearModelStatusCache() {
  cache = null;
}

interface AliasEntry {
  alias?: string;
  [key: string]: unknown;
}

interface UsageStatEntry {
  lastUsed?: number;
  errorCount?: number;
  lastFailureAt?: number;
  cooldownUntil?: number;
  disabledUntil?: number;
}

interface FallbackChainItem {
  model: string;
  alias: string;
  provider: string;
  status: "active" | "cooldown" | "ready";
  cooldownUntil?: string;
  cooldownRemaining?: number;
}

interface HistoryEntry {
  time: string;
  model: string;
  alias: string;
  reason: string;
  level: "primary" | "fallback";
  duration?: number;
}

function extractProvider(model: string): string {
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) return "openai";
  if (model.toLowerCase().includes("deepseek")) return "deepseek";
  if (model.toLowerCase().includes("kimi")) return "moonshot";
  if (model.toLowerCase().includes("gemini")) return "google";
  return "unknown";
}

function providerFromChainKey(key: string): string {
  // Config fallback chain keys look like "anthropic:claude-sonnet-4-6" or just "claude-sonnet-4-6"
  if (key.includes(":")) return key.split(":")[0];
  return extractProvider(key);
}

function modelFromChainKey(key: string): string {
  if (key.includes(":")) return key.split(":").slice(1).join(":");
  return key;
}

function buildAlias(model: string, aliases: Record<string, AliasEntry>): string {
  // Check aliases map for a matching entry
  for (const [key, entry] of Object.entries(aliases)) {
    if (entry.alias && (key === model || modelFromChainKey(key) === model)) {
      return entry.alias;
    }
  }
  // Generate a short alias from model name
  if (model.includes("opus")) return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku")) return "Haiku";
  if (model.includes("gpt-4")) return "GPT-4.1";
  if (model.toLowerCase().includes("deepseek")) return "DeepSeek";
  if (model.toLowerCase().includes("kimi")) return "Kimi";
  return model;
}

function isProviderInCooldown(
  provider: string,
  usageStats: Record<string, UsageStatEntry>,
  nowMs: number
): { inCooldown: boolean; cooldownUntil?: number } {
  // Check if any profile for this provider is in cooldown
  for (const [key, stats] of Object.entries(usageStats)) {
    if (key.startsWith(provider + ":") || key === provider) {
      const cd = stats.cooldownUntil || stats.disabledUntil || 0;
      if (cd > nowMs) {
        return { inCooldown: true, cooldownUntil: cd };
      }
    }
  }
  return { inCooldown: false };
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

modelStatusRouter.get("/", async (_req, res) => {
  try {
    if (cache && Date.now() - cache.ts < CACHE_TTL) {
      return res.json(cache.data);
    }

    const OPENCLAW_DIR = getOpenclawDir();
    const nowMs = Date.now();

    // 1. Read config for primary/fallback chain
    const configPath = path.join(OPENCLAW_DIR, "openclaw.json");
    let primaryModel = "";
    let primaryProvider = "";
    let fallbackKeys: string[] = [];
    let aliases: Record<string, AliasEntry> = {};

    try {
      const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
      const defaults = config?.agents?.defaults || {};
      primaryModel = defaults.model?.primary || "";
      fallbackKeys = defaults.model?.fallbacks || [];
      aliases = defaults.models || {};
    } catch { /* config not found */ }

    // Resolve primary model (might be an alias key)
    const primaryKey = primaryModel;
    primaryProvider = providerFromChainKey(primaryKey);
    primaryModel = modelFromChainKey(primaryKey);
    const primaryAlias = buildAlias(primaryModel, aliases);

    // 2. Read auth profiles for cooldown state
    const authPath = path.join(OPENCLAW_DIR, "agents", "agent-scully", "agent", "auth-profiles.json");
    let usageStats: Record<string, UsageStatEntry> = {};
    try {
      const authData = JSON.parse(await fs.readFile(authPath, "utf-8"));
      usageStats = authData.usageStats || {};
    } catch { /* no auth profiles */ }

    // 3. Build fallback chain with cooldown status
    const chainModels = [primaryKey, ...fallbackKeys];
    const fallbackChain: FallbackChainItem[] = [];
    let activeModel = primaryModel;
    let activeProvider = primaryProvider;
    let activeAlias = primaryAlias;
    let fallbackLevel = 0;
    let foundActive = false;

    for (let i = 0; i < chainModels.length; i++) {
      const key = chainModels[i];
      const model = modelFromChainKey(key);
      const provider = providerFromChainKey(key);
      const alias = buildAlias(model, aliases);
      const cdCheck = isProviderInCooldown(provider, usageStats, nowMs);

      let status: "active" | "cooldown" | "ready";
      if (cdCheck.inCooldown) {
        status = "cooldown";
      } else if (!foundActive) {
        status = "active";
        foundActive = true;
        activeModel = model;
        activeProvider = provider;
        activeAlias = alias;
        fallbackLevel = i;
      } else {
        status = "ready";
      }

      const item: FallbackChainItem = { model, alias, provider, status };
      if (cdCheck.inCooldown && cdCheck.cooldownUntil) {
        item.cooldownUntil = new Date(cdCheck.cooldownUntil).toISOString();
        item.cooldownRemaining = Math.max(0, Math.round((cdCheck.cooldownUntil - nowMs) / 1000));
      }
      fallbackChain.push(item);
    }

    // If nothing is active (shouldn't happen), mark first non-cooldown or first item
    if (!foundActive && fallbackChain.length > 0) {
      fallbackChain[0].status = "active";
    }

    const isFallback = fallbackLevel > 0;

    // 4. Parse session JSONL for model usage counts and switch detection
    const sessionsDir = path.join(OPENCLAW_DIR, "agents", "agent-scully", "sessions");
    let sessionFiles: { name: string; mtime: number }[] = [];
    try {
      const files = await fs.readdir(sessionsDir);
      const jsonlFiles = files.filter(f => f.endsWith(".jsonl") && !f.includes(".deleted"));
      const stats = await Promise.all(
        jsonlFiles.map(async f => {
          const st = await fs.stat(path.join(sessionsDir, f));
          return { name: f, mtime: st.mtimeMs };
        })
      );
      sessionFiles = stats.sort((a, b) => b.mtime - a.mtime);
    } catch { /* no sessions */ }

    const modelCounts = new Map<string, number>();
    const switches: { time: string; from: string; to: string }[] = [];
    let activeSince = "";
    let activeRequestsServed = 0;

    if (sessionFiles.length > 0) {
      const latestFile = path.join(sessionsDir, sessionFiles[0].name);
      try {
        const content = await fs.readFile(latestFile, "utf-8");
        let prevModel = "";
        for (const line of content.split("\n")) {
          if (!line) continue;
          try {
            const entry = JSON.parse(line);
            const entryModel = entry.model || entry.message?.model || "";
            if (!entryModel) continue;

            modelCounts.set(entryModel, (modelCounts.get(entryModel) || 0) + 1);

            if (prevModel && entryModel !== prevModel) {
              const ts = entry.timestamp || new Date().toISOString();
              switches.push({ time: ts, from: prevModel, to: entryModel });
            }
            prevModel = entryModel;
          } catch { /* skip bad line */ }
        }
      } catch { /* can't read file */ }
    }

    // Count requests for active model
    activeRequestsServed = modelCounts.get(activeModel) || 0;

    // Compute primary vs fallback request counts
    let primaryRequests = modelCounts.get(primaryModel) || 0;
    let fallbackRequests = 0;
    for (const [model, count] of modelCounts) {
      if (model !== primaryModel) fallbackRequests += count;
    }

    // 5. Parse gateway logs for rate-limit/fallback events
    const today = new Date();
    const logDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const logPath = path.join("/tmp", "openclaw", `openclaw-${logDate}.log`);
    let cooldownEvents = 0;
    const logEvents: { time: string; message: string }[] = [];

    try {
      const logContent = await fs.readFile(logPath, "utf-8");
      for (const line of logContent.split("\n")) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          const msg = typeof entry["1"] === "string" ? entry["1"] : JSON.stringify(entry["1"] || "");
          const lower = msg.toLowerCase();

          if (lower.includes("fallback") || lower.includes("rate") || lower.includes("429") || lower.includes("cooldown")) {
            const ts = entry.timestamp || entry.ts || entry.time || today.toISOString();
            logEvents.push({ time: ts, message: msg });
            if (lower.includes("cooldown")) cooldownEvents++;
          }
        } catch { /* skip bad line */ }
      }
    } catch { /* no log file */ }

    // Find when active model became active (from switches or fallback start)
    if (switches.length > 0) {
      const lastSwitch = switches[switches.length - 1];
      if (lastSwitch.to === activeModel) {
        activeSince = lastSwitch.time;
      }
    }
    if (!activeSince) {
      activeSince = new Date().toISOString();
    }

    // 6. Build history from model switches + log events
    const history: HistoryEntry[] = [];
    const twentyFourHoursAgo = nowMs - 24 * 60 * 60 * 1000;

    for (let i = switches.length - 1; i >= 0; i--) {
      const sw = switches[i];
      const switchTime = new Date(sw.time).getTime();
      if (switchTime < twentyFourHoursAgo) continue;

      const toAlias = buildAlias(sw.to, aliases);
      const isPrimary = sw.to === primaryModel;

      // Compute duration: time until next switch or now
      let duration: number | undefined;
      if (i < switches.length - 1) {
        const nextTime = new Date(switches[i + 1].time).getTime();
        duration = Math.round((nextTime - switchTime) / 1000);
      }

      // Try to find a reason from log events near this time
      let reason = isPrimary ? "cooldown-expired" : "rate-limited";
      for (const evt of logEvents) {
        const evtTime = new Date(evt.time).getTime();
        if (Math.abs(evtTime - switchTime) < 60000) {
          if (evt.message.toLowerCase().includes("429")) reason = "rate-limited (429)";
          else if (evt.message.toLowerCase().includes("fallback")) reason = "fallback-triggered";
          break;
        }
      }

      history.push({
        time: sw.time,
        model: sw.to,
        alias: toAlias,
        reason,
        level: isPrimary ? "primary" : "fallback",
        duration,
      });

      if (history.length >= 20) break;
    }

    // 7. Compute stats
    const totalRequests = primaryRequests + fallbackRequests;
    const primaryUptime = totalRequests > 0
      ? Math.round((primaryRequests / totalRequests) * 1000) / 10
      : 100;

    const data = {
      primary: {
        provider: primaryProvider,
        model: primaryModel,
        alias: primaryAlias,
      },
      active: {
        provider: activeProvider,
        model: activeModel,
        alias: activeAlias,
        fallbackLevel,
        since: activeSince,
        requestsServed: activeRequestsServed,
      },
      isFallback,
      fallbackChain,
      stats: {
        primaryRequests,
        fallbackRequests,
        cooldownEvents,
        primaryUptime,
      },
      history,
    };

    cache = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to get model status" });
  }
});
