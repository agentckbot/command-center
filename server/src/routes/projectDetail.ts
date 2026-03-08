import { Router } from "express";
import express from "express";
import fs from "fs/promises";
import path from "path";
import { PROJECTS_DIR } from "../services/paths.js";
import { parseProjectMd } from "../services/markdown.js";
import { run } from "../services/shell.js";
import { broadcast } from "../ws.js";

export const projectDetailRouter = Router();
projectDetailRouter.use(express.json());

function sanitizeId(id: string): boolean {
  return !id.includes("..") && !id.includes("/") && !id.startsWith(".");
}

// --- Task parsing with feature grouping ---

interface TaskItemDetail {
  text: string;
  done: boolean;
  waiting: string | null;
  blockReason: string | null;
  date: string | null;
}

interface FeatureGroup {
  feature: string;
  tasks: TaskItemDetail[];
}

interface TaskSections {
  blocked: FeatureGroup[];
  inProgress: FeatureGroup[];
  approved: FeatureGroup[];
  planned: FeatureGroup[];
  done: FeatureGroup[];
  counts: { blocked: number; inProgress: number; approved: number; planned: number; done: number; total: number };
}

function parseTaskLine(line: string, sectionName: string): TaskItemDetail | null {
  const m = line.match(/^- \[([ x])\]\s+(.+)/);
  if (!m) return null;

  const isDone = m[1] === "x";
  let text = m[2].trim();

  // Extract waiting tag
  const waitingMatch = text.match(/\[waiting:(\w+)\]/);
  const waiting = waitingMatch ? waitingMatch[1] : null;
  text = text.replace(/\s*\[waiting:\w+\]\s*/g, "").trim();

  // Extract block reason (text after " — " in blocked section)
  let blockReason: string | null = null;
  if (sectionName === "blocked") {
    const dashIdx = text.indexOf(" — ");
    if (dashIdx >= 0) {
      blockReason = text.slice(dashIdx + 3).trim();
      text = text.slice(0, dashIdx).trim();
    }
  }

  // Extract date from done tasks: (2026-03-01)
  const dateMatch = text.match(/\((\d{4}-\d{2}-\d{2})\)\s*$/);
  const date = dateMatch ? dateMatch[1] : null;
  if (dateMatch) text = text.replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, "").trim();

  return { text, done: isDone, waiting, blockReason, date };
}

async function parseTasksDetailed(filePath: string): Promise<TaskSections> {
  const sections: TaskSections = {
    blocked: [], inProgress: [], approved: [], planned: [], done: [],
    counts: { blocked: 0, inProgress: 0, approved: 0, planned: 0, done: 0, total: 0 },
  };

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return sections;
  }

  const lines = content.split("\n");
  let currentSection = "";
  let currentFeature = "";
  // Map section name -> feature name -> tasks
  const sectionMap: Record<string, Record<string, TaskItemDetail[]>> = {};

  for (const line of lines) {
    // Detect ## section headers
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      const s = h2[1].toLowerCase();
      if (s.includes("blocked")) currentSection = "blocked";
      else if (s.includes("in progress")) currentSection = "inProgress";
      else if (s.includes("approved")) currentSection = "approved";
      else if (s.includes("planned")) currentSection = "planned";
      else if (s.includes("done")) currentSection = "done";
      else if (s.includes("todo")) currentSection = "todo";
      else currentSection = "";
      currentFeature = "";
      continue;
    }

    // Detect ### feature group headers
    const h3 = line.match(/^###\s+(.+)/);
    if (h3 && currentSection) {
      // Strip date suffix like "(2026-03-03)"
      currentFeature = h3[1].replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, "").trim();
      continue;
    }

    if (!currentSection) continue;

    const task = parseTaskLine(line, currentSection);
    if (task) {
      // Map "todo" section to "planned" for unified handling (old format)
      const sectionKey = currentSection === "todo" ? "planned" : currentSection;
      if (!sectionMap[sectionKey]) sectionMap[sectionKey] = {};
      const feat = currentFeature || "General";
      if (!sectionMap[sectionKey][feat]) sectionMap[sectionKey][feat] = [];
      sectionMap[sectionKey][feat].push(task);
    }
  }

  // Convert to FeatureGroup arrays
  for (const sectionName of ["blocked", "inProgress", "approved", "planned", "done"] as const) {
    const featureMap = sectionMap[sectionName] || {};
    let count = 0;
    for (const [feature, tasks] of Object.entries(featureMap)) {
      sections[sectionName].push({ feature, tasks });
      count += tasks.length;
    }
    sections.counts[sectionName] = count;
  }

  sections.counts.total = sections.counts.blocked + sections.counts.inProgress +
    sections.counts.approved + sections.counts.planned + sections.counts.done;

  return sections;
}

