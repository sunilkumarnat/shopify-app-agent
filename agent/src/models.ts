// Claude model and effort for each agent role (see docs/design.md, section 3).
export const MODELS = {
  architect: { model: "claude-opus-5-5", effort: "high" },
  builder: { model: "claude-opus-5-5", effort: "high" },
  tester: { model: "claude-opus-5-5", effort: "high" },
  reviewer: { model: "claude-opus-5-5", effort: "high" },
  deployer: { model: "claude-opus-5-5", effort: "high" },
  copywriter: { model: "claude-opus-5-5", effort: "high" },
} as const;

export type AgentRole = keyof typeof MODELS;
