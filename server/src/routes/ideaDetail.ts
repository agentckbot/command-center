import { Router } from "express";
import express from "express";
import fs from "fs/promises";
import path from "path";
import { IDEAS_DIR, PROJECTS_DIR } from "../services/paths.js";

export const ideaDetailRouter = Router();
ideaDetailRouter.use(express.json());

function sanitizeId(id: string): boolean {
  return !id.includes("..") && !id.includes("/") && !id.startsWith(".");
}

// --- Parse idea README.md ---

interface IdeaDetail {
  id: string;
  title: string;
  description: string;
  stage: string;
  added: string;
  tags: string[];
  keyFeatures: string[];
  openQuestions: string[];
  notes: { text: string; date: string }[];
  nextSteps: { text: string; done: boolean }[];
  extraSections: { name: string; content: string }[];
}

function parseIdeaReadme(content: string, id: string): IdeaDetail {
  const lines = content.split("\n");

  // Title from first heading
  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : id;

  // Status/stage, added, tags from header line
  const statusMatch = content.match(/\*\*Status:\*\*\s*(\S+)/);
  const stage = statusMatch ? statusMatch[1].replace(/[|]/g, "").trim() : "seed";

  const addedMatch = content.match(/\*\*Added:\*\*\s*([\d-]+)/);
  const added = addedMatch ? addedMatch[1] : "";

  const tagsMatch = content.match(/\*\*Tags:\*\*\s*(.+)/);
  const tags = tagsMatch
    ? tagsMatch[1].split(/\s+/).filter((t) => t.startsWith("#"))
    : [];

  // Find concept/description — first paragraph after ## Concept
  let description = "";
  const conceptIdx = lines.findIndex((l) => /^##\s+Concept/i.test(l));
  if (conceptIdx >= 0) {
    const descLines: string[] = [];
    for (let i = conceptIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith("##")) break;
      if (lines[i].trim()) descLines.push(lines[i].trim());
    }
    description = descLines.join(" ");
  }

  // Key Features
  const keyFeatures: string[] = [];
  const featIdx = lines.findIndex((l) => /^##\s+Key Features/i.test(l));
  if (featIdx >= 0) {
    for (let i = featIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith("##")) break;
      const m = lines[i].match(/^-\s+(.+)/);
      if (m) keyFeatures.push(m[1].trim());
    }
  }

  // Open Questions
  const openQuestions: string[] = [];
  const qIdx = lines.findIndex((l) => /^##\s+Open Questions/i.test(l));
  if (qIdx >= 0) {
    for (let i = qIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith("##")) break;
      const m = lines[i].match(/^-\s+(.+)/);
      if (m) openQuestions.push(m[1].trim());
    }
  }

  // Next Steps (checklist)
  const nextSteps: { text: string; done: boolean }[] = [];
  const nsIdx = lines.findIndex((l) => /^##\s+Next Steps/i.test(l));
  if (nsIdx >= 0) {
    for (let i = nsIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith("##")) break;
      const m = lines[i].match(/^- \[([ x])\]\s+(.+)/);
      if (m) nextSteps.push({ text: m[2].trim(), done: m[1] === "x" });
    }
  }

  // Notes section
  const notes: { text: string; date: string }[] = [];
  const notesIdx = lines.findIndex((l) => /^##\s+Notes/i.test(l));
  if (notesIdx >= 0) {
    for (let i = notesIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith("##")) break;
      const m = lines[i].match(/^-\s+(.+)/);
      if (m) {
        const dateMatch = m[1].match(/\((\d{4}-\d{2}-\d{2})\)/);
        const date = dateMatch ? dateMatch[1] : "";
        const text = dateMatch
          ? m[1].replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*/, "").trim()
          : m[1].trim();
        notes.push({ text, date });
      }
    }
  }

  // Extra sections (Family, Files, etc.)
  const knownSections = new Set([
    "concept",
    "key features",
    "open questions",
    "next steps",
    "notes",
  ]);
  const extraSections: { name: string; content: string }[] = [];
  let currentExtra = "";
  let extraContent: string[] = [];

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      if (currentExtra && !knownSections.has(currentExtra.toLowerCase())) {
        extraSections.push({
          name: currentExtra,
          content: extraContent.join("\n").trim(),
        });
      }
      currentExtra = h2[1].trim();
      extraContent = [];
      continue;
    }
    if (currentExtra) {
      extraContent.push(line);
    }
  }
  if (currentExtra && !knownSections.has(currentExtra.toLowerCase())) {
    extraSections.push({
      name: currentExtra,
      content: extraContent.join("\n").trim(),
    });
  }

  return {
    id,
    title,
    description,
    stage,
    added,
    tags,
    keyFeatures,
    openQuestions,
    notes,
    nextSteps,
    extraSections,
  };
}

