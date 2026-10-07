import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Promise<CommandResult>;

// Runs a command without a shell so arguments are never re-interpreted.
export const runCommand: CommandRunner = (cmd, args, { cwd, timeoutMs = 10 * 60_000 }) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, timeout: timeoutMs, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: stderr + err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
