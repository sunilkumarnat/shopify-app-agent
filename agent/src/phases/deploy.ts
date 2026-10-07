import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { outputSchemaOf, type ClaudeRunner } from "../claude.ts";
import { findAppRoot } from "../tools/app-root.ts";
import { runCommand, type CommandRunner } from "../tools/exec.ts";
import { shopifyCli } from "../tools/shopify-cli.ts";
import { BUILDER_ALLOWED, BUILDER_DENIED, BUILDER_TOOLS } from "./build.ts";
import type { Phase } from "./types.ts";

// Host CLIs a deploy plan may run. Anything else, including Shopify CLI (the agent runs
// `shopify app deploy` itself) and shells, is rejected.
export const HOST_CLIS = ["fly", "flyctl", "heroku", "render", "railway", "gcloud", "vercel", "docker", "npm", "npx"];

export const DeployPlanSchema = z.object({
  appUrl: z.url({ protocol: /^https$/ }).describe("The public HTTPS URL the app will be served from"),
  summary: z.string().describe("Two or three sentences: where and how the app is hosted"),
  files: z.array(z.string()).describe("Files you created or changed for hosting, relative to the app root"),
  secrets: z
    .array(z.object({ name: z.string(), purpose: z.string(), howToSet: z.string() }))
    .describe("Environment variables the user must set with the host; never their values"),
  commands: z
    .array(z.object({ cmd: z.string(), args: z.array(z.string()), purpose: z.string() }))
    .describe("Commands that create and deploy the hosted app, in order, run from the app root"),
});
export type DeployPlan = z.infer<typeof DeployPlanSchema>;

export function checkDeployCommand({ cmd, args }: { cmd: string; args: string[] }): string | undefined {
  if (!HOST_CLIS.includes(cmd)) return `\`${cmd}\` is not a host CLI the agent runs`;
  if (args.some((a) => /^shopify(@|$)/.test(a) || a.startsWith("@shopify/cli"))) return "Shopify CLI is run by the agent, not the plan";
  if (cmd === "npx" && args[0] !== "prisma") return "`npx` may only run prisma";
  if (cmd === "npm" && !["ci", "install", "run"].includes(args[0] ?? "")) return "`npm` may only run ci, install or run";
  return undefined;
}

const PLAN_PROMPT = `You prepare a Shopify app (React Router template, Prisma) for production hosting. You only write files; the user runs the deploy after confirming your plan.

Rules:
- Use the host the user named. Add the files it needs (for example a Dockerfile and fly.toml for Fly.io), a production database (Postgres) with Prisma migrations run on release, and a health endpoint if the template has none.
- Set application_url and the auth redirect URLs in shopify.app.toml to the app URL you choose.
- List every secret the app needs (SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES, SHOPIFY_APP_URL, DATABASE_URL and any the app adds) with how to set it on this host. Never write secret values anywhere.
- Commands must use the host's own CLI (${HOST_CLIS.join(", ")}) and must not run Shopify CLI.
- Never read, print or edit .env files or secrets. Never deploy, release or push.`;

function planMarkdown(plan: DeployPlan, host: string): string {
  return [
    `# Deploy plan: ${host}`,
    "",
    plan.summary,
    "",
    `App URL: ${plan.appUrl}`,
    "",
    "## Files prepared",
    "",
    ...plan.files.map((f) => `- \`${f}\``),
    "",
    "## Secrets you set (the agent never sees the values)",
    "",
    ...(plan.secrets.length ? plan.secrets.map((s) => `- \`${s.name}\`: ${s.purpose}. ${s.howToSet}`) : ["None."]),
    "",
    "## What runs after you confirm",
    "",
    ...plan.commands.map((c, i) => `${i + 1}. \`${[c.cmd, ...c.args].join(" ")}\`: ${c.purpose}`),
    `${plan.commands.length + 1}. \`shopify app deploy\`: releases the app's configuration and extensions as a new app version`,
    `${plan.commands.length + 2}. A health check on ${plan.appUrl}`,
    "",
  ].join("\n");
}

const planFile = (appDir: string) => join(appDir, ".agent", "deploy-plan.json");

