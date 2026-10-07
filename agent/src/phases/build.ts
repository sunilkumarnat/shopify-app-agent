import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeRunner } from "../claude.ts";
import { findAppRoot } from "../tools/app-root.ts";
import { runChecks, type CheckResult } from "../tools/checks.ts";
import type { CommandRunner } from "../tools/exec.ts";
import { POLARIS_RULE } from "../tools/polaris-check.ts";
import type { Phase } from "./types.ts";

export const FIX_ROUNDS = 3;

export const BUILDER_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];

// Commands the builder may run without asking. Everything else is denied.
export const BUILDER_ALLOWED = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash(npm install:*)",
  "Bash(npm run:*)",
  "Bash(npm test:*)",
  "Bash(npx prisma:*)",
  "Bash(npx tsc:*)",
  "Bash(shopify app build:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(ls:*)",
];

export const BUILDER_DENIED = ["Bash(shopify app deploy:*)", "Bash(shopify app release:*)", "Bash(git push:*)"];

const SYSTEM_PROMPT = `You are building a Shopify app inside a project scaffolded by Shopify CLI from the React Router template (TypeScript). Implement exactly the architecture you are given.

Rules:
- Follow the template's conventions: routes under app/routes, authenticate admin requests with the template's shopify.server helpers, keep Prisma models in prisma/schema.prisma with a migration.
- ${POLARIS_RULE} Every admin screen has loading, empty and error states. Storefront features go in the theme app extension under extensions/ as app blocks or app embeds.
- Use Admin GraphQL only, never REST. Handle pagination and userErrors.
- Declare access scopes and webhook subscriptions (including the compliance webhooks) in shopify.app.toml. Request only the scopes in the architecture.
- For paid plans, implement the plans exactly as the architecture describes and gate each feature on the active plan.
- Write tests for the logic you add, and make \`npm run typecheck\`, \`npm run lint\`, \`npm test\` and \`shopify app build\` pass.
- Never read, print or edit .env files or secrets. Never deploy, release or push.
- Finish with a short summary of what you built and anything you could not do.`;

const failureReport = (results: CheckResult[]) =>
  results
    .filter((r) => !r.passed)
    .map((r) => `### ${r.name}\n\`\`\`\n${r.output}\n\`\`\``)
    .join("\n\n");

export const createBuildPhase = ({ claude, runner }: { claude: ClaudeRunner; runner?: CommandRunner }): Phase => ({
  name: "build",
  maxAttempts: 1,
  async run({ appDir, log }) {
    const appRoot = await findAppRoot(appDir);
    if (!appRoot) return { kind: "failed", error: "No scaffolded app found; the scaffold step must run first" };
    const architecture = await readFile(join(appDir, "architecture.md"), "utf8");

    let session = await claude({
      role: "builder",
      prompt: `Build this app in the current project.\n\n${architecture}`,
      systemPrompt: SYSTEM_PROMPT,
      cwd: appRoot,
      tools: BUILDER_TOOLS,
      allowedTools: BUILDER_ALLOWED,
      disallowedTools: BUILDER_DENIED,
    });
    await log("claude.build", { ok: session.ok, costUsd: session.costUsd });
    if (!session.ok) return { kind: "failed", error: `Claude could not build the app: ${session.error}` };

    for (let round = 0; ; round++) {
      const checks = await runChecks(appRoot, undefined, runner);
      await log("checks", { round, results: checks.results.map(({ name, passed }) => ({ name, passed })) });
      if (checks.passed) return { kind: "done", summary: `built; all checks pass after ${round} fix round(s)` };

      const failing = checks.results.filter((r) => !r.passed).map((r) => r.name);
      if (round >= FIX_ROUNDS) {
        return { kind: "failed", error: `checks still failing after ${FIX_ROUNDS} fix rounds: ${failing.join(", ")}` };
      }

      session = await claude({
        role: "builder",
        prompt: `These checks fail. Fix the code so they pass, without disabling or skipping any check or test.\n\n${failureReport(checks.results)}`,
        systemPrompt: SYSTEM_PROMPT,
        cwd: appRoot,
        tools: BUILDER_TOOLS,
        allowedTools: BUILDER_ALLOWED,
        disallowedTools: BUILDER_DENIED,
        resumeSessionId: session.sessionId,
      });
      await log("claude.fix", { round: round + 1, ok: session.ok, costUsd: session.costUsd });
      if (!session.ok) return { kind: "failed", error: `Claude could not fix the failing checks: ${session.error}` };
    }
  },
});
