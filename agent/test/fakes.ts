import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeRequest, ClaudeResult, ClaudeRunner } from "../src/claude.ts";
import type { CommandResult, CommandRunner } from "../src/tools/exec.ts";

export const ARCHITECTURE = {
  summary: "An embedded admin page and a product-page badge.",
  surfaces: ["embedded-admin", "theme-extension"],
  scopes: ["read_products", "read_inventory"],
  architectureMarkdown: "# Stock Signal\n\n## Overview\nBadge for low stock.",
};

// Records every Claude request and answers like a well-behaved architect and builder.
export function fakeClaude(overrides: Partial<Record<ClaudeRequest["role"], () => ClaudeResult>> = {}) {
  const requests: ClaudeRequest[] = [];
  const claude: ClaudeRunner = async (request) => {
    requests.push(request);
    const override = overrides[request.role];
    if (override) return override();
    if (request.role === "architect") {
      return { ok: true, text: "", structured: ARCHITECTURE, sessionId: "arch-1", costUsd: 0.5 };
    }
    return { ok: true, text: "built", structured: undefined, sessionId: "build-1", costUsd: 2 };
  };
  return { claude, requests };
}

// Pretends to be the Shopify CLI and npm: `app init` and `generate extension` create the files
// the real CLI would, and the check commands fail `failingRounds` times before passing.
// Playwright passes every test unless `failingTestRuns` says how many runs fail [F2] first.
export function fakeRunner({ failingRounds = 0, failingTestRuns = 0 }: { failingRounds?: number; failingTestRuns?: number } = {}) {
  const commands: string[] = [];
  let typecheckRuns = 0;
  let playwrightRuns = 0;
  const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
  const runner: CommandRunner = async (cmd, args, { cwd, env }) => {
    const line = [cmd, ...args].join(" ");
    commands.push(line);
    if (line.startsWith("shopify app init")) {
      const root = join(args[args.indexOf("--path") + 1]!, "stock-signal");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "shopify.app.toml"), 'name = "Stock Signal"\n');
    }
    if (line.startsWith("shopify app generate extension")) {
      await mkdir(join(cwd, "extensions", "theme-extension", "blocks"), { recursive: true });
    }
    if (line.startsWith("npm run typecheck")) {
      typecheckRuns++;
      if (typecheckRuns <= failingRounds) return { code: 2, stdout: "", stderr: "error TS2322: bad type" };
    }
    if (line.startsWith("npx playwright test")) {
      playwrightRuns++;
      const shot = join(cwd, "test-results", `badge-${playwrightRuns}.png`);
      await mkdir(join(cwd, "test-results"), { recursive: true });
      await writeFile(shot, "png");
      await writeFile(env!.PLAYWRIGHT_JSON_OUTPUT_NAME!, JSON.stringify(playwrightReport(playwrightRuns <= failingTestRuns, shot)));
      return { code: playwrightRuns <= failingTestRuns ? 1 : 0, stdout: "", stderr: "" };
    }
    return ok();
  };
  return { runner, commands };
}

const spec = (title: string, passed: boolean, shot?: string) => ({
  title,
  ok: passed,
  tests: [
    {
      status: passed ? "expected" : "unexpected",
      results: [
        {
          status: passed ? "passed" : "failed",
          error: passed ? undefined : { message: "expect(locator).toBeVisible() failed" },
          attachments: shot ? [{ name: "screenshot", contentType: "image/png", path: shot }] : [],
        },
      ],
    },
  ],
});

// The tests Claude would write for the three Stock Signal functionalities in process.test.ts.
const playwrightReport = (badgeFails: boolean, shot: string) => ({
  suites: [
    {
      title: "functionalities.spec.ts",
      specs: [spec("[F1] picks products", true)],
      suites: [{ title: "storefront", specs: [spec("[F2][F3] shows the badge under the threshold", !badgeFails, shot)] }],
    },
  ],
});
