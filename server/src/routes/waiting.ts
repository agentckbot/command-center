import { Router } from "express";
import express from "express";
import fs from "fs/promises";
import path from "path";
import { HOME, PROJECTS_DIR } from "../services/paths.js";
import { parseTasksFile } from "../services/markdown.js";
import { broadcast } from "../ws.js";

export const waitingRouter = Router();
waitingRouter.use(express.json());

const SKIP_DIRS = ["_template", "ideas", "memory"];
const SNOOZE_PATH = path.join(
  process.env.DEPLOY_DIR || path.join(HOME, "deployments", "command-center"),
  "snooze.json"
);

interface SnoozeEntry {
  key: string;
  until: string;
}

async function loadSnoozes(): Promise<SnoozeEntry[]> {
  try {
    const content = await fs.readFile(SNOOZE_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function saveSnoozes(snoozes: SnoozeEntry[]): Promise<void> {
  await fs.writeFile(SNOOZE_PATH, JSON.stringify(snoozes, null, 2), "utf-8");
}

function snoozeKey(project: string, task: string): string {
  return `${project}:${task}`;
}

interface WaitingItem {
  text: string;
  waitingOn: string;
  section: string;
  age: number;
  impact: number;
}

interface WaitingGroup {
  project: string;
  items: WaitingItem[];
}

function parseTaskAge(text: string): number {
  // Parse date from task text like "Task description (2026-03-04)" or "(2026-03-04)"
  const dateMatch = text.match(/\((\d{4}-\d{2}-\d{2})\)/);
  if (dateMatch) {
    const taskDate = new Date(dateMatch[1]);
    if (!isNaN(taskDate.getTime())) {
      return Math.floor((Date.now() - taskDate.getTime()) / (1000 * 60 * 60 * 24));
    }
  }
  return 0; // No date found — treat as new
}

async function getWaitingGroups(): Promise<WaitingGroup[]> {
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const now = Date.now();
  const snoozes = await loadSnoozes();
  const activeSnoozes = snoozes.filter(s => new Date(s.until).getTime() > now);

  const groups: WaitingGroup[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.includes(entry.name) || entry.name.startsWith(".")) continue;

    const tasksPath = path.join(PROJECTS_DIR, entry.name, "TASKS.md");
    const tasks = await parseTasksFile(tasksPath);

    // Filter out Done section items and checked [x] items
    const activeItems = tasks.items.filter(i => i.section !== "done" && !i.done);
    const blockedCount = activeItems.filter(i => i.section === "blocked").length;

    const items: WaitingItem[] = [];

    for (const item of activeItems) {
      if (!item.waiting) continue;

      const key = snoozeKey(entry.name, item.text);
      if (activeSnoozes.some(s => s.key === key)) continue;

      // Impact: count of blocked tasks in same project
      const impact = blockedCount;

      // Parse age from date in task text instead of file mtime
      const ageDays = parseTaskAge(item.text);

      items.push({
        text: item.text,
        waitingOn: item.waiting,
        section: item.section,
        age: ageDays,
        impact,
      });
    }

    if (items.length > 0) {
      // Sort: highest impact first, then oldest first
      items.sort((a, b) => b.impact - a.impact || b.age - a.age);
      groups.push({ project: entry.name, items });
    }
  }

  // Sort groups: most impactful first
  groups.sort((a, b) => {
    const aMax = Math.max(...a.items.map(i => i.impact));
    const bMax = Math.max(...b.items.map(i => i.impact));
    return bMax - aMax || b.items.length - a.items.length;
  });

  return groups;
}

// --- GET /api/waiting ---

waitingRouter.get("/", async (_req, res) => {
  try {
    const groups = await getWaitingGroups();
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: "Failed to get waiting items" });
  }
});

// --- POST /api/waiting/resolve ---

