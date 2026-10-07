# shopify-app-agent

An AI agent that designs and develops Shopify apps (embedded admin apps and theme app extensions), from the first question to a deployed app with App Store listing suggestions. The full design is in [`docs/design.md`](docs/design.md).

> **Status: M0.** Every question and confirmation in the process works and is saved, and the agent writes `spec.json` and an outline `architecture.md` from your answers. Building, the Shopify checklist, testing, deploying and listing suggestions are still placeholders, and nothing calls Claude or Shopify yet. Those arrive in M1 to M3.

## Requirements

What you need depends on how far you want a run to go.

| Requirement | Needed for | How to check |
|---|---|---|
| **Node.js 22 or newer** | Running the agent (now) | `node -v` |
| **npm 10 or newer** (ships with Node 22) | Installing dependencies (now) | `npm -v` |
| **Git** | Cloning the repo (now) | `git --version` |
| **A terminal** | Answering the agent's questions interactively (now) | — |
| **Anthropic API key** | Claude writing the architecture and code (from M1) | [console.anthropic.com](https://console.anthropic.com) → API keys |
| **Shopify CLI** | Scaffolding, building and running apps (from M1) | `shopify version` · install with `npm install -g @shopify/cli` |
| **Shopify Partner account** | Creating and linking the app (from M1) | [partners.shopify.com](https://partners.shopify.com) |
| **A Shopify development store** | Installing and testing the app (from M2) | Create one in the Partner Dashboard → Stores |
| **Your hosting provider's CLI and account** (for example `flyctl` for Fly.io) | The deploy step (from M3) | Depends on the host you name when the agent asks |

macOS, Linux and Windows (WSL recommended) all work.

## Set up on your machine

```sh
# 1. Get the code
git clone https://github.com/sunilkumarnat/shopify-app-agent.git
cd shopify-app-agent

# 2. Install dependencies (installs the agent workspace too)
npm install

# 3. Create your local settings file
cp .env.example .env
#    then open .env and fill in what you have; everything is optional for M0

# 4. Check everything works
npm run typecheck
npm test
```

From M1, also sign in to Shopify once with `shopify auth login`, or put a `SHOPIFY_CLI_PARTNERS_TOKEN` in `.env` instead.

`.env` is read automatically from the folder you run the agent in. It is git-ignored: keep keys and tokens there, and never type them into an answer.

## Run the agent

Start a new app from the repo root. `<app-id>` is a short folder name such as `stock-signal`:

```sh
npm run agent -- new stock-signal
```

The agent then asks you everything in the terminal. You can stop with `Ctrl+C` at any point and continue later with `npm run agent -- resume stock-signal`.

### What it asks, in order

1. The app's name and description
2. The app's functionalities (one per line, or separated by semicolons)
3. The app's basic flow
4. Review `architecture.md`: type `yes` to confirm, or describe the changes you want and it rewrites the file and asks again
5. Whether you have a Shopify Partner account and which development store to use, then confirmation to start development
6. Scaffolds and builds the app *(M1)*
7. Checks it against Shopify's App Store requirements and Built for Shopify recommendations *(M3)*
8. Tests every functionality on your development store *(M2)*
9. Where to host the app, then confirmation to deploy *(deploy itself in M3)*
10. Suggests App Store listing details *(M3)*

### All commands

| Command | What it does |
|---|---|
| `npm run agent -- new <app-id>` | Starts a new app and asks the questions |
| `npm run agent -- resume <app-id>` | Continues where the run stopped |
| `npm run agent -- status <app-id>` | Shows the current step and what it is waiting for |
| `npm run agent -- answer <app-id> "<text>"` | Answers the pending question without the interactive prompt |
| `npm run agent -- approve <app-id> <architecture\|start-development\|deploy>` | Gives a confirmation without the interactive prompt |
| `npm run agent -- changes <app-id> "<feedback>"` | Asks for changes while the architecture is under review |

The last three are for scripts and other non-interactive use. In a normal terminal you only need `new` and `resume`.

### Where things are saved

```
workspace/<app-id>/
├── spec.json            # your answers as a structured spec
├── architecture.md      # the architecture you review at step 4
└── .agent/
    ├── state.json       # current step, answers and confirmations (lets a run resume)
    └── run-log.jsonl    # everything the agent did, one event per line
```

`workspace/` is git-ignored. Set `AGENT_WORKSPACE` in `.env` to keep apps somewhere else.

## Troubleshooting

| Problem | Fix |
|---|---|
| `process.loadEnvFile is not a function` or syntax errors on start | Your Node is older than 22. Upgrade it and run `npm install` again. |
| The agent prints a status line and exits instead of asking | It isn't attached to a terminal (for example, piped or run from a script). Use `answer`, `approve` and `changes`, or run it in a normal terminal. |
| `No app run found in ...` | No run exists with that `<app-id>` (or `AGENT_WORKSPACE` points elsewhere). Check the name, or start one with `new`. |
| `No question is waiting for an answer` | The run is waiting for a confirmation, not an answer. Run `status` to see what it needs. |

## Repository layout

| Path | What |
|---|---|
| `agent/src/cli.ts` | Command-line entry point and interactive prompts |
| `agent/src/orchestrator.ts` | Runs the steps in order: questions, confirmations, retries, resume |
| `agent/src/phases/` | One module per step: questions and architecture are real, the rest are placeholders |
| `agent/src/tools/` | Shopify CLI wrapper (allowlist, deploy needs confirmation), check runner, command runner |
| `agent/src/state/` | App spec schema and saved run state |
| `agent/src/models.ts` | Which Claude model each agent role uses |
| `evals/apps/` | Sample apps for testing the agent end to end, starting with Stock Signal |
| `knowledge/` | Curated Shopify patterns for agent context |
| `docs/design.md` | Design doc |

## Development

```sh
npm run typecheck   # TypeScript
npm test            # unit tests (vitest)
```

CI runs both on every pull request.