// --- Decision parsing ---

interface Decision {
  title: string;
  date: string;
  summary: string;
}

async function parseDecisions(filePath: string): Promise<Decision[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const decisions: Decision[] = [];
  const blocks = content.split(/^## /m).filter(Boolean);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const headerLine = lines[0] || "";
    // Format: "2026-03-03: Title"
    const headerMatch = headerLine.match(/^(\d{4}-\d{2}-\d{2}):\s+(.+)/);
    if (!headerMatch) continue;

    const date = headerMatch[1];
    const title = headerMatch[2];

    // Find **Decision:** or **Rationale:** line for summary
    let summary = "";
    for (const line of lines.slice(1)) {
      const decMatch = line.match(/^\*\*Decision:\*\*\s*(.+)/);
      if (decMatch) {
        summary = decMatch[1];
        break;
      }
    }

    decisions.push({ title, date, summary });
  }

  return decisions.reverse().slice(0, 10);
}

// --- GET /api/projects/:id ---

projectDetailRouter.get("/:id", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const projDir = path.join(PROJECTS_DIR, id);
  try {
    await fs.access(projDir);
  } catch {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  try {
    const projectMd = await parseProjectMd(path.join(projDir, "PROJECT.md"));
    const tasks = await parseTasksDetailed(path.join(projDir, "TASKS.md"));
    const decisions = await parseDecisions(path.join(projDir, "DECISIONS.md"));

    // Git info
    let branch = "unknown";
    let clean = true;
    let lastCommit = "";
    try {
      branch = (await run("git", ["-C", projDir, "rev-parse", "--abbrev-ref", "HEAD"])).trim();
      const status = (await run("git", ["-C", projDir, "status", "--porcelain"])).trim();
      clean = status === "";
      lastCommit = (await run("git", ["-C", projDir, "log", "-1", "--format=%h"])).trim();
    } catch { /* not a git repo */ }

    // Parse PROJECT.md for stack and port info
    let stack = "";
    let port = "";
    let started = "";
    try {
      const content = await fs.readFile(path.join(projDir, "PROJECT.md"), "utf-8");
      const stackMatch = content.match(/\*\*Frontend:\*\*\s*(.+)/);
      const stack2 = content.match(/Tech Stack[\s\S]*?\*\*Frontend:\*\*\s*(.+)/);
      if (stackMatch) stack = stackMatch[1].trim();
      else if (stack2) stack = stack2[1].trim();

      const portMatch = content.match(/Port\s+(\d+)/i);
      if (portMatch) port = portMatch[1];

      // Try to find started date from git or file
      const startedMatch = content.match(/Started:\s*(.+)/i);
      if (startedMatch) started = startedMatch[1].trim();
    } catch { /* ok */ }

    // If no started date, try first commit
    if (!started) {
      try {
        started = (await run("git", ["-C", projDir, "log", "--reverse", "--format=%ai", "-1"])).trim().slice(0, 10);
      } catch { /* ok */ }
    }

    const progress = tasks.counts.total > 0
      ? Math.round((tasks.counts.done / tasks.counts.total) * 100) : 0;

    res.json({
      id,
      name: projectMd.name,
      description: projectMd.description,
      status: projectMd.status,
      stack,
      port,
      started,
      tasks,
      decisions,
      git: { branch, clean, lastCommit },
      progress,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get project detail" });
  }
});

// --- POST /api/projects/:id/tasks ---

projectDetailRouter.post("/:id/tasks", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid project id" }); return; }

  const { task } = req.body as { task: string };
  if (!task || !task.trim()) { res.status(400).json({ error: "Missing task text" }); return; }

  const tasksPath = path.join(PROJECTS_DIR, id, "TASKS.md");
  let content: string;
  try {
    content = await fs.readFile(tasksPath, "utf-8");
  } catch {
    res.status(404).json({ error: "TASKS.md not found" });
    return;
  }

  try {
    const lines = content.split("\n");
    // Find Planned section, insert at end of it
    let plannedStart = -1;
    let insertIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const h2 = lines[i].match(/^##\s+(.+)/);
      if (h2 && h2[1].includes("Planned")) {
        plannedStart = i;
      } else if (h2 && plannedStart >= 0) {
        // Next section after Planned
        insertIdx = i;
        break;
      }
    }

    if (plannedStart === -1) {
      res.status(404).json({ error: "No Planned section found" });
      return;
    }

    // Insert before next section (or end of file)
    if (insertIdx === -1) insertIdx = lines.length;

    // Back up past blank lines
    while (insertIdx > 0 && lines[insertIdx - 1].trim() === "") insertIdx--;

    lines.splice(insertIdx, 0, `- [ ] ${task.trim()}`);
    await fs.writeFile(tasksPath, lines.join("\n"), "utf-8");
    broadcast('tasks'); broadcast('projects');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to add task" });
  }
});

// --- POST /api/projects/:id/approve ---

projectDetailRouter.post("/:id/approve", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid project id" }); return; }

  const { feature, task } = req.body as { feature?: string; task?: string };
  if (!feature && !task) { res.status(400).json({ error: "Provide feature or task" }); return; }

  const tasksPath = path.join(PROJECTS_DIR, id, "TASKS.md");
  let content: string;
  try {
    content = await fs.readFile(tasksPath, "utf-8");
  } catch {
    res.status(404).json({ error: "TASKS.md not found" });
    return;
  }

  try {
    const lines = content.split("\n");
    let inPlanned = false;
    let inApproved = false;
    let currentFeature = "";
    let approvedEndIdx = -1;
    const linesToMove: number[] = [];
    const featureHeadersToMove: number[] = [];

    // First pass: find lines to move and Approved section end
    for (let i = 0; i < lines.length; i++) {
      const h2 = lines[i].match(/^##\s+(.+)/);
      if (h2) {
        inPlanned = h2[1].includes("Planned");
        inApproved = h2[1].includes("Approved");
        currentFeature = "";
        continue;
      }

      const h3 = lines[i].match(/^###\s+(.+)/);
      if (h3) {
        currentFeature = h3[1].replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, "").trim();
        if (inPlanned && feature && currentFeature === feature) {
          featureHeadersToMove.push(i);
        }
        continue;
      }

      if (inApproved && !lines[i].match(/^##\s+/)) {
        approvedEndIdx = i + 1;
      }

      if (inPlanned) {
        const taskMatch = lines[i].match(/^- \[[ ]\]\s+(.+)/);
        if (taskMatch) {
          if (feature && currentFeature === feature) {
            linesToMove.push(i);
          } else if (task && taskMatch[1].trim() === task) {
            linesToMove.push(i);
          }
        }
      }
    }

    if (linesToMove.length === 0) {
      res.status(404).json({ error: "No matching tasks found in Planned" });
      return;
    }

    // Find where Approved section ends
    if (approvedEndIdx === -1) {
      // Find the Approved header and set insert point right after
      for (let i = 0; i < lines.length; i++) {
        const h2 = lines[i].match(/^##\s+(.+)/);
        if (h2 && h2[1].includes("Approved")) {
          approvedEndIdx = i + 1;
          // Skip description line and blank lines
          while (approvedEndIdx < lines.length && !lines[approvedEndIdx].match(/^##\s+/) && !lines[approvedEndIdx].match(/^- \[/)) {
            approvedEndIdx++;
          }
          break;
        }
      }
    }

    // If no Approved section exists, create one before Planned (or In Progress, or end of Done)
    if (approvedEndIdx === -1) {
      let insertBefore = -1;
      for (let i = 0; i < lines.length; i++) {
        const h2 = lines[i].match(/^##\s+(.+)/);
        if (h2) {
          const s = h2[1].toLowerCase();
          if (s.includes("in progress") || s.includes("planned") || s.includes("blocked")) {
            insertBefore = i;
            break;
          }
        }
      }
      if (insertBefore === -1) insertBefore = lines.length;
      lines.splice(insertBefore, 0, "", "## ✅ Approved", "");
      approvedEndIdx = insertBefore + 2; // after the header and before the blank line
      // Adjust linesToMove indices since we inserted lines before Planned
      for (let j = 0; j < linesToMove.length; j++) {
        if (linesToMove[j] >= insertBefore) linesToMove[j] += 3;
      }
      for (let j = 0; j < featureHeadersToMove.length; j++) {
        if (featureHeadersToMove[j] >= insertBefore) featureHeadersToMove[j] += 3;
      }
    }

    // Collect lines to move (including feature header if approving whole feature)
    const taskLines = linesToMove.map(i => lines[i]);

    // Check if approved section already has the feature header
    let approvedHasFeature = false;
    if (feature) {
      for (let i = 0; i < lines.length; i++) {
        const h2 = lines[i].match(/^##\s+(.+)/);
        if (h2 && h2[1].includes("Approved")) {
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].match(/^##\s+/)) break;
            const h3 = lines[j].match(/^###\s+(.+)/);
            if (h3 && h3[1].replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, "").trim() === feature) {
              approvedHasFeature = true;
              // Insert after the last task in this feature group
              approvedEndIdx = j + 1;
              while (approvedEndIdx < lines.length && !lines[approvedEndIdx].match(/^##\s+/) && !lines[approvedEndIdx].match(/^###\s+/)) {
                if (lines[approvedEndIdx].trim() === "") { approvedEndIdx++; continue; }
                approvedEndIdx++;
              }
              break;
            }
          }
          break;
        }
      }
    }

    // Build insertion block
    const insertLines: string[] = [];
    if (feature && !approvedHasFeature) {
      insertLines.push(`\n### ${feature}`);
    }
    insertLines.push(...taskLines);

    // Remove from planned (in reverse order to maintain indices)
    const allToRemove = [...linesToMove, ...featureHeadersToMove].sort((a, b) => b - a);

    // Check if removing these leaves the feature header orphaned
    for (const idx of allToRemove) {
      lines.splice(idx, 1);
    }

    // Clean up empty feature headers in Planned that have no tasks left
    // (re-scan after removal)

    // Adjust insert index
    let adjustedIdx = approvedEndIdx;
    for (const idx of allToRemove) {
      if (idx < approvedEndIdx) adjustedIdx--;
    }

    lines.splice(adjustedIdx, 0, ...insertLines);
    await fs.writeFile(tasksPath, lines.join("\n"), "utf-8");
    broadcast('tasks'); broadcast('projects');
    res.json({ ok: true, moved: taskLines.length });
  } catch {
    res.status(500).json({ error: "Failed to approve" });
  }
});

// --- POST /api/projects/:id/deploy ---

projectDetailRouter.post("/:id/deploy", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid project id" }); return; }

  const projDir = path.join(PROJECTS_DIR, id);
  const deployScript = path.join(projDir, "deploy.sh");

  try {
    await fs.access(deployScript);
  } catch {
    res.status(404).json({ error: "No deploy.sh found" });
    return;
  }

  try {
    const output = await run("bash", [deployScript]);
    res.json({ ok: true, output });
  } catch (err) {
    res.status(500).json({ error: "Deploy failed", detail: String(err) });
  }
});

// --- GET /api/projects/:id/git ---

projectDetailRouter.get("/:id/git", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid project id" }); return; }

  const projDir = path.join(PROJECTS_DIR, id);
  try {
    const branch = (await run("git", ["-C", projDir, "rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const status = (await run("git", ["-C", projDir, "status", "--porcelain"])).trim();
    const clean = status === "";
    const logRaw = await run("git", ["-C", projDir, "log", "-10", "--format=%h|%s|%ar|%ai"]);
    const commits = logRaw.trim().split("\n").filter(Boolean).map(line => {
      const [hash, message, ago, date] = line.split("|");
      return { hash, message, ago, date };
    });

    const uncommitted = clean ? [] : status.split("\n").map(l => l.trim()).filter(Boolean);

    res.json({ branch, clean, commits, uncommitted });
  } catch {
    res.status(500).json({ error: "Failed to get git info" });
  }
});

// --- GET /api/projects/:id/activity ---

projectDetailRouter.get("/:id/activity", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid project id" }); return; }

  const memDir = path.join(PROJECTS_DIR, id, "memory");
  const activities: { date: string; items: string[] }[] = [];

  try {
    const files = await fs.readdir(memDir);
    const recent = files.filter(f => f.endsWith(".md")).sort().reverse().slice(0, 7);
    for (const file of recent) {
      const content = await fs.readFile(path.join(memDir, file), "utf-8");
      const items = content.split("\n")
        .filter(l => l.match(/^[-*]\s+/))
        .map(l => l.replace(/^[-*]\s+/, "").trim())
        .filter(Boolean);
      if (items.length > 0) {
        activities.push({ date: file.replace(".md", ""), items });
      }
    }
  } catch { /* no memory dir */ }

  res.json(activities);
});

// --- POST /api/projects/:id/block ---

projectDetailRouter.post("/:id/block", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid project id" }); return; }

  const { task, reason, waitingOn } = req.body as { task: string; reason: string; waitingOn?: string };
  if (!task || !task.trim()) { res.status(400).json({ error: "Missing task text" }); return; }
  if (!reason || !reason.trim()) { res.status(400).json({ error: "Missing reason" }); return; }

  const tasksPath = path.join(PROJECTS_DIR, id, "TASKS.md");
  let content: string;
  try {
    content = await fs.readFile(tasksPath, "utf-8");
  } catch {
    res.status(404).json({ error: "TASKS.md not found" });
    return;
  }

  try {
    const lines = content.split("\n");
    // Find the task line
    let taskIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^- \[[ ]\]\s+(.+)/);
      if (m && m[1].trim().replace(/\s*\[waiting:\w+\]\s*/g, "").trim() === task.trim()) {
        taskIdx = i;
        break;
      }
    }

    if (taskIdx === -1) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    // Remove the task from its current position
    const taskLine = lines.splice(taskIdx, 1)[0];
    // Clean the task text for reinsertion
    const cleanText = task.trim();
    const waitingTag = waitingOn ? ` [waiting:${waitingOn}]` : "";
    const blockedLine = `- [ ] ${cleanText} — ${reason.trim()}${waitingTag}`;

    // Find Blocked section and insert
    let blockedIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const h2 = lines[i].match(/^##\s+(.+)/);
      if (h2 && h2[1].toLowerCase().includes("blocked")) {
        blockedIdx = i + 1;
        // Skip past any description or "(none)" lines
        while (blockedIdx < lines.length && !lines[blockedIdx].match(/^##\s+/) && !lines[blockedIdx].match(/^- \[/)) {
          // Remove "(none)" placeholder if present
          if (lines[blockedIdx].trim().toLowerCase() === "(none)") {
            lines.splice(blockedIdx, 1);
            continue;
          }
          blockedIdx++;
        }
        break;
      }
    }

    if (blockedIdx === -1) {
      res.status(404).json({ error: "No Blocked section found in TASKS.md" });
      return;
    }

    lines.splice(blockedIdx, 0, blockedLine);
    await fs.writeFile(tasksPath, lines.join("\n"), "utf-8");
    broadcast('tasks'); broadcast('projects'); broadcast('waiting');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to block task" });
  }
});

// --- POST /api/projects/:id/spawn-coder ---

projectDetailRouter.post("/:id/spawn-coder", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid project id" }); return; }

  const projDir = path.join(PROJECTS_DIR, id);
  const scriptPath = path.join(projDir, "scripts", "run-approved.sh");

  try {
    await fs.access(scriptPath);
  } catch {
    res.status(404).json({ error: "No scripts/run-approved.sh found for this project" });
    return;
  }

  try {
    const { feature } = req.body as { feature?: string };
    const args = [scriptPath];
    if (feature) {
      // run-approved.sh doesn't take a feature arg, but we can use --use-generic as fallback
      args.push("--use-generic");
    }

    const output = await run("bash", args, 60000);
    res.json({ ok: true, output });
  } catch (err) {
    res.status(500).json({ error: "Failed to spawn coder", detail: String(err) });
  }
});

// --- GET /api/projects/:id/prompts ---

projectDetailRouter.get("/:id/prompts", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid project id" }); return; }

  const promptsDir = path.join(PROJECTS_DIR, id, "prompts");
  try {
    const files = await fs.readdir(promptsDir);
    const mdFiles = files.filter(f => f.endsWith(".md"));
    const prompts = await Promise.all(mdFiles.map(async (filename) => {
      const stat = await fs.stat(path.join(promptsDir, filename));
      return { name: filename.replace(/\.md$/, ""), filename, sizeBytes: stat.size };
    }));
    res.json(prompts);
  } catch {
    res.json([]);
  }
});

// --- GET /api/projects/:id/prompts/:name ---

projectDetailRouter.get("/:id/prompts/:name", async (req, res) => {
  const { id, name } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid project id" }); return; }

  // Sanitize name: only allow alphanumeric, hyphens, underscores
  if (!name || /[^a-zA-Z0-9_-]/.test(name)) {
    res.status(400).json({ error: "Invalid prompt name" });
    return;
  }

  const filename = name.endsWith(".md") ? name : `${name}.md`;
  const filePath = path.join(PROJECTS_DIR, id, "prompts", filename);

  // Verify resolved path is within prompts dir (prevent traversal)
  const resolved = path.resolve(filePath);
  const promptsDir = path.resolve(path.join(PROJECTS_DIR, id, "prompts"));
  if (!resolved.startsWith(promptsDir + path.sep) && resolved !== promptsDir) {
    res.status(400).json({ error: "Invalid path" });
    return;
  }

  try {
    const content = await fs.readFile(filePath, "utf-8");
    res.json({ name: name.replace(/\.md$/, ""), filename, content });
  } catch {
    res.status(404).json({ error: "Prompt not found" });
  }
});

// --- POST /api/projects/:id/implement ---

projectDetailRouter.post("/:id/implement", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid project id" }); return; }

  const projDir = path.join(PROJECTS_DIR, id);
  let projectName = id;
  try {
    const projectMd = await parseProjectMd(path.join(projDir, "PROJECT.md"));
    projectName = projectMd.name || id;
  } catch { /* fall back to id */ }

  try {
    // Run run-approved.sh in background — spawns coder agent for approved tasks
    const scriptPath = path.join(projDir, "scripts", "run-approved.sh");
    const { spawn } = await import("child_process");
    const child = spawn("bash", [scriptPath, "--use-generic"], {
      cwd: projDir,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
    });
    child.unref();
    broadcast('agents'); broadcast('tasks');
    res.json({ status: "ok", message: `Implementation started (PID ${child.pid})` });
  } catch (err) {
    res.status(500).json({ error: "Failed to start implementation", detail: String(err) });
  }
});

// --- POST /api/projects/:id/spawn-reviewer ---

projectDetailRouter.post("/:id/spawn-reviewer", async (_req, res) => {
  res.json({ status: "not-implemented", message: "Reviewer agent coming soon" });
});

// --- POST /api/projects/:id/design-feature ---

projectDetailRouter.post("/:id/design-feature", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid project id" }); return; }

  const { concept } = req.body as { concept: string };
  if (!concept || !concept.trim()) { res.status(400).json({ error: "Missing concept" }); return; }

  const projDir = path.join(PROJECTS_DIR, id);
  try {
    await fs.access(projDir);
  } catch {
    res.status(404).json({ error: "Project not found" }); return;
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const designDir = path.join(projDir, "design-requests");

  try {
    await fs.mkdir(designDir, { recursive: true });
  } catch { /* already exists */ }

  const requestFile = path.join(designDir, `${requestId}.json`);
  const requestData = {
    requestId,
    concept: concept.trim(),
    status: "pending",
    createdAt: new Date().toISOString(),
    featureName: null,
    taskCount: null,
    error: null,
  };

  await fs.writeFile(requestFile, JSON.stringify(requestData, null, 2), "utf-8");

  // Spawn designer agent in background
  const scriptPath = path.join(projDir, "scripts", "design-feature.sh");
  try {
    await fs.access(scriptPath);
  } catch {
    res.status(500).json({ error: "design-feature.sh not found in project scripts/" }); return;
  }

  try {
    const { spawn } = await import("child_process");
    const child = spawn("bash", [scriptPath, id, requestId], {
      cwd: projDir,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
    });
    child.unref();
    broadcast('agents');
    res.json({ requestId, status: "pending" });
  } catch (err) {
    res.status(500).json({ error: "Failed to spawn designer", detail: String(err) });
  }
});

// --- GET /api/projects/:id/design-status/:requestId ---

projectDetailRouter.get("/:id/design-status/:requestId", async (req, res) => {
  const { id, requestId } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid project id" }); return; }
  if (!requestId || /[^a-zA-Z0-9_-]/.test(requestId)) {
    res.status(400).json({ error: "Invalid requestId" }); return;
  }

  const requestFile = path.join(PROJECTS_DIR, id, "design-requests", `${requestId}.json`);
  try {
    const content = await fs.readFile(requestFile, "utf-8");
    res.json(JSON.parse(content));
  } catch {
    res.json({ status: "not-found" });
  }
});

// --- GET /api/projects/:id/prompt-status ---

function toKebab(name: string): string {
  return name
    .replace(/ —.*/, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

projectDetailRouter.get("/:id/prompt-status", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid project id" }); return; }

  const tasksPath = path.join(PROJECTS_DIR, id, "TASKS.md");
  const promptsDir = path.join(PROJECTS_DIR, id, "prompts");

  let content: string;
  try {
    content = await fs.readFile(tasksPath, "utf-8");
  } catch {
    res.json({ features: [] }); return;
  }

  // Get list of existing prompt files
  let promptFiles = new Set<string>();
  try {
    const files = await fs.readdir(promptsDir);
    for (const f of files) {
      if (f.endsWith(".md")) promptFiles.add(f.replace(/\.md$/, ""));
    }
  } catch { /* no prompts dir */ }

  // Parse TASKS.md for feature headings in Planned, Approved, In Progress
  const features: { name: string; slug: string; hasPrompt: boolean; section: string }[] = [];
  const lines = content.split("\n");
  let currentSection = "";

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      const s = h2[1].toLowerCase();
      if (s.includes("planned")) currentSection = "planned";
      else if (s.includes("approved")) currentSection = "approved";
      else if (s.includes("in progress")) currentSection = "inProgress";
      else currentSection = "";
      continue;
    }

    if (!currentSection) continue;

    const h3 = line.match(/^###\s+(.+)/);
    if (h3) {
      const name = h3[1].replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, "").trim();
      const slug = toKebab(name);
      features.push({ name, slug, hasPrompt: promptFiles.has(slug), section: currentSection });
    }
  }

  res.json({ features });
});
