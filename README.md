# shopify-app-agent

An AI agent that designs and develops Shopify apps (embedded admin apps and theme app extensions), from the first question to a deployed app with App Store listing suggestions. The full design is in [`docs/design.md`](docs/design.md).

> **Status: M2.** The agent asks every question, has Claude write the architecture, creates the app with Shopify CLI, has Claude build it until typecheck, lint, tests and `shopify app build` pass, then tests every functionality on your development store with Playwright and writes a test report with screenshots. The Shopify checklist, deploying and listing suggestions are still placeholders until M3.

## Requirements

What you need depends on how far you want a run to go.

| Requirement | Needed for | How to check |
|---|---|---|
| **Node.js 22 or newer** | Running the agent | `node -v` |
| **npm 10 or newer** (ships with Node 22) | Installing dependencies | `npm -v` |
| **Git** | Cloning the repo | `git --version` |
| **A terminal** | Answering the agent's questions, and logging in to Shopify when the app is created | — |
| **Anthropic API key** | Claude writing the architecture and building the app | [console.anthropic.com](https://console.anthropic.com) → API keys |
| **Shopify CLI (latest)** | Creating and building the app | `shopify version` · install with `npm install -g @shopify/cli@latest` |
| **Shopify developer account** with app development permissions | Creating the app in the Dev Dashboard | [dev.shopify.com](https://dev.shopify.com) |
| **A Shopify development store** | Installing and testing the app | Create one with `shopify store create dev` |
| **Latest Chrome or Firefox** | Previewing the app on your store and adding its theme block | — |
| **A second terminal** | Keeping `shopify app dev` running while the agent tests the app | — |
| **Your hosting provider's CLI and account** (for example `flyctl` for Fly.io) | The deploy step (from M3) | Depends on the host you name when the agent asks |

These follow Shopify's [scaffold guide](https://shopify.dev/docs/apps/build/scaffold-app).

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
#    then open .env and set ANTHROPIC_API_KEY

# 4. Check everything works
npm run typecheck
npm test
```

`.env` is read automatically from the folder you run the agent in. It is git-ignored: keep keys and tokens there, and never type them into an answer.

## Run the agent

Start a new app from the repo root. `<app-id>` is a short folder name such as `stock-signal`:

```sh
npm run agent -- new stock-signal
```

The agent then asks you everything in the terminal. You can stop with `Ctrl+C` at any point and continue later with `npm run agent -- resume stock-signal`.

### What it asks, in order

1. The app's name and description
2. The app's functionalities, separated by semicolons
3. The app's basic flow
4. Whether the app has paid plans and, if it does, each plan's name, price, billing interval, trial and features
5. Review `architecture.md`: type `yes` to confirm, or describe the changes you want and it rewrites the file and asks again
6. Whether you have a Shopify developer account and which development store to use, then confirmation to start development
7. Creates the app with `shopify app init` (you log in and choose your organization in the terminal), adds the theme app extension, then Claude builds it and fixes anything that fails the checks
8. Checks it against Shopify's App Store requirements and Built for Shopify recommendations *(M3)*
9. Tests every functionality on your development store: it asks you to run `shopify app dev --store <your store>` in a second terminal and gives you a link that adds the app's block to the product page, then Claude writes a Playwright test per functionality and fixes the app or tests until all pass. Type `ready` when the app is running.
10. Where to host the app, then confirmation to deploy *(deploy itself in M3)*
11. Suggests App Store listing details *(M3)*

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
├── architecture.md      # the architecture Claude writes and you review at step 5
├── test-report.md       # each functionality, its tests and the result (step 9)
├── screenshots/         # Playwright screenshots, named F<n>-<i>.png after the functionality
├── <app-name>/          # the Shopify app itself, created by shopify app init
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
| `Claude could not write the architecture` / `could not build the app` | Check `ANTHROPIC_API_KEY` in `.env`. If the message mentions the budget, raise `AGENT_MAX_BUDGET_USD`. Then run `resume`. |
| `Shopify CLI is not installed` | Run `npm install -g @shopify/cli@latest`, then `resume`. |
| `Creating the app needs you to log in to Shopify` | The scaffold step was run without a terminal. Run `resume` in a normal terminal. |
| `checks still failing after 3 fix rounds` | Open the app folder, look at the failing check in `.agent/run-log.jsonl`, fix it or ask Claude, then `resume`. |
| `functionalities F2, ... still failing after 3 fix rounds` | Open `test-report.md` to see which tests fail and why. Check `shopify app dev` is still running and the app block is on the product page, then `resume`. |
| Storefront tests stop at a password page | Put the store's storefront password in `.env` as `SHOPIFY_STOREFRONT_PASSWORD`, then `resume`. |
| `No question is waiting for an answer` | The run is waiting for a confirmation, not an answer. Run `status` to see what it needs. |

## Repository layout

| Path | What |
|---|---|
| `agent/src/cli.ts` | Command-line entry point and interactive prompts |
| `agent/src/orchestrator.ts` | Runs the steps in order: questions, confirmations, retries, resume |
| `agent/src/phases/` | One module per step: questions, plans, architecture, scaffold, build and test are real; the rest are placeholders |
| `agent/src/claude.ts` | Runs Claude through the Claude Agent SDK with a budget and a tool allowlist |
| `agent/src/tools/` | Shopify CLI wrapper (allowlist, deploy needs confirmation), check runner, command runner, Playwright report reader |
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
