# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OpenDots is a self-hosted, single-owner personal-agent template (alpha). A React/Vite client talks to a Hono Node server. "Dots" are specialist agents; "Spaces" hold pages (documents). Conversations run through CopilotKit (AG-UI protocol + Intelligence Threads), with TanStack AI driving an OpenAI-compatible model. Optional integrations: Slack (Channels SDK), realtime voice, Parallel web research, an isolated Playwright browser service, and per-Dot computers via OpenBot's supervisor.

## Commands

Requires Node.js 24 (uses the built-in `node:sqlite`) and npm.

```sh
npm ci && cp .env.example .env
npm run dev            # API server (tsx --watch, port 4310) + Vite (127.0.0.1:5173, proxies /api)
npm run build          # vite build -> dist/client, tsc -p tsconfig.server.json -> dist/server
npm start              # run built server (serves dist/client too)
npm run browser        # optional read-only browser service (port 4311)

npm test                               # vitest run (all tests in tests/)
npx vitest run tests/pages.test.ts     # single file
npx vitest run -t "requires owner token"  # single test by name
npm run lint
npm run typecheck
npm run check-format   # prettier check; `npm run format` to fix
```

CI (`.github/workflows/ci.yml`) runs, in order: `check-format`, `lint`, `typecheck`, `test`, `build`. Run all of them before considering a change done. Prettier config: single quotes, trailing commas.

Server code uses NodeNext ESM: relative imports in `src/server`, `src/browser`, `src/shared` must use `.js` extensions (e.g. `import { Store } from './store.js'`).

## Architecture

### Layout

- `src/server/` — Hono API + CopilotKit runtime. Entry: `index.ts` (reads all env vars into a `PlatformConfig`, wires everything, sets security headers/CSP, serves static client).
- `src/client/` — React 19 app. `App.tsx` wraps everything in `CopilotKitProvider runtimeUrl="/api/copilotkit"`; `Chat.tsx` uses `useAgent`, `useHumanInTheLoop`, `useRenderTool`. Page editor is TipTap under `client/editor/`.
- `src/shared/` — types and tool definitions shared by client and server (e.g. `page-review.ts` HITL tool, `voice-receipt.ts`).
- `src/browser/` — separate, isolated Playwright service for reading public URLs (`WEB_SEARCH_PROVIDER=browser` path only).
- `deployment/computers/` + `compose.computers*.yml` — OpenBot supervisor for per-Dot containers (see `docs/COMPUTERS.md`).

### Server wiring (`index.ts` → `Platform`)

- **Two SQLite stores on the same file** (`DATABASE_PATH`):
  - `Store` (`store.ts`): settings (global `paused`, `researchAllowed`, `memoryAllowed`), scheduled tasks/runs/events, memories.
  - `WorkspaceStore` (`workspace.ts`): Spaces, Dots, `dot_spaces`, thread bindings, task→thread mapping, calls, captures. Also owns `pages.ts` (pages, page_threads, page_reviews) and `computer-store.ts` (computer permissions + audit).
  - `AuthStore` (`auth-store.ts`): `users` + `sessions`; `ProviderCredentialStore` (`providers/credential-store.ts`): OAuth tokens for provider sign-ins, never sent to the client.
  - Conversation _history_ is not in SQLite — it lives in CopilotKit Intelligence. SQLite only binds thread IDs to Dots.
