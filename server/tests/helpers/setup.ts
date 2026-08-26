import express from "express";
import { systemRouter } from "../../src/routes/system.js";
import { statsRouter } from "../../src/routes/stats.js";
import { projectsRouter } from "../../src/routes/projects.js";
import { ideasRouter } from "../../src/routes/ideas.js";
import { tradesRouter } from "../../src/routes/trades.js";
import { waitingRouter } from "../../src/routes/waiting.js";
import { cronRouter } from "../../src/routes/cron.js";
import { agentsRouter } from "../../src/routes/agents.js";
import { activityRouter } from "../../src/routes/activity.js";
import { upcomingRouter } from "../../src/routes/upcoming.js";
import { logsRouter } from "../../src/routes/logs.js";
import { tasksRouter } from "../../src/routes/tasks.js";
import { actionsRouter } from "../../src/routes/actions.js";
import { projectDetailRouter } from "../../src/routes/projectDetail.js";
import { ideaDetailRouter } from "../../src/routes/ideaDetail.js";

export function createTestApp() {
  const app = express();

  app.use("/api/system", systemRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/projects", projectsRouter);
  app.use("/api/ideas", ideasRouter);
  app.use("/api/trades", tradesRouter);
  app.use("/api/waiting", waitingRouter);
  app.use("/api/cron", cronRouter);
  app.use("/api/agents", agentsRouter);
  app.use("/api/activity", activityRouter);
  app.use("/api/upcoming", upcomingRouter);
  app.use("/api/logs", logsRouter);
  app.use("/api/tasks", tasksRouter);
  app.use("/api/actions", actionsRouter);
  app.use("/api/projects", projectDetailRouter);
  app.use("/api/ideas", ideaDetailRouter);

  return app;
}