// --- GET /api/ideas/:id ---

ideaDetailRouter.get("/:id", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) {
    res.status(400).json({ error: "Invalid idea id" });
    return;
  }

  const ideaDir = path.join(IDEAS_DIR, id);
  try {
    await fs.access(ideaDir);
  } catch {
    res.status(404).json({ error: "Idea not found" });
    return;
  }

  try {
    const readmePath = path.join(ideaDir, "README.md");
    const content = await fs.readFile(readmePath, "utf-8");
    const idea = parseIdeaReadme(content, id);

    // File listing
    const files = await listIdeaFiles(ideaDir);

    res.json({ ...idea, files });
  } catch (err) {
    res.status(500).json({ error: "Failed to get idea detail" });
  }
});

// --- GET /api/ideas/:id/files ---

async function listIdeaFiles(
  dir: string
): Promise<{ name: string; size: number; type: string; path: string }[]> {
  const results: { name: string; size: number; type: string; path: string }[] =
    [];
  try {
    const entries = await fs.readdir(dir);
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const filePath = path.join(dir, name);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;

      const ext = path.extname(name).toLowerCase();
      let type = "file";
      if (ext === ".md") type = "markdown";
      else if (ext === ".html") type = "mockup";
      else if ([".png", ".jpg", ".jpeg", ".gif", ".svg"].includes(ext))
        type = "image";
      else if ([".ts", ".js", ".py", ".sh"].includes(ext)) type = "code";
      else if (ext === ".json") type = "data";
      else if (ext === ".pdf") type = "document";

      results.push({ name, size: stat.size, type, path: filePath });
    }
  } catch {
    /* empty dir */
  }
  return results;
}

ideaDetailRouter.get("/:id/files", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) {
    res.status(400).json({ error: "Invalid idea id" });
    return;
  }

  const ideaDir = path.join(IDEAS_DIR, id);
  try {
    const files = await listIdeaFiles(ideaDir);
    res.json(files);
  } catch {
    res.status(500).json({ error: "Failed to list files" });
  }
});

// --- POST /api/ideas/:id/promote ---

ideaDetailRouter.post("/:id/promote", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) {
    res.status(400).json({ error: "Invalid idea id" });
    return;
  }

  const { stage } = req.body as { stage: string };
  if (!stage || !["seed", "brewing", "ready"].includes(stage)) {
    res.status(400).json({ error: "Invalid stage. Must be seed, brewing, or ready" });
    return;
  }

  const readmePath = path.join(IDEAS_DIR, id, "README.md");
  let content: string;
  try {
    content = await fs.readFile(readmePath, "utf-8");
  } catch {
    res.status(404).json({ error: "Idea README.md not found" });
    return;
  }

  try {
    // Replace the status in the header line
    const updated = content.replace(
      /\*\*Status:\*\*\s*\S+/,
      `**Status:** ${stage}`
    );
    await fs.writeFile(readmePath, updated, "utf-8");

    // Also update IDEAS.md index if status line exists there
    const ideasMdPath = path.join(IDEAS_DIR, "IDEAS.md");
    try {
      let ideasContent = await fs.readFile(ideasMdPath, "utf-8");
      // Find the block for this idea and update its status
      const ideaBlockRegex = new RegExp(
        `(📁\\s*\`ideas/${id}/\`[\\s\\S]*?\\*\\*Status:\\*\\*)\\s*\\S+`,
        "m"
      );
      if (ideaBlockRegex.test(ideasContent)) {
        ideasContent = ideasContent.replace(ideaBlockRegex, `$1 ${stage}`);
        await fs.writeFile(ideasMdPath, ideasContent, "utf-8");
      }
    } catch {
      /* IDEAS.md might not exist */
    }

    const idea = parseIdeaReadme(updated, id);
    res.json(idea);
  } catch {
    res.status(500).json({ error: "Failed to update stage" });
  }
});

