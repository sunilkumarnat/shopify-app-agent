// Which Claude model each agent role uses (see docs/design.md, section 3).
export const MODELS = {
  orchestrator: "claude-opus-5-5",
  productUx: "claude-opus-5-5",
  builder: "claude-sonnet-5-5",
  reviewer: "claude-opus-5-5",
  fixer: "claude-sonnet-5-5",
  classifier: "claude-haiku-4-5",
} as const;

export type AgentRole = keyof typeof MODELS;
