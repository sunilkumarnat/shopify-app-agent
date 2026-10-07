# Shopify App Agent: Design Doc

_Status: v1 · 2026-10-07 · Owner: Sunil_

## 1. Goal

An AI agent that takes a merchant-facing app idea and carries it to a deployed Shopify app by following a fixed process (section 5): questions, architecture review, code, Shopify checklist, tests, deploy, and listing suggestions. It must handle both surfaces Shopify offers:

- **Embedded admin apps** (App Home pages inside Shopify admin, backed by Admin GraphQL, webhooks, billing).
- **Theme app extensions** (app blocks and app embeds that render on the storefront through Liquid).

Non-goals for v1: Hydrogen storefronts, POS extensions, App Store submission (the agent prepares the listing; a human submits).

## 2. Design principles

1. **Use Shopify's own tooling, don't reinvent it.** Shopify CLI scaffolds, runs, builds and deploys. The agent drives the CLI instead of hand-writing config.
2. **Ground every API call in the live schema.** Generated GraphQL is validated against the pinned Admin API version before it is written to disk, so hallucinated fields fail fast.
3. **Small verified increments.** Each phase ends with a machine check (typecheck, tests, `shopify app build`, Theme Check, screenshot). The agent never moves on with a red check.
4. **The user confirms the decisions that matter.** The architecture, the start of development and the deploy each need the user's explicit confirmation; billing changes and anything touching a live store do too.
5. **One spec is the source of truth.** Every phase reads and updates `spec.md` for the app, so a run can stop and resume.

## 3. Architecture

```
            ┌──────────────────────────────────────────────┐
  idea ───► │ Orchestrator (Claude Agent SDK, TypeScript)  │
            │  state machine over phases, owns spec.md     │
            └──────┬───────────────────────────────┬───────┘
                   │ delegates                     │ calls
     ┌─────────────┼──────────────┐         ┌──────┴──────────────────────┐
     ▼             ▼              ▼         ▼                             ▼
 Product/UX    Builder        Reviewer   Tool layer                    User input
 subagent      subagents      subagent   - Shopify CLI wrapper         (questions,
 (spec, Polaris (backend,     (security, - Shopify Dev MCP (docs        confirmations)
  screens)      admin UI,      scopes,     search, GraphQL/theme
                theme ext)     UX, a11y)   validation)
                                         - Theme Check
                                         - test runner, tsc, eslint
                                         - Playwright (screenshots)
                                         - git
                   │
                   ▼
          workspace/<app>/  (a real Shopify CLI app repo, one per generated app)
```

### Components

| Component | Responsibility | Model |
|---|---|---|
| Orchestrator | Runs the phase state machine, keeps `spec.md` and `run-log.jsonl`, decides retries, asks the user's questions and confirmations | `claude-opus-5-5` |
| Product/UX agent | Asks the process questions, then turns the answers into the architecture: screens, data model, scopes, extension points | `claude-opus-5-5` |
| Builder agent | Implements the architecture in the scaffolded project, writes tests, then fixes failing checks in the same session (up to 3 rounds) | `claude-opus-5-5` |
| Tester agent | Writes a Playwright test per functionality against the dev store, then fixes the app or test until each passes (up to 3 rounds) | `claude-opus-5-5` |
| Reviewer agent | Evaluates the app against Shopify's App Store self-review requirements and fixes what fails | `claude-opus-5-5` |
| Deployer agent | Prepares hosting files and a deploy plan for the user's host; never deploys itself | `claude-opus-5-5` |
| Copywriter agent | Drafts the App Store listing from the built app; read-only | `claude-opus-5-5` |

All agents share a cached system prompt (Shopify conventions, repo layout, coding rules) using prompt caching, so the long context is paid for once per run.

### Tool layer

Each tool is a typed function the agents call, not free-form shell, so outputs are parseable and dangerous flags are blocked.

