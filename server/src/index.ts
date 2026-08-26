import express from "express";
import path from "path";
import { createServer } from "http";
import { setupWebSocket } from "./ws.js";
import { startWatchers } from "./watcher.js";
import { systemRouter } from "./routes/system.js";
import { statsRouter } from "./routes/stats.js";
import { projectsRouter } from "./routes/projects.js";
import { ideasRouter } from "./routes/ideas.js";
import { tradesRouter } from "./routes/trades.js";
import { waitingRouter } from "./routes/waiting.js";
import { cronRouter } from "./routes/cron.js";
import { agentsRouter } from "./routes/agents.js";
import { activityRouter } from "./routes/activity.js";
import { upcomingRouter } from "./routes/upcoming.js";
import { logsRouter } from "./routes/logs.js";
import { tasksRouter } from "./routes/tasks.js";
import { actionsRouter } from "./routes/actions.js";
import { projectDetailRouter } from "./routes/projectDetail.js";
import { ideaDetailRouter } from "./routes/ideaDetail.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

// API routes
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

// Serve built frontend — resolve relative to deployment directory
const clientDist = process.env.CLIENT_DIST || path.resolve(new URL(".", import.meta.url).pathname, "../../client/dist");
app.use(express.static(clientDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

const server = createServer(app);
setupWebSocket(server);
startWatchers();
server.listen(PORT, HOST, () => {
  console.log(`Command Center running on http://${HOST}:${PORT}`);
});
