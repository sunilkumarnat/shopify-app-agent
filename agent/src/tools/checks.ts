import { runCommand, type CommandRunner } from "./exec.ts";

export interface Check {
  name: string;
  cmd: string;
  args: string[];
}

export interface CheckResult {
  name: string;
  passed: boolean;
  output: string;
}

// Machine checks every build step must pass (docs/design.md, section 3).
export const DEFAULT_CHECKS: Check[] = [
  { name: "typecheck", cmd: "npx", args: ["tsc", "--noEmit"] },
  { name: "lint", cmd: "npm", args: ["run", "lint", "--if-present"] },
  { name: "test", cmd: "npm", args: ["test", "--if-present"] },
  { name: "shopify app build", cmd: "shopify", args: ["app", "build"] },
];

const MAX_OUTPUT_CHARS = 4_000;

export async function runChecks(
  cwd: string,
  checks: Check[] = DEFAULT_CHECKS,
  runner: CommandRunner = runCommand,
): Promise<{ passed: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const { code, stdout, stderr } = await runner(check.cmd, check.args, { cwd });
    // Keep the tail, where compilers and test runners put the summary the fixer needs.
    const output = (stdout + stderr).slice(-MAX_OUTPUT_CHARS);
    results.push({ name: check.name, passed: code === 0, output });
  }
  return { passed: results.every((r) => r.passed), results };
}