// --- POST /api/ideas/:id/graduate ---

ideaDetailRouter.post("/:id/graduate", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) {
    res.status(400).json({ error: "Invalid idea id" });
    return;
  }

  const ideaDir = path.join(IDEAS_DIR, id);
  const targetDir = path.join(PROJECTS_DIR, id);
  const templateDir = path.join(PROJECTS_DIR, "_template");

  // Check idea exists
  try {
    await fs.access(ideaDir);
  } catch {
    res.status(404).json({ error: "Idea not found" });
    return;
  }

  // Check target doesn't already exist
  try {
    await fs.access(targetDir);
    res.status(409).json({ error: "Project directory already exists" });
    return;
  } catch {
    /* good, doesn't exist */
  }

  try {
    // Read idea info
    const readmeContent = await fs.readFile(
      path.join(ideaDir, "README.md"),
      "utf-8"
    );
    const idea = parseIdeaReadme(readmeContent, id);

    // Copy template to project dir
    await copyDir(templateDir, targetDir);

    // Update PROJECT.md with idea info
    const projectMdPath = path.join(targetDir, "PROJECT.md");
    let projectMd = await fs.readFile(projectMdPath, "utf-8");
    projectMd = projectMd.replace("{{PROJECT_NAME}}", idea.title);
    projectMd = projectMd.replace(
      "{{Brief description — what this project is, in 2-3 sentences.}}",
      idea.description || "Graduated from idea pipeline."
    );
    projectMd = projectMd.replace("Status: planning", "Status: active");
    await fs.writeFile(projectMdPath, projectMd, "utf-8");

    // Update idea status to "project"
    const updatedReadme = readmeContent.replace(
      /\*\*Status:\*\*\s*\S+/,
      "**Status:** project"
    );
    await fs.writeFile(
      path.join(ideaDir, "README.md"),
      updatedReadme,
      "utf-8"
    );

    // Add entry to PROJECTS.md
    const projectsMdPath = path.join(PROJECTS_DIR, "PROJECTS.md");
    try {
      let projectsMd = await fs.readFile(projectsMdPath, "utf-8");
      const entry = `\n### ${id}\n- **Path:** ~/cksoft/projects/${id}\n- **Status:** active\n- **Description:** ${idea.description || idea.title}\n- **Last worked on:** ${new Date().toISOString().slice(0, 10)}\n`;
      projectsMd += entry;
      await fs.writeFile(projectsMdPath, projectsMd, "utf-8");
    } catch {
      /* PROJECTS.md might not exist */
    }

    res.json({ project: id, path: targetDir });
  } catch (err) {
    res.status(500).json({ error: "Failed to graduate idea", detail: String(err) });
  }
});

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

// --- GET /api/ideas/:id/readme ---

ideaDetailRouter.get("/:id/readme", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const readmePath = path.join(IDEAS_DIR, id, "README.md");
  try {
    const content = await fs.readFile(readmePath, "utf-8");
    res.json({ content });
  } catch {
    res.status(404).json({ error: "README.md not found" });
  }
});

// --- GET /api/ideas/:id/files/:name ---

ideaDetailRouter.get("/:id/files/:name", async (req, res) => {
  const { id, name } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    res.status(400).json({ error: "Invalid filename" }); return;
  }

  const filePath = path.join(IDEAS_DIR, id, name);
  try {
    await fs.access(filePath);
  } catch {
    res.status(404).json({ error: "File not found" }); return;
  }

  const ext = path.extname(name).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".md": "text/markdown", ".html": "text/html", ".txt": "text/plain",
    ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
    ".pdf": "application/pdf", ".ts": "text/plain", ".js": "text/plain",
    ".py": "text/plain", ".sh": "text/plain", ".css": "text/plain",
  };

  const contentType = mimeMap[ext] || "application/octet-stream";
  res.setHeader("Content-Type", contentType);

  const textTypes = [".md", ".html", ".txt", ".json", ".ts", ".js", ".py", ".sh", ".css", ".svg"];
  if (textTypes.includes(ext)) {
    const content = await fs.readFile(filePath, "utf-8");
    res.send(content);
  } else {
    const { createReadStream } = await import("fs");
    createReadStream(filePath).pipe(res);
  }
});

