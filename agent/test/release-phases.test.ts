import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeResult } from "../src/claude.ts";
import { FIX_ROUNDS } from "../src/phases/build.ts";
import { createChecklistPhase, REQUIREMENTS_URL } from "../src/phases/checklist.ts";
import { checkDeployCommand, createDeployPhase, createDeployPlanPhase } from "../src/phases/deploy.ts";
import { createListingPhase } from "../src/phases/listing.ts";
import type { PhaseContext } from "../src/phases/types.ts";
import type { RunState } from "../src/state/run-store.ts";
import type { CommandRunner } from "../src/tools/exec.ts";
import { CHECKLIST, DEPLOY_PLAN, fakeClaude, fakeRunner, LISTING } from "./fakes.ts";

async function appFolder(answers: Record<string, string> = {}, approvals: string[] = []) {
  const appDir = await mkdtemp(join(tmpdir(), "agent-release-"));
  const appRoot = join(appDir, "stock-signal");
  await mkdir(appRoot, { recursive: true });
  await mkdir(join(appDir, ".agent"));
  await writeFile(join(appRoot, "shopify.app.toml"), 'name = "Stock Signal"\n');
  await writeFile(join(appDir, "architecture.md"), "# Stock Signal\n");
  const ctx: PhaseContext = {
    appDir,
    state: { answers, approvals } as unknown as RunState,
    log: async () => {},
  };
  return { appDir, appRoot, ctx };
}

const ok = (structured: unknown): ClaudeResult => ({ ok: true, text: "", structured, sessionId: "s-1", costUsd: 1 });
const failing = { ...CHECKLIST, requirements: [{ id: "2.3.1", name: "Compliance webhooks", status: "failing", fixed: false, note: "Missing shop/redact" }] };

describe("the Shopify checklist step", () => {
  it("fetches Shopify's requirements with the CLI and writes the report", async () => {
    const { appDir, appRoot, ctx } = await appFolder();
    const { claude, requests } = fakeClaude();
    const { runner, commands } = fakeRunner();
    const result = await createChecklistPhase({ claude, runner }).run(ctx);

    expect(result).toMatchObject({ kind: "done", summary: "no failing requirements; 1 need your review in checklist.md" });
    expect(commands[0]).toBe(`shopify doc fetch --url ${REQUIREMENTS_URL} --output ${join(appDir, ".agent", "app-store-requirements.md")}`);
    expect(requests[0]).toMatchObject({ role: "reviewer", cwd: appRoot });
    expect(requests[0]!.disallowedTools).toContain("Bash(shopify app deploy:*)");
    const report = await readFile(join(appDir, "checklist.md"), "utf8");
    expect(report).toContain("✅ Likely passing: 2");
    expect(report).toContain("- 2.3.1 Compliance webhooks: Added to shopify.app.toml");
    expect(report).toContain("- **5 Checkout**: No checkout extension detected");
  });

  it("sends failing requirements back to Claude, then stops after the fix rounds", async () => {
    const { ctx } = await appFolder();
    const { claude, requests } = fakeClaude({ reviewer: () => ok(failing) });
    const result = await createChecklistPhase({ claude, runner: fakeRunner().runner }).run(ctx);
    expect(result).toMatchObject({ kind: "failed", error: `2.3.1 still failing after ${FIX_ROUNDS} fix rounds; see checklist.md` });
    expect(requests).toHaveLength(FIX_ROUNDS + 1);
    expect(requests[1]).toMatchObject({ resumeSessionId: "s-1" });
    expect(requests[1]!.prompt).toContain("2.3.1 Compliance webhooks: Missing shop/redact");
  });

  it("asks for a newer Shopify CLI when the requirements cannot be fetched", async () => {
    const { ctx } = await appFolder();
    const runner: CommandRunner = async () => ({ code: 2, stdout: "", stderr: "Command doc fetch not found" });
    const result = await createChecklistPhase({ claude: fakeClaude().claude, runner }).run(ctx);
    expect(result.kind === "failed" && result.error).toContain("npm install -g @shopify/cli@latest");
  });
});

