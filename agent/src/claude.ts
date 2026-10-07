import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { MODELS, type AgentRole } from "./models.ts";

export interface ClaudeRequest {
  role: AgentRole;
  prompt: string;
  systemPrompt: string;
  cwd: string;
  // Built-in tools the agent may use; an empty list means it can only answer.
  tools: string[];
  // Bash and other permission rules that run without asking, e.g. "Bash(npm run *)".
  allowedTools?: string[];
  disallowedTools?: string[];
  outputSchema?: Record<string, unknown>;
  // Continue an earlier session, e.g. to fix the checks it just broke.
  resumeSessionId?: string;
  maxTurns?: number;
}

export type ClaudeResult =
  | { ok: true; text: string; structured: unknown; sessionId: string; costUsd: number }
  | { ok: false; error: string; sessionId?: string; costUsd: number };

export type ClaudeRunner = (request: ClaudeRequest) => Promise<ClaudeResult>;

const DEFAULT_MAX_BUDGET_USD = 10;

function maxBudgetUsd(): number {
  const fromEnv = Number(process.env.AGENT_MAX_BUDGET_USD);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MAX_BUDGET_USD;
}

// The agent's Claude sessions must not attach to a Claude Code session the user happens to be
// running the CLI from, so drop that session's variables and keep everything else (PATH,
// ANTHROPIC_API_KEY, proxy settings).
export function isolatedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !/^(CLAUDE|CCR_)/.test(entry[0]),
    ),
  );
}

// Runs one Claude Agent SDK session and returns its final result. Permission mode "dontAsk"
// denies any tool call that isn't listed in allowedTools, so the agent never stops to ask.
export const runClaude: ClaudeRunner = async (request) => {
  const { model, effort } = MODELS[request.role];
  const options: Options = {
    model,
    effort,
    thinking: { type: "adaptive" },
    cwd: request.cwd,
    env: isolatedEnv(),
    tools: request.tools,
    allowedTools: request.allowedTools ?? request.tools,
    disallowedTools: request.disallowedTools,
    permissionMode: "dontAsk",
    systemPrompt: { type: "preset", preset: "claude_code", append: request.systemPrompt },
    settingSources: [],
    maxTurns: request.maxTurns,
    maxBudgetUsd: maxBudgetUsd(),
    resume: request.resumeSessionId,
    outputFormat: request.outputSchema ? { type: "json_schema", schema: request.outputSchema } : undefined,
  };

  try {
    for await (const message of query({ prompt: request.prompt, options })) {
      if (message.type !== "result") continue;
      if (message.subtype === "success" && !message.is_error) {
        return {
          ok: true,
          text: message.result,
          structured: message.structured_output,
          sessionId: message.session_id,
          costUsd: message.total_cost_usd,
        };
      }
      const detail = message.subtype === "success" ? message.result : [message.subtype, ...message.errors].join(": ");
      return { ok: false, error: detail, sessionId: message.session_id, costUsd: message.total_cost_usd };
    }
    return { ok: false, error: "Claude session ended without a result", costUsd: 0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), costUsd: 0 };
  }
};