// --- GET/POST /api/ideas/:id/summary ---

ideaDetailRouter.get("/:id/summary", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const summaryPath = path.join(IDEAS_DIR, id, "summary.md");
  try {
    const content = await fs.readFile(summaryPath, "utf-8");
    const stat = await fs.stat(summaryPath);
    res.json({ exists: true, content, generatedAt: stat.mtime.toISOString() });
  } catch {
    res.json({ exists: false, content: null, generatedAt: null });
  }
});

ideaDetailRouter.post("/:id/summary", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const ideaDir = path.join(IDEAS_DIR, id);
  const readmePath = path.join(ideaDir, "README.md");
  const summaryPath = path.join(ideaDir, "summary.md");

  try {
    await fs.access(readmePath);
  } catch {
    res.status(404).json({ error: "README.md not found" }); return;
  }

  try {
    const readme = await fs.readFile(readmePath, "utf-8");

    let extraContext = "";
    try {
      const files = await fs.readdir(ideaDir);
      for (const f of files) {
        if (f === "README.md" || f === "summary.md") continue;
        if (f.endsWith(".md")) {
          const content = await fs.readFile(path.join(ideaDir, f), "utf-8");
          if (content.length < 10000) {
            extraContext += `\n\n--- ${f} ---\n${content}`;
          }
        }
      }
    } catch { /* ignore */ }

    const prompt = `You are a technical writer. Read this project idea and write a concise executive summary (3-5 paragraphs). Cover: what it is, who it's for, key capabilities, current status, and what's needed next. Be specific, not generic. Write in present tense as if describing the planned product.\n\nREADME:\n${readme}${extraContext ? `\n\nAdditional files:\n${extraContext}` : ""}\n\nWrite ONLY the summary text, no headings or preamble.`;

    const { spawn } = await import("child_process");
    const child = spawn("claude", ["-p", prompt], {
      cwd: ideaDir,
      env: { ...process.env, PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
    });

    let output = "";
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr.on("data", (_data: Buffer) => { /* ignore stderr */ });

    child.on("close", async (code: number) => {
      if (code === 0 && output.trim()) {
        const summary = output.trim();
        await fs.writeFile(summaryPath, summary, "utf-8");
        const stat = await fs.stat(summaryPath);
        res.json({ exists: true, content: summary, generatedAt: stat.mtime.toISOString() });
      } else {
        res.status(500).json({ error: "Failed to generate summary" });
      }
    });

    setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, 60000);

  } catch (err) {
    res.status(500).json({ error: "Failed to generate summary", detail: String(err) });
  }
});

// --- POST /api/ideas/:id/note ---

ideaDetailRouter.post("/:id/note", async (req, res) => {
  const { id } = req.params;
  if (!sanitizeId(id)) {
    res.status(400).json({ error: "Invalid idea id" });
    return;
  }

  const { text } = req.body as { text: string };
  if (!text || !text.trim()) {
    res.status(400).json({ error: "Missing note text" });
    return;
  }

  const readmePath = path.join(IDEAS_DIR, id, "README.md");
  let content: string;
  try {
    content = await fs.readFile(readmePath, "utf-8");
  } catch {
    res.status(404).json({ error: "Idea README.md not found" });
    return;
  }

  try {
    const date = new Date().toISOString().slice(0, 10);
    const noteLine = `- ${text.trim()} (${date})`;

    // Find or create Notes section
    const notesIdx = content.split("\n").findIndex((l) => /^##\s+Notes/i.test(l));
    if (notesIdx >= 0) {
      const lines = content.split("\n");
      // Insert after the ## Notes line
      let insertIdx = notesIdx + 1;
      // Skip blank lines right after header
      while (insertIdx < lines.length && lines[insertIdx].trim() === "") {
        insertIdx++;
      }
      lines.splice(insertIdx, 0, noteLine);
      content = lines.join("\n");
    } else {
      // Add Notes section at end
      content += `\n\n## Notes\n${noteLine}\n`;
    }

    await fs.writeFile(readmePath, content, "utf-8");

    // Re-parse and return notes
    const idea = parseIdeaReadme(content, id);
    res.json({ notes: idea.notes });
  } catch {
    res.status(500).json({ error: "Failed to add note" });
  }
});
