import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ClaudeRunner } from "../claude.ts";
import { AppSpecSchema } from "../state/spec.ts";
import { findAppRoot } from "../tools/app-root.ts";
import { runChecks } from "../tools/checks.ts";
import { runCommand, type CommandRunner } from "../tools/exec.ts";
import { resultsByFunctionality, type FunctionalityResult, type PwReport } from "../tools/playwright-report.ts";
import { FIX_ROUNDS } from "./build.ts";
import { POLARIS_RULE } from "../tools/polaris-check.ts";
import type { Phase } from "./types.ts";

const TESTER_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];

const TESTER_ALLOWED = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash(npm install:*)",
  "Bash(npm run:*)",
  "Bash(npm test:*)",
  "Bash(npx playwright:*)",
  "Bash(npx tsc:*)",
  "Bash(shopify app build:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(ls:*)",
];

const TESTER_DENIED = ["Bash(shopify app deploy:*)", "Bash(shopify app release:*)", "Bash(git push:*)"];

const SYSTEM_PROMPT = `You test a Shopify app that is installed on a development store and running with \`shopify app dev\`. Prove that every functionality works with Playwright tests.

Rules:
- Add @playwright/test as a dev dependency, install Chromium with \`npx playwright install chromium\`, and put the tests in tests/functionalities/ with a playwright.config.ts that sets \`use: { screenshot: "on" }\`.
- Write at least one test per functionality. Start every test title with the functionality's tag, for example "[F2] shows the badge when stock is low". A test may carry several tags.
- Storefront features: open the store's pages in the browser and assert what shoppers see, including that the theme app block renders. If the storefront is password protected, enter the password from the SHOPIFY_STOREFRONT_PASSWORD environment variable; never hardcode or print it.
- The embedded admin needs a Shopify login that a headless browser does not have. Test admin features by calling the app's own route loaders, actions and helpers directly from Playwright tests, mocking only the Admin GraphQL client.
- Never skip, disable or weaken a test to make it pass. When a test fails because the app is wrong, fix the app; when the test itself is wrong, fix the test.
- When you change admin UI: ${POLARIS_RULE}
- Never read, print or edit .env files or secrets. Never deploy, release or push.
- Finish with a short summary of what each test proves.`;

// The store may be answered as a name, a domain or a URL.
export const storeDomain = (answer: string) => {
  const host = answer.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return host.includes(".") ? host : `${host}.myshopify.com`;
};

async function themeBlocks(appRoot: string): Promise<string[]> {
  const extensions = join(appRoot, "extensions");
  if (!existsSync(extensions)) return [];
  const blocks: string[] = [];
  for (const ext of await readdir(extensions)) {
    const dir = join(extensions, ext, "blocks");
    if (!existsSync(dir)) continue;
    blocks.push(...(await readdir(dir)).filter((f) => f.endsWith(".liquid")).map((f) => basename(f, ".liquid")));
  }
  return blocks;
}

async function previewPrompt(appRoot: string, store: string, hasThemeExtension: boolean): Promise<string> {
  const lines = [
    "Start the app on your development store so it can be tested. In a second terminal, run:",
    "",
    `  cd ${appRoot}`,
    `  shopify app dev --store ${store}`,
    "",
    "Install the app when Shopify asks, and keep that terminal running until testing finishes.",
  ];
  if (hasThemeExtension) {
    const toml = await readFile(join(appRoot, "shopify.app.toml"), "utf8");
    const clientId = /client_id\s*=\s*"([^"]+)"/.exec(toml)?.[1];
    const blocks = await themeBlocks(appRoot);
    lines.push("", "Then add the app's block to the product page in the theme editor and save:");
    for (const block of blocks) {
      lines.push(
        clientId
          ? `  https://${store}/admin/themes/current/editor?template=product&addAppBlockId=${clientId}/${block}&target=mainSection`
          : `  ${block} (Online Store > Themes > Customize > Product page > Add block > Apps)`,
      );
    }
    if (blocks.length === 0) lines.push("  Online Store > Themes > Customize > Product page > Add block > Apps");
    lines.push("If your storefront has a password, put it in .env as SHOPIFY_STOREFRONT_PASSWORD.");
  }
  lines.push("", "Type `ready` when the app is running on your store.");
  return lines.join("\n");
}

function testerPrompt(store: string, functionalities: string[], architecture: string) {
  const list = functionalities.map((f, i) => `- [F${i + 1}] ${f}`).join("\n");
  return `The app is installed on https://${store} and \`shopify app dev\` is running. Write and run Playwright tests that prove each functionality works.

Functionalities:
${list}

Architecture:

${architecture}`;
}

function failureReport(results: FunctionalityResult[], checkFailures: string) {
  const lines = results
    .filter((r) => !r.passed)
    .map((r) => {
      if (r.tests.length === 0) return `- [F${r.index}] ${r.functionality}: no test covers it`;
      const failing = r.tests.filter((t) => !t.passed).map((t) => `  - "${t.title}": ${t.error ?? "failed"}`);
      return `- [F${r.index}] ${r.functionality}:\n${failing.join("\n")}`;
    });
  return [lines.join("\n"), checkFailures].filter(Boolean).join("\n\n");
}

const firstLine = (error = "failed") => error.split("\n").find((l) => l.trim())?.trim() ?? "failed";

