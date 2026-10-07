import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeResult } from "../src/claude.ts";
import { loadEvalApps, type EvalApp } from "../src/evals/eval-app.ts";
import { evalReport, runEval } from "../src/evals/run.ts";
import { scoreAppConfig, scoreArchitecture } from "../src/evals/score.ts";
import { ARCHITECTURE_SECTIONS } from "../src/phases/architecture.ts";
import type { AppSpec } from "../src/state/spec.ts";
import { fakeClaude, fakeRunner } from "./fakes.ts";

const APPS_DIR = resolve(import.meta.dirname, "../../evals/apps");

const GOOD_ARCHITECTURE = [
  ...ARCHITECTURE_SECTIONS.map((s) => `## ${s}\n\nDetails.`),
  "Free and Pro plans. Threshold in a product metafield, rendered by the app block in blocks/badge.liquid.",
  "Webhooks: customers/data_request, customers/redact, shop/redact.",
].join("\n\n");

const spec = (overrides: Partial<AppSpec> = {}): AppSpec => ({
  name: "Stock Signal",
  description: "d",
  functionalities: ["a"],
  flow: "f",
  surfaces: ["embedded-admin", "theme-extension"],
  plans: [],
  scopes: ["write_products"],
  ...overrides,
});

async function stockSignal(): Promise<EvalApp> {
  return (await loadEvalApps(APPS_DIR, ["stock-signal"]))[0]!;
}

describe("eval apps", () => {
  it("are valid and each answers every question the agent asks", async () => {
    const apps = await loadEvalApps(APPS_DIR);
    expect(apps.map((a) => a.id)).toEqual(["back-in-stock", "order-tagger", "size-chart", "stock-signal"]);
    for (const app of apps) {
      for (const id of ["name", "description", "functionalities", "flow", "hasPlans", "developerAccount", "devStore"]) {
        expect(app.answers[id], `${app.id}: ${id}`).toBeTruthy();
      }
      if (/^y/i.test(app.answers.hasPlans!)) expect(app.answers.plans, app.id).toBeTruthy();
    }
  });
});

describe("scoring an architecture", () => {
  it("passes a complete one, counting write scopes as granting read", async () => {
    const checks = scoreArchitecture(await stockSignal(), spec(), GOOD_ARCHITECTURE);
    expect(checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("names what is missing", async () => {
    const architecture = GOOD_ARCHITECTURE.replace("## Webhooks", "## Hooks").replace("shop/redact", "");
    const checks = scoreArchitecture(await stockSignal(), spec({ scopes: ["read_orders"], surfaces: ["embedded-admin"] }), architecture);
    expect(checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`)).toEqual([
      "architecture has every section in order: missing or out of order: Webhooks",
      "surfaces are embedded-admin + theme-extension: got embedded-admin",
      "requests every required scope: missing read_products",
      "requests no forbidden scope: requested read_orders",
      "includes the compliance webhooks: missing shop/redact",
    ]);
  });

  it("checks the built app's shopify.app.toml", async () => {
    const toml = 'scopes = "write_products,read_orders"\n[webhooks]\ncompliance_topics = ["customers/data_request", "customers/redact"]\n';
    const failed = scoreAppConfig(await stockSignal(), toml).filter((c) => !c.passed);
    expect(failed.map((c) => c.detail)).toEqual(["has read_orders", "missing shop/redact"]);
  });
});

describe("running an eval", () => {
  const goodArchitect = (): ClaudeResult => ({
    ok: true,
    text: "",
    structured: { summary: "s", surfaces: ["embedded-admin", "theme-extension"], scopes: ["write_products"], architectureMarkdown: GOOD_ARCHITECTURE },
    sessionId: "a",
    costUsd: 0.5,
  });

  it("plays the user up to the architecture, then scores it and the criteria", async () => {
    const app = await stockSignal();
    const { claude, requests } = fakeClaude({ architect: goodArchitect });
    const dir = join(await mkdtemp(join(tmpdir(), "eval-")), app.id);
    const result = await runEval(app, dir, "architecture", { claude, runner: fakeRunner().runner, interactive: false });

    expect(requests.map((r) => r.role)).toEqual(["architect", "grader"]);
    expect(requests[1]!.prompt).toContain("1. The badge shows only when");
    expect(result).toMatchObject({ app: "stock-signal", score: 1, passed: true, costUsd: 1.5 });
    expect(result.checks).toHaveLength(13);
    expect(evalReport([result])).toContain("| stock-signal | architecture | 100% | 13/13 | $1.50 | Pass |");
  });

  it("fails an app whose architecture scores below its minimum", async () => {
    const app = await stockSignal();
    const { claude } = fakeClaude();
    const dir = join(await mkdtemp(join(tmpdir(), "eval-")), app.id);
    const result = await runEval(app, dir, "architecture", { claude, runner: fakeRunner().runner, interactive: false });
    expect(result.passed).toBe(false);
    expect(evalReport([result])).toContain("- architecture has every section in order: missing or out of order: Functionalities");
  });

  it("in build mode, gives the confirmations, builds, and checks shopify.app.toml", async () => {
    const app = await stockSignal();
    const { claude, requests } = fakeClaude({ architect: goodArchitect });
    const { runner, commands } = fakeRunner();
    const dir = join(await mkdtemp(join(tmpdir(), "eval-")), app.id);
    const result = await runEval(app, dir, "build", { claude, runner, interactive: true });

    expect(requests.map((r) => r.role)).toEqual(["architect", "builder", "grader"]);
    expect(commands.some((c) => c.startsWith("shopify app init"))).toBe(true);
    expect(commands.some((c) => c.startsWith("npx playwright"))).toBe(false);
    const names = result.checks.map((c) => c.name);
    expect(names).toContain("app builds with every check green");
    expect(result.checks.find((c) => c.name === "app builds with every check green")!.passed).toBe(true);
    // The fake scaffold's shopify.app.toml has no scopes or webhooks yet.
    expect(result.checks.find((c) => c.name === "shopify.app.toml has the required scopes")!.passed).toBe(false);
  });
});