- `shopify_cli(args)`: allowlisted subcommands (`app init`, `app generate extension`, `app build`, `app dev`, `app info`, `app function`, `theme check`). `app deploy` and `app release` exist but refuse to run without the user's deploy confirmation.
- `graphql_validate(query, apiVersion)`: validates against the Admin schema via the Shopify Dev MCP server; returns field-level errors.
- `shopify_docs_search(q)`: Shopify Dev MCP docs search, used before writing any unfamiliar API.
- `run_checks()`: `tsc --noEmit`, eslint, vitest, `shopify app build`, Theme Check. Returns a structured pass/fail list.
- `preview(url, steps)`: Playwright against the running `shopify app dev` tunnel; returns screenshots for the reviewer and for the human.
- `git_commit(msg)`: one commit per completed phase step, so every run is reviewable and revertible.

## 4. Tech stack of generated apps

Fixed defaults so the agent works from one well-trodden path:

- **Template:** Shopify CLI's React Router app template (TypeScript), embedded, with App Bridge.
- **Admin UI:** Polaris web components for App Home.
- **API:** Admin GraphQL only (no REST), pinned to one stable quarterly version per app, bumped deliberately.
- **Data:** Prisma with SQLite locally and Postgres in production; app-owned metafields and metaobjects where merchant data belongs on the shop.
- **Storefront:** theme app extension (app blocks and app embeds, Liquid plus small vanilla JS/CSS assets).
- **Webhooks:** declared in `shopify.app.toml` (app-specific subscriptions), including mandatory compliance topics.
- **Hosting:** whatever the user names when the agent asks (step 9), deployed after the user confirms the deploy.

## 5. Workflow: the development process

This is the process Sunil set on 2026-10-07. The agent always follows these steps in this order. Every question and confirmation is asked in the terminal, and a run can stop at any step and resume later.

| # | Step | Agent does | User does | Exit check |
|---|---|---|---|---|
| 1 | App details | Asks for the app's name and description | Answers | Both answered |
| 2 | Functionalities | Asks for the list of functionalities | Answers, separated by semicolons | At least one functionality |
| 3 | Basic flow | Asks for the app's basic flow (merchant from install to daily use, what shoppers see) | Answers | Answered |
| 4 | Plans | Asks whether the app has paid plans; if it does, asks for each plan's name, price, billing interval, trial days and features | Answers | Answered (plan details only for a paid app) |
| 5 | Architecture | Claude analyzes the answers and writes `architecture.md`: functionalities mapped to where they are built, plans and billing, screens, data model, Admin GraphQL operations, webhooks, scopes, open questions | **Reviews and confirms it, or describes changes** (the agent regenerates and asks again) | Spec validates; every functionality maps to a screen or extension |
| 6 | Start development | Asks whether the user has a Shopify developer account and which development store to use, then asks for confirmation to start. Credentials go in `.env`, never in an answer. | **Answers and confirms** | Dev store named, confirmation given |
| 7 | Scaffold and build | Follows Shopify's [scaffold guide](https://shopify.dev/docs/apps/build/scaffold-app): `shopify app init --template reactRouter --flavor typescript --name <app name>` in the terminal (the user logs in and picks the organization), then `shopify app generate extension` for the theme app extension. The builder agent then implements the architecture and fixes failing checks. | Logs in to Shopify | `run_checks()` green |
| 8 | Shopify checklist | Fetches Shopify's App Store self-review requirements fresh with `shopify doc fetch` (never from memory). The reviewer agent evaluates each one as passing, failing or needs-review, fixes failing ones (up to 3 rounds), and `run_checks()` must stay green; writes `checklist.md` | Reads the needs-review items | No failing requirement, `run_checks()` green |
| 9 | Test functionalities | Asks the user to run `shopify app dev --store <dev store>` in a second terminal (installs the app) and gives a theme editor link that adds the app block to the product page. The tester agent writes Playwright tests tagged `[F<n>]` per functionality (storefront in the browser, admin through the app's loaders and actions); the agent runs them, sends failures back to the tester to fix the app or the test (up to 3 rounds), reruns `run_checks()`, and writes `test-report.md` with screenshots | **Starts `shopify app dev`, adds the block, types `ready`** | Every functionality has a passing test and `run_checks()` is green |
| 10 | Deploy | Asks where to host the app. The deployer agent writes the host's files and `deploy-plan.md` (app URL, secrets by name only, host CLI commands; anything other than the host's CLI is rejected). After confirmation, asks the user to set the secrets themselves, runs the plan's commands in the terminal, then `shopify app deploy`, then a health check | **Reviews the plan, confirms, sets secrets** | Health check passes, app version created |
| 11 | Listing suggestions | The copywriter agent (read-only) drafts `listing.md` from what was built and tested: name, subtitle, introduction, details, features, pricing, categories, search terms, screenshots to take, reviewer instructions, what the user still has to provide. Field limits are validated | Reviews | Draft within the field limits |

