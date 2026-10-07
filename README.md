# shopify-app-agent

An AI agent that designs and develops Shopify apps (embedded admin apps and theme app extensions) from idea to deployed app. The design is in [`docs/design.md`](docs/design.md).

## Status

M0 skeleton: the orchestrator runs every phase in order, stops at human approval gates, retries failing phases, and saves state so a run can resume. Every phase after intake is a stub until M1.

## Usage

```sh
npm install
cp .env.example .env   # fill in later; nothing calls Claude or Shopify yet

npm run agent -w agent -- new stock-signal "Show an 'Only N left' badge on low-stock products"
npm run agent -w agent -- approve stock-signal spec
npm run agent -w agent -- status stock-signal
```

Generated apps live in `workspace/<app-name>/` (ignored by git). Run state and logs are in `workspace/<app-name>/.agent/`.

Approval gates: `spec` before design, `partner-link` before scaffold, `preview` and `deploy` before release.

## Layout

| Path | What |
|---|---|
| `agent/src/orchestrator.ts` | Phase state machine, gates, retries |
| `agent/src/phases/` | One module per phase (intake is real; the rest are stubs) |
| `agent/src/tools/` | Shopify CLI wrapper with allowlist and deploy gate, check runner, command exec |
| `agent/src/state/` | App spec schema and run state store |
| `agent/src/models.ts` | Claude model for each agent role |
| `evals/apps/` | Sample apps used to test the agent end to end, starting with Stock Signal |
| `knowledge/` | Curated Shopify patterns for agent context |

## Development

```sh
npm run typecheck
npm test
```
