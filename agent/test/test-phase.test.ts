import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIX_ROUNDS } from "../src/phases/build.ts";
import { createTestPhase, storeDomain } from "../src/phases/test.ts";
import type { PhaseContext } from "../src/phases/types.ts";
import type { RunState } from "../src/state/run-store.ts";
import { resultsByFunctionality } from "../src/tools/playwright-report.ts";
import { fakeClaude, fakeRunner } from "./fakes.ts";

const FUNCTIONALITIES = ["Pick products", "Set a threshold", "Show the badge on product pages"];

async function setup(answers: Record<string, string>, failingTestRuns = 0) {
  const appDir = await mkdtemp(join(tmpdir(), "agent-test-"));
  const appRoot = join(appDir, "stock-signal");
  await mkdir(join(appRoot, "extensions", "theme-extension", "blocks"), { recursive: true });
  await writeFile(join(appRoot, "shopify.app.toml"), 'client_id = "abc123"\nname = "Stock Signal"\n');
  await writeFile(join(appRoot, "extensions", "theme-extension", "blocks", "stock-badge.liquid"), "");
  await writeFile(
    join(appDir, "spec.json"),
    JSON.stringify({ name: "Stock Signal", description: "d", functionalities: FUNCTIONALITIES, flow: "f", surfaces: ["embedded-admin", "theme-extension"] }),
  );
  await writeFile(join(appDir, "architecture.md"), "# Stock Signal\n");
  await mkdir(join(appDir, ".agent"));

  const { claude, requests } = fakeClaude();
  const { runner, commands } = fakeRunner({ failingTestRuns });
  const ctx: PhaseContext = {
    appDir,
    state: { answers, approvals: [] } as unknown as RunState,
    log: async () => {},
  };
  return { appDir, appRoot, ctx, requests, commands, phase: createTestPhase({ claude, runner }) };
}

describe("the test phase", () => {
  it("asks the user to start the app on the store and add the theme block", async () => {
    const { ctx, phase, appRoot, requests } = await setup({ devStore: "stock-signal-dev" });
    const result = await phase.run(ctx);
    expect(result.kind).toBe("needs-input");
    const prompt = result.kind === "needs-input" ? result.question.prompt : "";
    expect(prompt).toContain(`cd ${appRoot}`);
    expect(prompt).toContain("shopify app dev --store stock-signal-dev.myshopify.com");
    expect(prompt).toContain("addAppBlockId=abc123/stock-badge");
    expect(requests).toHaveLength(0);
  });

  it("has Claude write a test per functionality, runs them, and writes the report", async () => {
    const { ctx, phase, appDir, appRoot, requests, commands } = await setup({ devStore: "https://stock-signal-dev.myshopify.com/", testPreview: "ready" });
    const result = await phase.run(ctx);
    expect(result).toMatchObject({ kind: "done" });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ role: "tester", cwd: appRoot });
    expect(requests[0]!.prompt).toContain("[F3] Show the badge on product pages");
    expect(requests[0]!.disallowedTools).toContain("Bash(shopify app deploy:*)");
    expect(commands).toContain("npx playwright test --reporter=json");
    expect(commands).toContain("shopify app build");

    const report = await readFile(join(appDir, "test-report.md"), "utf8");
    expect(report).toContain("| F3 | Show the badge on product pages | Pass | 1 |");
    expect(report).toContain("![F2-1.png](screenshots/F2-1.png)");
    expect(existsSync(join(appDir, "screenshots", "F3-1.png"))).toBe(true);
  });

  it("sends failing tests back to Claude in the same session", async () => {
    const { ctx, phase, requests } = await setup({ devStore: "stock-signal-dev", testPreview: "ready" }, 1);
    expect(await phase.run(ctx)).toMatchObject({ kind: "done" });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ resumeSessionId: "build-1" });
    expect(requests[1]!.prompt).toContain("[F2] Set a threshold");
    expect(requests[1]!.prompt).toContain("toBeVisible() failed");
  });

  it("stops after the fix rounds and names the failing functionalities", async () => {
    const { ctx, phase, appDir } = await setup({ devStore: "stock-signal-dev", testPreview: "ready" }, 99);
    const result = await phase.run(ctx);
    expect(result).toMatchObject({ kind: "failed" });
    expect(result.kind === "failed" && result.error).toBe(`functionalities F2, F3 still failing after ${FIX_ROUNDS} fix rounds; see test-report.md`);
    expect(await readFile(join(appDir, "test-report.md"), "utf8")).toContain("| F2 | Set a threshold | Fail | 1 |");
  });
});

describe("reading the Playwright report", () => {
  it("fails functionalities with no test or only skipped tests", () => {
    const report = {
      suites: [
        {
          specs: [
            { title: "[F1] works", ok: true, tests: [{ status: "expected", results: [{ status: "passed" }] }] },
            { title: "[F2] later", ok: true, tests: [{ status: "skipped", results: [{ status: "skipped" }] }] },
          ],
        },
      ],
    };
    const results = resultsByFunctionality(report, ["a", "b", "c"]);
    expect(results.map((r) => r.passed)).toEqual([true, false, false]);
    expect(results[1]!.tests[0]!.error).toBe("skipped");
  });

  it("normalises the store answer", () => {
    expect(storeDomain("my-store")).toBe("my-store.myshopify.com");
    expect(storeDomain("https://my-store.myshopify.com/admin")).toBe("my-store.myshopify.com");
  });
});
