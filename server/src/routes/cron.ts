import { Router } from "express";
import { run } from "../services/shell.js";
import fs from "fs/promises";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { OPENCLAW_DIR } from "../services/paths.js";

export const cronRouter = Router();

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  lastRun: string;
  lastStatus: string;
  nextRun: string;
  enabled: boolean;
}

interface CronSchedule {
  kind: string;
  at?: string;
  expr?: string;
  tz?: string;
}

interface CronSourceJob {
  id: string;
  name?: string;
  displayName?: string;
  agentId?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  state?: {
    nextRunAtMs?: number;
    lastError?: unknown;
  };
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: string;
  lastError?: string;
  status?: string;
}

interface CronSqliteRow {
  job_json: string;
  state_json: string;
  next_run_at_ms: number | null;
  last_run_at_ms: number | null;
  last_run_status: string | null;
  last_error: string | null;
}

function loadCronJobsFromSqlite(): CronSourceJob[] {
  const sqlitePath = path.join(OPENCLAW_DIR, "state", "openclaw.sqlite");
  const db = new DatabaseSync(sqlitePath, { readOnly: true });

  try {
    const rows = db
      .prepare(
        `SELECT job_json, state_json, next_run_at_ms, last_run_at_ms, last_run_status, last_error
         FROM cron_jobs
         ORDER BY sort_order ASC, updated_at DESC`
      )
      .all() as unknown as CronSqliteRow[];

    return rows.map((row) => {
      const job = JSON.parse(row.job_json) as CronSourceJob;
      const state = JSON.parse(row.state_json || "{}") as CronSourceJob["state"];

      return {
        ...job,
        state: {
          ...job.state,
          ...state,
        },
        nextRunAtMs: row.next_run_at_ms ?? job.nextRunAtMs ?? state?.nextRunAtMs,
        lastRunAtMs: row.last_run_at_ms ?? undefined,
        lastRunStatus: row.last_run_status ?? undefined,
        lastError: row.last_error ?? undefined,
      };
    });
  } finally {
    db.close();
  }
}

async function loadCronJobs(): Promise<CronSourceJob[]> {
  try {
    return loadCronJobsFromSqlite();
  } catch {
    // Fall back for older installs that still expose JSON or rely on the CLI.
  }

  try {
    const cliOutput = await run("openclaw", ["cron", "list", "--json"]);
    const payload = JSON.parse(cliOutput) as { jobs?: CronSourceJob[] };
    return payload.jobs || [];
  } catch {
    const jobsPath = path.join(OPENCLAW_DIR, "cron", "jobs.json");
    const jobsData = JSON.parse(await fs.readFile(jobsPath, "utf-8")) as {
      jobs?: CronSourceJob[];
    };
    return jobsData.jobs || [];
  }
}

cronRouter.get("/", async (_req, res) => {
  try {
    const sourceJobs = await loadCronJobs();
    const jobs: CronJob[] = [];

    for (const job of sourceJobs) {
      const schedExpr = job.schedule?.expr || (job.schedule?.at ? `at ${job.schedule.at}` : "unknown");
      const nextRunMs = job.nextRunAtMs || job.state?.nextRunAtMs;
      const nextRun = nextRunMs ? formatRelativeTime(nextRunMs) : "—";
      const lastRun = job.lastRunAtMs
        ? formatTimeShort(new Date(job.lastRunAtMs).toISOString())
        : "—";

      jobs.push({
        id: job.id,
        name: job.displayName || job.name || "unnamed",
        schedule: formatSchedule(schedExpr, job.schedule || { kind: "unknown" }),
        lastRun,
        lastStatus:
          job.lastRunStatus ||
          (job.status === "error" || job.state?.lastError ? "error" : "ok"),
        nextRun,
        enabled: job.enabled !== false,
      });
    }

    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: "Failed to get cron jobs" });
  }
});

function formatSchedule(expr: string, schedule: { kind: string; at?: string; expr?: string; tz?: string }): string {
  if (schedule.kind === "at" && schedule.at) {
    return `Once: ${new Date(schedule.at).toLocaleDateString()}`;
  }
  return expr;
}

function formatRelativeTime(ms: number): string {
  const diff = ms - Date.now();
  if (diff < 0) return "Overdue";
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (days > 0) return `in ${days}d`;
  if (hours > 0) return `in ${hours}h`;
  return `in ${Math.floor(diff / 60000)}m`;
}

function formatTimeShort(ts: string): string {
  try {
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const hours = Math.floor(diff / 3600000);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  } catch {
    return ts;
  }
}
