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
export function fakeRunner({ failingRounds = 0 }: { failingRounds?: number } = {}) {
  const commands: string[] = [];
  let typecheckRuns = 0;
  const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
  const runner: CommandRunner = async (cmd, args, { cwd }) => {
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
    return ok();
  };
  return { runner, commands };
}
