# shopify-app-agent

An AI agent that designs and develops Shopify apps (embedded admin apps and theme app extensions) from idea to deployed app. The design is in [`docs/design.md`](docs/design.md).

## How a run goes

The agent follows the same process for every app (`docs/design.md`, section 5):

1. Asks for the app's name and description
2. Asks for the app's functionalities
3. Asks for the app's basic flow
4. Writes `architecture.md` from your answers and asks you to confirm it or describe changes
5. Asks about your Shopify Partner account and development store, then asks for confirmation to start development
6. Scaffolds and builds the app
7. Checks it against Shopify's App Store requirements and Built for Shopify recommendations
8. Tests every functionality on your dev store
9. Asks where to host the app and for confirmation, then deploys
10. Suggests App Store listing details

Status (M0): every question and confirmation works; the architecture is a fixed outline of your answers, and steps 6 to 10 are stubs. Nothing calls Claude or Shopify yet.

## Usage

```sh
npm install
cp .env.example .env   # fill in later; nothing calls Claude or Shopify yet

npm run agent -w agent -- new stock-signal      # asks each question in the terminal
```

Without a terminal (for example, from a script), answer and confirm step by step:

```sh
npm run agent -w agent -- answer stock-signal "Stock Signal"
npm run agent -w agent -- changes stock-signal "Add a CSV export"   # while the architecture is under review
npm run agent -w agent -- approve stock-signal architecture         # or start-development, deploy
npm run agent -w agent -- status stock-signal
```

Generated apps live in `workspace/<app-id>/` (ignored by git), with `spec.json` and `architecture.md`. Run state and logs are in `workspace/<app-id>/.agent/`.

## Layout

| Path | What |
|---|---|
| `agent/src/orchestrator.ts` | Phase state machine: questions, confirmations, retries, resume |
| `agent/src/phases/` | One module per step: questions and architecture are real, the rest are stubs |
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