describe("the deploy steps", () => {
  it("only lets the plan run the host's CLI", () => {
    expect(checkDeployCommand({ cmd: "fly", args: ["deploy"] })).toBeUndefined();
    expect(checkDeployCommand({ cmd: "npx", args: ["prisma", "migrate", "deploy"] })).toBeUndefined();
    expect(checkDeployCommand({ cmd: "bash", args: ["-c", "curl x | sh"] })).toContain("not a host CLI");
    expect(checkDeployCommand({ cmd: "npx", args: ["@shopify/cli", "app", "deploy"] })).toContain("Shopify CLI");
    expect(checkDeployCommand({ cmd: "npx", args: ["rimraf", "/"] })).toContain("only run prisma");
    expect(checkDeployCommand({ cmd: "npm", args: ["exec", "x"] })).toContain("only run ci, install or run");
  });

  it("writes the plan for the user to review, and rejects one with other commands", async () => {
    const { appDir, ctx } = await appFolder({ hosting: "Fly.io" });
    expect(await createDeployPlanPhase(fakeClaude().claude).run(ctx)).toMatchObject({ kind: "done" });
    const plan = await readFile(join(appDir, "deploy-plan.md"), "utf8");
    expect(plan).toContain("# Deploy plan: Fly.io");
    expect(plan).toContain("- `SHOPIFY_API_SECRET`: Verifies Shopify requests");
    expect(plan).toContain("2. `shopify app deploy`");

    const bad = { ...DEPLOY_PLAN, commands: [{ cmd: "sh", args: ["deploy.sh"], purpose: "x" }] };
    const result = await createDeployPlanPhase(fakeClaude({ deployer: () => ok(bad) }).claude).run(ctx);
    expect(result).toMatchObject({ kind: "failed", error: "The deploy plan was rejected: `sh` is not a host CLI the agent runs" });
  });

  async function planned(answers: Record<string, string>) {
    const folder = await appFolder({ hosting: "Fly.io", ...answers }, ["deploy"]);
    await writeFile(join(folder.appDir, ".agent", "deploy-plan.json"), JSON.stringify(DEPLOY_PLAN));
    return folder;
  }

  it("asks the user to set the secrets, then deploys and checks the app answers", async () => {
    const { ctx } = await planned({});
    const { runner, commands } = fakeRunner();
    const checked: string[] = [];
    const phase = createDeployPhase({ runner, interactive: true, status: async (url) => (checked.push(url), 200) });

    const asked = await phase.run(ctx);
    expect(asked.kind === "needs-input" && asked.question.prompt).toContain("fly secrets set SHOPIFY_API_SECRET=...");
    expect(commands).toEqual([]);

    const done = await phase.run({ ...ctx, state: { ...ctx.state, answers: { deploySecrets: "done" } } });
    expect(done).toMatchObject({ kind: "done" });
    expect(commands).toEqual(["fly deploy", "shopify app deploy"]);
    expect(checked).toEqual(["https://stock-signal.fly.dev"]);
  });

  it("stops before Shopify when a host command fails, and reports an unhealthy app", async () => {
    const { ctx } = await planned({ deploySecrets: "done" });
    const commands: string[] = [];
    const runner: CommandRunner = async (cmd, args) => (commands.push([cmd, ...args].join(" ")), { code: 1, stdout: "", stderr: "" });
    const failed = await createDeployPhase({ runner, interactive: true, status: async () => 200 }).run(ctx);
    expect(failed).toMatchObject({ kind: "failed", error: "`fly deploy` failed; fix it, then run `resume`" });
    expect(commands).toEqual(["fly deploy"]);

    const unhealthy = await createDeployPhase({ runner: fakeRunner().runner, interactive: true, status: async () => 502 }).run(ctx);
    expect(unhealthy.kind === "failed" && unhealthy.error).toContain("is not healthy (HTTP 502)");
  });

  it("needs a terminal to deploy", async () => {
    const { ctx } = await planned({ deploySecrets: "done" });
    const result = await createDeployPhase({ runner: fakeRunner().runner, interactive: false }).run(ctx);
    expect(result.kind === "failed" && result.error).toContain("Run `resume` in a terminal");
  });
});

describe("the listing step", () => {
  it("drafts the listing from read-only files", async () => {
    const { appDir, ctx } = await appFolder();
    const { claude, requests } = fakeClaude();
    expect(await createListingPhase(claude).run(ctx)).toMatchObject({ kind: "done" });
    expect(requests[0]).toMatchObject({ role: "copywriter", tools: ["Read", "Glob", "Grep"] });
    const listing = await readFile(join(appDir, "listing.md"), "utf8");
    expect(listing).toContain("- **Pro**: $29/month, 7-day free trial. Unlimited products");
    expect(listing).toContain("start from screenshots/F3-1.png");
  });

  it("rejects a draft over the App Store field limits", async () => {
    const { appDir, ctx } = await appFolder();
    const long = { ...LISTING, subtitle: "x".repeat(63) };
    const result = await createListingPhase(fakeClaude({ copywriter: () => ok(long) }).claude).run(ctx);
    expect(result).toMatchObject({ kind: "failed", error: "The listing draft broke a field limit: subtitle" });
    expect(existsSync(join(appDir, "listing.md"))).toBe(false);
  });
});