Failure handling: each check gets up to 3 fix attempts. After that the orchestrator stops, writes what failed and what it tried into the run log, and asks the user.

## 6. Sample test app: **Stock Signal**

Chosen because it is small but touches every surface the agent must master.

> Merchants pick products and set a low-stock threshold. When inventory falls below it, the product page shows an "Only N left" badge, styled to match the theme.

| Surface | What it exercises |
|---|---|
| Embedded admin | Polaris index table of products, resource picker, settings form, save bar, empty and error states |
| Admin GraphQL | Product and inventory queries with pagination, `metafieldsSet` mutation, throttling and cost handling |
| Data | App-owned product metafield for the threshold; shop-level settings metaobject |
| Theme extension | App block for product pages reading the metafield in Liquid; theme editor settings for colour and copy |
| Webhooks | `inventory_levels/update` to keep a cache warm; compliance webhooks |
| Scopes | `read_products`, `read_inventory`, `write_products` (metafields) only |

Success criteria for v1 of the agent: from the one-paragraph idea above, it produces a running Stock Signal on a dev store with all checks green and only the questions, the Shopify login and the three confirmations in section 5.

Follow-up eval apps once that works: a post-purchase upsell (Checkout UI extension), a volume discount (Shopify Function), a size-chart block (theme extension only).

## 7. Starter repo layout

```
shopify-app-agent/
├── agent/
│   ├── src/
│   │   ├── orchestrator.ts        # phase state machine, questions, confirmations, resume
│   │   ├── phases/                # questions.ts, architecture.ts, then scaffold, build, checklist, test, deploy, listing
│   │   ├── agents/                # subagent definitions and prompts
│   │   ├── tools/                 # shopify-cli.ts, graphql-validate.ts, docs-search.ts, checks.ts, preview.ts, git.ts
│   │   ├── state/                 # spec schema (zod), run log
│   │   └── cli.ts                 # `new <app>` (interactive), `resume`, `answer`, `approve`, `changes`, `status`
│   ├── prompts/                   # shared system prompt, Shopify conventions
│   └── package.json
├── knowledge/                     # curated Shopify patterns: auth, webhooks, billing, Polaris, theme blocks
├── evals/
│   ├── apps/stock-signal/         # idea.md, expected-spec.md, acceptance checks
│   └── run-evals.ts               # runs the agent end to end on each eval app, scores checks
├── workspace/                     # generated apps (gitignored; each is its own git repo)
├── docs/                          # this design doc, ADRs
├── .env.example                   # ANTHROPIC_API_KEY, SHOPIFY_CLI_PARTNERS_TOKEN, DEV_STORE
└── README.md
```

The agent is TypeScript to match the Shopify ecosystem (CLI, templates, App Bridge), so one toolchain covers the agent and what it generates.

## 8. Security and safety

- Secrets come from env only; the agent never writes tokens into generated code or logs.
- Scopes are proposed in the spec and any later scope increase needs re-approval.
- The reviewer has a fixed checklist: session-token auth on every admin route, webhook HMAC verification, shop-scoped DB queries, compliance webhooks, no PII in logs.
- Dev store only until the user confirms the deploy; the agent has no credentials for a live store.

## 9. Milestones

1. **M0, skeleton:** repo, orchestrator with phases stubbed, tool wrappers for CLI and checks.
2. **M1, plans, architecture and build:** plans step; Claude writes the architecture from the answers; scaffold per Shopify's guide; Claude builds the app and fixes it until `run_checks()` is green.
3. **M2, test functionalities (done):** dev-store install via `shopify app dev`, a Playwright test per functionality, fix loop, `test-report.md` with screenshots, theme block visible.
4. **M3, checklist, deploy and listing (done):** App Store self-review checklist with fixes, deploy plan reviewed before the deploy confirmation, host deploy and `shopify app deploy`, health check, listing draft.
5. **M4, evals:** three more eval apps, scored automatically on every agent change.
