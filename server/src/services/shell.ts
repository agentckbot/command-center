import { execFile } from "child_process";
import { OPENCLAW_DIR } from "./paths.js";

export function run(cmd: string, args: string[], timeout = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          OPENCLAW_HOME: OPENCLAW_DIR,
        },
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      }
    );
  });
}
