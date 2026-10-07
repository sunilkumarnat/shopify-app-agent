# Shopify App Agent: Design Doc

_Status: v1, decisions confirmed by Sunil · 2026-10-07 · Owner: Sunil_

## 1. Goal

An AI agent that takes a merchant-facing app idea and carries it to a deployed Shopify app: spec, UI design, code, tests, dev-store preview, and release. It must handle both surfaces Shopify offers:

- **Embedded admin apps** (App Home pages inside Shopify admin, backed by Admin GraphQL, webhooks, billing).
- **Theme app extensions** (app blocks and app embeds that render on the storefront through Liquid).

Non-goals for v1: Hydrogen storefronts, POS extensions, App Store submission (the agent prepares the listing; a human submits).

## 2. Design principles

1. **Use Shopify's own tooling, don't reinvent it.** Shopify CLI scaffolds, runs, builds and deploys. The agent drives the CLI instead of hand-writing config.
2. **Ground every API call in the live schema.** Generated GraphQL is validated against the pinned Admin API version before it is written to disk, so hallucinated fields fail fast.
3. **Small verified increments.** Each phase ends with a machine check (typecheck, tests, `shopify app build`, Theme Check, screenshot). The agent never moves on with a red check.
4. **Humans gate the irreversible steps.** Creating the Partner app, `shopify app deploy`, billing changes and anything touching a live store need explicit approval.
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
 Product/UX    Builder        Reviewer   Tool layer                    Human gates
 subagent      subagents      subagent   - Shopify CLI wrapper         (approve spec,
 (spec, Polaris (backend,     (security, - Shopify Dev MCP (docs        deploy, billing)
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
| Orchestrator | Runs the phase state machine, keeps `spec.md` and `run-log.jsonl`, decides retries, asks for human approval | `claude-opus-5-5` |
| Product/UX agent | Turns an idea into a spec: user stories, screens, data model, scopes, extension points | `claude-opus-5-5` |
| Builder agents | Write code for one slice each: backend routes and data, admin UI, theme extension, webhooks | `claude-sonnet-5-5` |
| Reviewer agent | Reviews diffs for scope creep, tenant isolation, webhook HMAC, GDPR handlers, Polaris misuse, a11y | `claude-opus-5-5` |
| Fixer loop | Reads failing check output and patches; capped at N attempts per check before escalating | `claude-sonnet-5-5` |
| Cheap classifiers | Log triage, "is this error ours or the environment's" | `claude-haiku-4-5-20251001` |

All agents share a cached system prompt (Shopify conventions, repo layout, coding rules) using prompt caching, so the long context is paid for once per run.

### Tool layer

Each tool is a typed function the agents call, not free-form shell, so outputs are parseable and dangerous flags are blocked.

- `shopify_cli(args)`: allowlisted subcommands (`app init`, `app generate extension`, `app build`, `app dev`, `app info`, `app function`, `theme check`). `app deploy` and `app release` exist but require a human-approval token.
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
- **Hosting:** Fly.io (app plus Fly Postgres), deployed with `fly deploy` behind the release gate.

## 5. Workflow: idea to deployed app

| # | Phase | Agent does | Exit check | Human gate |
|---|---|---|---|---|
| 1 | Intake | Asks at most 3 clarifying questions, writes `spec.md` (stories, screens, data, scopes, extensions, out of scope) | Spec lint: every story maps to a screen or extension; scopes are minimal | **Approve spec** |
| 2 | Design | Screen-by-screen Polaris layouts incl. empty, loading and error states; storefront block mockups; GraphQL operations list | Each operation validated against the schema | Optional review |
| 3 | Scaffold | `shopify app init` from the template, `shopify app generate extension` for the theme extension, links to the Partner app | `shopify app build` passes | **Approve linking to Partner app** |
| 4 | Build | Builders implement slices in parallel on separate files; each slice comes with tests | `run_checks()` green | — |
| 5 | Review | Reviewer audits the diff; fixer applies findings | No high-severity findings | — |
| 6 | Preview | `shopify app dev` on a dev store, installs, runs Playwright flows, adds the app block to a theme | Screenshots of every screen and the storefront block | **Approve preview** |
| 7 | Release | Builds production config, sets env, deploys host, `shopify app deploy` to create a version | Health check on host, version visible in `shopify app info` | **Approve deploy** |
| 8 | Handoff | Writes README, listing draft, known limits, next steps | — | — |

Failure handling: each check gets up to 3 fix attempts. After that the orchestrator stops, writes what failed and what it tried into the run log, and asks the human.

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

Success criteria for v1 of the agent: from the one-paragraph idea above, it produces a running Stock Signal on a dev store with all checks green and no more than the four human approvals in section 5.

Follow-up eval apps once that works: a post-purchase upsell (Checkout UI extension), a volume discount (Shopify Function), a size-chart block (theme extension only).

## 7. Starter repo layout

```
shopify-app-agent/
├── agent/
│   ├── src/
│   │   ├── orchestrator.ts        # phase state machine, approvals, resume
│   │   ├── phases/                # intake.ts, design.ts, scaffold.ts, build.ts, review.ts, preview.ts, release.ts
│   │   ├── agents/                # subagent definitions and prompts
│   │   ├── tools/                 # shopify-cli.ts, graphql-validate.ts, docs-search.ts, checks.ts, preview.ts, git.ts
│   │   ├── state/                 # spec schema (zod), run log
│   │   └── cli.ts                 # `agent new "<idea>"`, `agent resume <app>`, `agent approve <gate>`
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
- Dev store only until the release gate; the agent has no credentials for a live store.

## 9. Milestones

1. **M0, skeleton:** repo, orchestrator with phases stubbed, tool wrappers for CLI and checks.
2. **M1, scaffold and build:** agent scaffolds Stock Signal and gets `run_checks()` green with no preview.
3. **M2, preview:** dev-store install, Playwright screenshots, theme block visible.
4. **M3, release:** hosted deploy and `shopify app deploy` behind approval.
5. **M4, evals:** three more eval apps, scored automatically on every agent change.

## 10. Decisions (confirmed by Sunil, 2026-10-07)

1. **Shopify access:** Sunil has a Partner account and a dev store the agent can use. Credentials are supplied via env, never committed.
2. **Hosting:** Fly.io is the default target for generated apps.
3. **Agent form factor:** a local CLI first; a hosted service with a web UI may come later.