- **`Platform`** (`platform.ts`) builds `CopilotKitIntelligence` + `CopilotRuntime` with one `DotAgent` per Dot (agent ID = Dot ID), plus the optional Slack channel. If `INTELLIGENCE_API_KEY` is absent, the runtime runs in SSE mode with `SqliteAgentRunner` (`sqlite-runner.ts`), which stores each thread's compacted AG-UI events and messages in SQLite; Slack, Learning, and thread names then need Intelligence. `platform.threads()` and `platform.turn()` pick the Intelligence or local path (`headless.ts` `runThreadTurn` vs `runLocalThreadTurn`). The UI only shows a setup state while the model provider is unready (`platform-config.ts` `setupStatus`). Never fake replies when unconfigured.
- **`/api/copilotkit/*`** requests pass through `validateRuntimeScope` (`runtime-scope.ts`), an explicit allowlist of runtime routes/methods that also verifies the thread belongs to the Dot. New runtime routes must be added there or they are 403'd.
- **`DotAgent`** (`dot-agent.ts`) is a custom AG-UI `AbstractAgent` wrapping `BuiltInAgent` + TanStack AI `chat`. Per run it: requires a bound thread, assembles tools based on permissions (page tools, Parallel research or `read_public_page`, computer tools, learned skills), and polls every 100 ms — aborting the run if global pause or any relevant Dot/global permission changes mid-run. 90 s run timeout. The same agent class serves web chat, Slack, scheduled work, and voice compute.
- **Background work**: `Runner` (`runner.ts`) ticks every second, leases due tasks from `Store`, and executes them via `platform.turn()` → `headless.ts` `runThreadTurn`, which calls the app's own `/api/copilotkit` runtime over HTTP as a client to run a turn in the task's original Intelligence thread.
- **HTTP API** (`app.ts`): on `/api/*`, in order: body limit, host allowlist (skipped only with a valid Bearer), origin/`sec-fetch-site`, 415 for non-JSON mutations, then the auth gate. `/api/auth/*` (`auth.ts`) is open; everything else needs a session cookie or a Bearer token (`OWNER_TOKEN`, or the random per-process `serviceToken` the server uses for its own `platform.turn` self-calls). A session whose user `mustChangePassword` gets 403 `password_change_required`. `createApp` requires `auth: AuthService | false` — tests pass `false` (Bearer-only, old behaviour). Route modules: `workspace-routes.ts`, `page-routes.ts`, `computer-routes.ts`, `provider-routes.ts`; voice in `voice.ts`.
- **Sign-in**: single `admin` user seeded as `admin`/`admin` (`ADMIN_INITIAL_PASSWORD` overrides), forced password change on first login, reset via `npm run admin:reset-password` or `ADMIN_PASSWORD_RESET`. Client: `api.ts` uses same-origin cookies (no tokens in JS); `App.tsx` `authState` gates polling; `Login.tsx` holds the screens.
- **Model providers** (`providers/`): `ProviderRegistry.resolve(settings, dot)` picks Dot override → `Settings.modelProvider`/`model` → first ready provider, and returns a TanStack adapter + `modelOptions` via `ModelProvider.createText`. `openai-compatible` is the env-configured chat-completions provider; `openai-codex` is the ChatGPT subscription via the Codex device-code OAuth (`codex-auth.ts`, single-flight refresh because refresh tokens rotate) and the undocumented `chatgpt.com/backend-api/codex` Responses endpoint, whose body rules live in `normalizeCodexBody` (`openai-codex.ts`); its SSE has no content-type and an empty `response.completed.output`, which `completedOutput()` refills so TanStack runs tools. Readiness feeds `setupStatus` so the UI gate reflects it. Type adapter config via `Parameters<typeof openaiCompatibleText>[1]`, not the root `openai` package (version mismatch).
- **Pages**: `page-service.ts`/`pages.ts` use revision numbers for optimistic concurrency — writes with a stale revision are rejected; the client autosave (`client/editor/autosave.ts`) keeps the local draft on conflict/failure and stops retrying.
- **Research**: `parallel.ts` (default, Parallel Search MCP) vs. `research.ts` (browser/sample modes). `Config.mode: 'sample'` is the fixture mode used by tests; it makes no provider calls.

### Tests

Vitest, no config file; tests live in `tests/` and import from `../src/...`. Server tests construct `new Store(':memory:')` / `WorkspaceStore(':memory:', ...)` and call `createApp(...)` then `app.request(...)` directly. Model streams are faked via `tests/fixtures/model-stream.ts` (chat completions) and `tests/fixtures/responses-stream.ts` (Responses/Codex). Tests must use fixtures, never live services.

## Project conventions (from CONTRIBUTING.md / README)

- Add regression tests for changes to durable jobs, permissions, cancellation, or API behavior.
- Keep fixtures/sample mode visibly separate from live integrations; don't add UI controls that appear to connect a service with no adapter behind it. Missing config should surface as a clear setup state.
- Credentials stay server-side (`.env`), never in client code. Computer tools must never fall back to the host shell/filesystem.
- Update `docs/SETUP.md` / `.env.example` when configuration changes. `OWNER_ID` and `COMPUTER_NAMESPACE` must stay stable (they key persistent conversations and volumes).