// Step 10, before the deploy confirmation: Claude prepares hosting files for the host the user
// named and writes deploy-plan.md, which the user reviews when asked to confirm the deploy.
export const createDeployPlanPhase = (claude: ClaudeRunner): Phase => ({
  name: "deploy-plan",
  async run({ appDir, state, log }) {
    const appRoot = await findAppRoot(appDir);
    if (!appRoot) return { kind: "failed", error: "No scaffolded app found; the scaffold step must run first" };
    const host = state.answers.hosting?.trim() ?? "";

    const result = await claude({
      role: "deployer",
      prompt: `Prepare this app to be hosted on: ${host}\n\nThe app's architecture is in ${join(appDir, "architecture.md")}.`,
      systemPrompt: PLAN_PROMPT,
      cwd: appRoot,
      tools: BUILDER_TOOLS,
      allowedTools: BUILDER_ALLOWED,
      disallowedTools: BUILDER_DENIED,
      outputSchema: outputSchemaOf(DeployPlanSchema),
    });
    await log("claude.deploy-plan", { ok: result.ok, costUsd: result.costUsd });
    if (!result.ok) return { kind: "failed", error: `Claude could not prepare the deploy: ${result.error}` };
    const plan = DeployPlanSchema.safeParse(result.structured);
    if (!plan.success) return { kind: "failed", error: "Claude's deploy plan did not match the expected format" };
    const rejected = plan.data.commands.map(checkDeployCommand).find(Boolean);
    if (rejected) return { kind: "failed", error: `The deploy plan was rejected: ${rejected}` };

    await writeFile(planFile(appDir), JSON.stringify(plan.data, null, 2));
    await writeFile(join(appDir, "deploy-plan.md"), planMarkdown(plan.data, host));
    return { kind: "done", summary: `deploy plan for ${host} written to deploy-plan.md` };
  },
});

export type HttpStatus = (url: string) => Promise<number>;

const httpStatus: HttpStatus = async (url) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(20_000) })).status;
  } catch {
    return 0;
  }
};

export interface DeployDeps {
  runner?: CommandRunner;
  interactive: boolean;
  status?: HttpStatus;
}

// Step 10, after the user confirms: runs the plan's host commands in the terminal (the user logs
// in to the host there), then `shopify app deploy`, then checks the app answers on its URL.
export const createDeployPhase = ({ runner = runCommand, interactive, status = httpStatus }: DeployDeps): Phase => ({
  name: "deploy",
  gatesBefore: ["deploy"],
  maxAttempts: 1,
  async run({ appDir, state, log }) {
    const appRoot = await findAppRoot(appDir);
    if (!appRoot) return { kind: "failed", error: "No scaffolded app found; the scaffold step must run first" };
    const plan = DeployPlanSchema.parse(JSON.parse(await readFile(planFile(appDir), "utf8")));

    if (plan.secrets.length && !state.answers.deploySecrets?.trim()) {
      const list = plan.secrets.map((s) => `  ${s.name}: ${s.howToSet}`).join("\n");
      return {
        kind: "needs-input",
        question: {
          id: "deploySecrets",
          prompt: `Set these secrets with your host yourself. Never type their values here.\n${list}\nType \`done\` when they are set.`,
        },
      };
    }
    if (!interactive) {
      return { kind: "failed", error: "Deploying needs you to log in to your host and Shopify. Run `resume` in a terminal." };
    }

    for (const command of plan.commands) {
      const rejected = checkDeployCommand(command);
      if (rejected) return { kind: "failed", error: `The deploy plan was rejected: ${rejected}` };
      console.log(`\n${command.purpose}: ${[command.cmd, ...command.args].join(" ")}\n`);
      const { code } = await runner(command.cmd, command.args, { cwd: appRoot, interactive: true });
      await log("deploy.command", { cmd: command.cmd, args: command.args, code });
      if (code !== 0) return { kind: "failed", error: `\`${[command.cmd, ...command.args].join(" ")}\` failed; fix it, then run \`resume\`` };
    }

    const deployed = await shopifyCli(["app", "deploy"], { cwd: appRoot, approvals: state.approvals, interactive: true, runner });
    await log("shopify.app-deploy", { code: deployed.code });
    if (deployed.code !== 0) return { kind: "failed", error: "`shopify app deploy` failed; fix it, then run `resume`" };

    const code = await status(plan.appUrl);
    await log("deploy.health", { url: plan.appUrl, status: code });
    if (code === 0 || code >= 500) {
      return { kind: "failed", error: `The app at ${plan.appUrl} is not healthy (HTTP ${code || "no response"}); check your host's logs, then run \`resume\`` };
    }
    return { kind: "done", summary: `deployed to ${plan.appUrl} (HTTP ${code}) and released a new app version` };
  },
});