// Copies each test's screenshots next to the report as F<n>-<i>.png and writes test-report.md.
async function writeReport(appDir: string, store: string, results: FunctionalityResult[]) {
  const shotsDir = join(appDir, "screenshots");
  await rm(shotsDir, { recursive: true, force: true });
  await mkdir(shotsDir, { recursive: true });
  const rows: string[] = [];
  const details: string[] = [];
  for (const r of results) {
    const shots: string[] = [];
    for (const test of r.tests) {
      for (const shot of test.screenshots) {
        if (!existsSync(shot)) continue;
        const name = `F${r.index}-${shots.length + 1}${extname(shot) || ".png"}`;
        await copyFile(shot, join(shotsDir, name));
        shots.push(name);
      }
    }
    rows.push(`| F${r.index} | ${r.functionality} | ${r.passed ? "Pass" : "Fail"} | ${r.tests.length} |`);
    details.push(
      `### F${r.index}. ${r.functionality}`,
      "",
      ...(r.tests.length === 0 ? ["No test covers this functionality."] : []),
      ...r.tests.map((t) => `- ${t.passed ? "Pass" : "Fail"}: ${t.title}${t.passed ? "" : ` (${firstLine(t.error)})`}`),
      ...shots.map((s) => `\n![${s}](screenshots/${s})`),
      "",
    );
  }
  const report = [
    "# Test report",
    "",
    `Tested on https://${store} with Playwright.`,
    "",
    "| # | Functionality | Result | Tests |",
    "|---|---|---|---|",
    ...rows,
    "",
    ...details,
  ].join("\n");
  await writeFile(join(appDir, "test-report.md"), report);
}

export interface TestDeps {
  claude: ClaudeRunner;
  runner?: CommandRunner;
}

// Step 8 of the process: with the app running on the dev store, Claude writes a Playwright test
// per functionality, the agent runs them, and failures go back to Claude to fix the app or test.
export const createTestPhase = ({ claude, runner = runCommand }: TestDeps): Phase => ({
  name: "test",
  maxAttempts: 1,
  async run({ appDir, state, log }) {
    const appRoot = await findAppRoot(appDir);
    if (!appRoot) return { kind: "failed", error: "No scaffolded app found; the scaffold step must run first" };
    const spec = AppSpecSchema.parse(JSON.parse(await readFile(join(appDir, "spec.json"), "utf8")));
    const store = storeDomain(state.answers.devStore ?? "");

    if (!state.answers.testPreview?.trim()) {
      const prompt = await previewPrompt(appRoot, store, spec.surfaces.includes("theme-extension"));
      return { kind: "needs-input", question: { id: "testPreview", prompt } };
    }

    const architecture = await readFile(join(appDir, "architecture.md"), "utf8");
    const reportFile = join(appDir, ".agent", "playwright-report.json");
    const tester = (prompt: string, resumeSessionId?: string) =>
      claude({
        role: "tester",
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        cwd: appRoot,
        tools: TESTER_TOOLS,
        allowedTools: TESTER_ALLOWED,
        disallowedTools: TESTER_DENIED,
        resumeSessionId,
      });

    let session = await tester(testerPrompt(store, spec.functionalities, architecture));
    await log("claude.test", { ok: session.ok, costUsd: session.costUsd });
    if (!session.ok) return { kind: "failed", error: `Claude could not write the tests: ${session.error}` };

    for (let round = 0; ; round++) {
      await rm(reportFile, { force: true });
      const run = await runner("npx", ["playwright", "test", "--reporter=json"], {
        cwd: appRoot,
        timeoutMs: 20 * 60_000,
        env: { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile },
      });
      let report: PwReport;
      try {
        report = JSON.parse(existsSync(reportFile) ? await readFile(reportFile, "utf8") : run.stdout);
      } catch {
        report = { errors: [{ message: (run.stdout + run.stderr).slice(-4_000) || "Playwright produced no report" }] };
      }
      const results = resultsByFunctionality(report, spec.functionalities);
      await writeReport(appDir, store, results);
      // Fixes may change the app, so the build checks must still pass.
      const checks = results.every((r) => r.passed) ? await runChecks(appRoot, undefined, runner) : undefined;
      await log("tests", {
        round,
        results: results.map(({ index, passed, tests }) => ({ index, passed, tests: tests.length })),
        checksPassed: checks?.passed,
      });
      if (checks?.passed) return { kind: "done", summary: `all ${results.length} functionalities pass; see test-report.md` };

      if (round >= FIX_ROUNDS) {
        const failing = results.filter((r) => !r.passed).map((r) => `F${r.index}`);
        const what = failing.length ? `functionalities ${failing.join(", ")}` : "build checks";
        return { kind: "failed", error: `${what} still failing after ${FIX_ROUNDS} fix rounds; see test-report.md` };
      }

      const runErrors = (report.errors ?? []).map((e) => e.message).filter(Boolean).join("\n");
      const checkFailures = (checks?.results ?? [])
        .filter((r) => !r.passed)
        .map((r) => `### ${r.name}\n\`\`\`\n${r.output}\n\`\`\``)
        .join("\n\n");
      session = await tester(
        `These results are not passing yet. Fix the app or the tests so every functionality passes, without skipping or weakening any test.\n\n${failureReport(results, checkFailures)}${runErrors ? `\n\nPlaywright errors:\n\`\`\`\n${runErrors.slice(-4_000)}\n\`\`\`` : ""}`,
        session.sessionId,
      );
      await log("claude.test-fix", { round: round + 1, ok: session.ok, costUsd: session.costUsd });
      if (!session.ok) return { kind: "failed", error: `Claude could not fix the failing tests: ${session.error}` };
    }
  },
});
