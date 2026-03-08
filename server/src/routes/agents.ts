import { Router } from "express";
import fs from "fs/promises";
import path from "path";
import { HOME, OPENCLAW_DIR } from "../services/paths.js";
import { run } from "../services/shell.js";

export const agentsRouter = Router();

const TRACKER_PATH = process.env.AGENT_TRACKER || path.join(
  HOME,
  "deployments/command-center/agent-tracker.json"
);

interface SessionData {
  sessionId: string;
  updatedAt: number;
  label?: string;
  chatType?: string;
  model?: string;
  modelProvider?: string;
  abortedLastRun?: boolean | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheRead?: number;
}

interface AgentEntry {
  sessionKey: string;
  label: string;
  model: string;
  modelProvider: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  totalTokens: number;
  updatedAt: number;
  startedAt?: number;
  duration?: number;
  status: "running" | "completed" | "errored";
  chatType: string;
  project?: string;
  pid?: number;
  source: "openclaw" | "tracker";
}

// Check if a PID is still running
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

agentsRouter.get("/", async (_req, res) => {
  try {
    const agents: AgentEntry[] = [];

    // Source 1: OpenClaw sessions (cron, sub-agents)
    const sessionsPath = path.join(OPENCLAW_DIR, "agents", "main", "sessions", "sessions.json");
    try {
      const sessionsData: Record<string, SessionData> = JSON.parse(
        await fs.readFile(sessionsPath, "utf-8")
      );

      for (const [key, session] of Object.entries(sessionsData)) {
        const isCron = key.includes(":cron:");
        const isSubAgent = session.chatType === "subagent";
        const isMainDirect =
          key === "agent:main:main" ||
          (session.chatType === "direct" && !isSubAgent) ||
          session.chatType === "group";

        if (isMainDirect && !isCron) continue;

        let status: AgentEntry["status"] = "completed";
        if (session.abortedLastRun === true) {
          status = "errored";
        } else if (session.abortedLastRun === null || session.abortedLastRun === undefined) {
          const ageMs = Date.now() - (session.updatedAt || 0);
          status = ageMs < 5 * 60 * 1000 ? "running" : "completed";
        }

        agents.push({
          sessionKey: key,
          label: session.label || key.split(":").slice(-1)[0] || key,
          model: session.model || "unknown",
          modelProvider: session.modelProvider || "unknown",
          inputTokens: session.inputTokens || 0,
          outputTokens: session.outputTokens || 0,
          cacheRead: session.cacheRead || 0,
          totalTokens: session.totalTokens || 0,
          updatedAt: session.updatedAt || 0,
          status,
          chatType: isCron ? "cron" : session.chatType || "unknown",
          source: "openclaw",
        });
      }
    } catch { /* sessions file may not exist */ }

    // Source 2: Agent tracker (coding agents spawned via exec)
    try {
      const trackerData = JSON.parse(await fs.readFile(TRACKER_PATH, "utf-8"));
      if (trackerData.agents && Array.isArray(trackerData.agents)) {
        for (const agent of trackerData.agents) {
          // Check if PID is still running to update status
          let status: AgentEntry["status"] = agent.status || "completed";
          if (status === "running" && agent.pid && !isProcessRunning(agent.pid)) {
            status = "completed";
          }

          const startedAt = agent.startedAt || 0;
          const endedAt = agent.completedAt || Date.now();
          const duration = startedAt ? endedAt - startedAt : undefined;

          agents.push({
            sessionKey: agent.id || `tracker-${agent.startedAt}`,
            label: agent.task || "Coding agent",
            model: agent.model || "claude-code",
            modelProvider: agent.provider || "anthropic",
            inputTokens: 0,
            outputTokens: 0,
            cacheRead: 0,
            totalTokens: 0,
            updatedAt: agent.completedAt || agent.startedAt || 0,
            startedAt,
            duration,
            status,
            chatType: "coding",
            project: agent.project,
            pid: agent.pid,
            source: "tracker",
          });
        }
      }
    } catch { /* tracker may not exist */ }

    // Also detect running claude processes as fallback
    try {
      const psOutput = await run("ps", ["aux"]);
      const claudeProcs = psOutput.split("\n").filter(
        (line) => line.includes("claude") && line.includes("-p") && !line.includes("grep")
      );
      for (const proc of claudeProcs) {
        const parts = proc.trim().split(/\s+/);
        const pid = parseInt(parts[1] || "0", 10);
        // Skip if we already have this PID from tracker
        if (agents.some((a) => a.pid === pid)) continue;

        // Try to extract working directory from /proc
        let project = "";
        try {
          const cwd = await fs.readlink(`/proc/${pid}/cwd`);
          project = cwd.replace(/.*\/projects\//, "").split("/")[0] || cwd;
        } catch { /* may not have access */ }

        agents.push({
          sessionKey: `process-${pid}`,
          label: `Claude Code (PID ${pid})`,
          model: "claude-code",
          modelProvider: "anthropic",
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          totalTokens: 0,
          updatedAt: Date.now(),
          status: "running",
          chatType: "coding",
          project,
          pid,
          source: "tracker",
        });
      }
    } catch { /* ps may fail */ }

    agents.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json(agents);
  } catch (err) {
    res.status(500).json({ error: "Failed to get agents" });
  }
});