waitingRouter.post("/resolve", async (req, res) => {
  const { project, task, action } = req.body as {
    project: string;
    task: string;
    action?: "approve" | "unblock" | "remove-tag";
  };

  if (!project || !task) {
    res.status(400).json({ error: "Missing project or task" });
    return;
  }

  const tasksPath = path.join(PROJECTS_DIR, project, "TASKS.md");
  let content: string;
  try {
    content = await fs.readFile(tasksPath, "utf-8");
  } catch {
    res.status(404).json({ error: "TASKS.md not found" });
    return;
  }

  try {
    const lines = content.split("\n");

    // Find the task line (match cleaned text)
    let taskIdx = -1;
    let currentSection = "";
    for (let i = 0; i < lines.length; i++) {
      const h2 = lines[i].match(/^##\s+(.+)/);
      if (h2) {
        const s = h2[1].toLowerCase();
        if (s.includes("planned") || s.includes("todo")) currentSection = "planned";
        else if (s.includes("in progress")) currentSection = "inProgress";
        else if (s.includes("approved")) currentSection = "approved";
        else if (s.includes("done")) currentSection = "done";
        else if (s.includes("blocked")) currentSection = "blocked";
        else currentSection = "";
        continue;
      }

      const m = lines[i].match(/^- \[([ x])\]\s+(.+)/);
      if (m) {
        const cleanedText = m[2].trim().replace(/\s*\[waiting:\w+\]\s*/g, "").trim();
        // Also strip block reason for matching
        const textForMatch = cleanedText.replace(/\s*—\s*.+$/, "").trim();
        if (textForMatch === task || cleanedText === task) {
          taskIdx = i;
          break;
        }
      }
    }

    if (taskIdx === -1) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    // Remove waiting tag from the line
    lines[taskIdx] = lines[taskIdx].replace(/\s*\[waiting:\w+\]\s*/g, " ").replace(/\s+$/, "");

    if (action === "approve" && currentSection === "planned") {
      // Move task from Planned to Approved
      const taskLine = lines.splice(taskIdx, 1)[0];
      // Find Approved section end
      let approvedInsert = -1;
      for (let i = 0; i < lines.length; i++) {
        const h2 = lines[i].match(/^##\s+(.+)/);
        if (h2 && h2[1].toLowerCase().includes("approved")) {
          approvedInsert = i + 1;
          // Skip non-section-header lines
          while (approvedInsert < lines.length && !lines[approvedInsert].match(/^##\s+/)) {
            approvedInsert++;
          }
          // Back up past blank lines
          while (approvedInsert > 0 && lines[approvedInsert - 1].trim() === "") approvedInsert--;
          break;
        }
      }
      if (approvedInsert >= 0) {
        lines.splice(approvedInsert, 0, taskLine);
      }
    } else if (action === "unblock" && currentSection === "blocked") {
      // Move task from Blocked to In Progress, strip block reason
      let taskLine = lines.splice(taskIdx, 1)[0];
      // Remove block reason (text after " — ")
      taskLine = taskLine.replace(/\s*—\s*.+/, "");
      // Find In Progress section end
      let ipInsert = -1;
      for (let i = 0; i < lines.length; i++) {
        const h2 = lines[i].match(/^##\s+(.+)/);
        if (h2 && h2[1].toLowerCase().includes("in progress")) {
          ipInsert = i + 1;
          while (ipInsert < lines.length && !lines[ipInsert].match(/^##\s+/)) {
            ipInsert++;
          }
          while (ipInsert > 0 && lines[ipInsert - 1].trim() === "") ipInsert--;
          break;
        }
      }
      if (ipInsert >= 0) {
        lines.splice(ipInsert, 0, taskLine);
      }
    }
    // action === "remove-tag" or default: just remove the tag (already done above)

    await fs.writeFile(tasksPath, lines.join("\n"), "utf-8");
    broadcast('waiting'); broadcast('tasks'); broadcast('projects');

    const groups = await getWaitingGroups();
    res.json({ ok: true, waiting: groups });
  } catch {
    res.status(500).json({ error: "Failed to resolve" });
  }
});

// --- POST /api/waiting/snooze ---

waitingRouter.post("/snooze", async (req, res) => {
  const { project, task, days } = req.body as {
    project: string;
    task: string;
    days: number;
  };

  if (!project || !task || !days || days < 1) {
    res.status(400).json({ error: "Missing project, task, or valid days" });
    return;
  }

  try {
    const snoozes = await loadSnoozes();
    const key = snoozeKey(project, task);
    const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    // Remove existing snooze for this key if any
    const filtered = snoozes.filter(s => s.key !== key);
    filtered.push({ key, until });

    await saveSnoozes(filtered);
    broadcast('waiting');
    res.json({ snoozed: true, until });
  } catch {
    res.status(500).json({ error: "Failed to snooze" });
  }
});

// --- POST /api/waiting/delegate ---

waitingRouter.post("/delegate", async (req, res) => {
  const { project, task, from, to } = req.body as {
    project: string;
    task: string;
    from: string;
    to: string;
  };

  if (!project || !task || !from || !to) {
    res.status(400).json({ error: "Missing project, task, from, or to" });
    return;
  }

  const tasksPath = path.join(PROJECTS_DIR, project, "TASKS.md");
  let content: string;
  try {
    content = await fs.readFile(tasksPath, "utf-8");
  } catch {
    res.status(404).json({ error: "TASKS.md not found" });
    return;
  }

  try {
    const lines = content.split("\n");
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^- \[([ x])\]\s+(.+)/);
      if (m) {
        const cleanedText = m[2].trim().replace(/\s*\[waiting:\w+\]\s*/g, "").replace(/\s*—\s*.+$/, "").trim();
        if (cleanedText === task) {
          lines[i] = lines[i].replace(`[waiting:${from}]`, `[waiting:${to}]`);
          found = true;
          break;
        }
      }
    }

    if (!found) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    await fs.writeFile(tasksPath, lines.join("\n"), "utf-8");
    broadcast('waiting'); broadcast('tasks');
    res.json({ ok: true, delegated: { from, to } });
  } catch {
    res.status(500).json({ error: "Failed to delegate" });
  }
});

// --- POST /api/waiting/note ---

waitingRouter.post("/note", async (req, res) => {
  const { project, task, note } = req.body as {
    project: string;
    task: string;
    note: string;
  };

  if (!project || !task || !note) {
    res.status(400).json({ error: "Missing project, task, or note" });
    return;
  }

  const tasksPath = path.join(PROJECTS_DIR, project, "TASKS.md");
  let content: string;
  try {
    content = await fs.readFile(tasksPath, "utf-8");
  } catch {
    res.status(404).json({ error: "TASKS.md not found" });
    return;
  }

  try {
    const lines = content.split("\n");
    let taskIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^- \[([ x])\]\s+(.+)/);
      if (m) {
        const cleanedText = m[2].trim().replace(/\s*\[waiting:\w+\]\s*/g, "").replace(/\s*—\s*.+$/, "").trim();
        if (cleanedText === task) {
          taskIdx = i;
          break;
        }
      }
    }

    if (taskIdx === -1) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const commentLine = `  <!-- note: ${today}: ${note} -->`;
    lines.splice(taskIdx + 1, 0, commentLine);

    await fs.writeFile(tasksPath, lines.join("\n"), "utf-8");
    broadcast('waiting'); broadcast('tasks');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to add note" });
  }
});
