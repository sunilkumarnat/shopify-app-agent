import { runCommand, type CommandRunner } from "./exec.ts";
import { checkPolarisOnly } from "./polaris-check.ts";

// A check is a command, or a function run in-process on the app folder.
export type Check =
  | { name: string; cmd: string; args: string[] }
  | { name: string; run: (cwd: string) => Promise<{ passed: boolean; output: string }> };

export interface CheckResult {
  name: string;
  passed: boolean;
  output: string;
}

// Machine checks every build step must pass (docs/design.md, section 3).
export const DEFAULT_CHECKS: Check[] = [
  { name: "typecheck", cmd: "npm", args: ["run", "typecheck", "--if-present"] },
  { name: "lint", cmd: "npm", args: ["run", "lint", "--if-present"] },
  { name: "test", cmd: "npm", args: ["test", "--if-present"] },
  { name: "shopify app build", cmd: "shopify", args: ["app", "build"] },
  { name: "polaris web components only", run: checkPolarisOnly },
];

const MAX_OUTPUT_CHARS = 4_000;

export async function runChecks(
  cwd: string,
  checks: Check[] = DEFAULT_CHECKS,
  runner: CommandRunner = runCommand,
): Promise<{ passed: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    if ("run" in check) {
      const { passed, output } = await check.run(cwd);
      results.push({ name: check.name, passed, output: output.slice(0, MAX_OUTPUT_CHARS) });
      continue;
    }
    const { code, stdout, stderr } = await runner(check.cmd, check.args, { cwd });
    // Keep the tail, where compilers and test runners put the summary the fixer needs.
    const output = (stdout + stderr).slice(-MAX_OUTPUT_CHARS);
    results.push({ name: check.name, passed: code === 0, output });
  }
  return { passed: results.every((r) => r.passed), results };
}
