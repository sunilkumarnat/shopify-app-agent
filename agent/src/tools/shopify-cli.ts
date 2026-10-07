import type { GateName } from "../state/run-store.ts";
import { runCommand, type CommandResult, type CommandRunner } from "./exec.ts";

// Subcommands the agent may run freely, matched as a prefix of the arguments.
const ALLOWED: string[][] = [
  ["app", "init"],
  ["app", "generate", "extension"],
  ["app", "build"],
  ["app", "dev"],
  ["app", "info"],
  ["app", "config", "link"],
  ["app", "function"],
  ["theme", "check"],
];

// Subcommands that change what merchants can install; each needs a human approval.
const GATED: Array<{ prefix: string[]; gate: GateName }> = [
  { prefix: ["app", "deploy"], gate: "deploy" },
  { prefix: ["app", "release"], gate: "deploy" },
];

const startsWith = (args: string[], prefix: string[]) => prefix.every((token, i) => args[i] === token);

export function checkShopifyArgs(args: string[], approvals: readonly GateName[]): void {
  if (ALLOWED.some((prefix) => startsWith(args, prefix))) return;
  const gated = GATED.find(({ prefix }) => startsWith(args, prefix));
  if (!gated) throw new Error(`shopify ${args.join(" ")} is not on the allowlist`);
  if (!approvals.includes(gated.gate)) {
    throw new Error(`shopify ${args.join(" ")} needs the "${gated.gate}" approval`);
  }
}

export async function shopifyCli(
  args: string[],
  opts: { cwd: string; approvals: readonly GateName[]; runner?: CommandRunner },
): Promise<CommandResult> {
  checkShopifyArgs(args, opts.approvals);
  return (opts.runner ?? runCommand)("shopify", args, { cwd: opts.cwd });
}
