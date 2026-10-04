# Running the template

OpenDots runs a React app and a Node server. The server stores pages, Space and Dot configuration, and thread bindings in SQLite and connects to your configured conversation, model, and messaging services.

## Local development

Use Node.js 24 and npm.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:5173 and sign in as `admin` / `admin`. You must choose a new password before continuing. The API runs on port 4310. Without service credentials, the app shows its setup state; it does not generate simulated replies.

For a built local app:

```sh
npm run build
npm start
```

Open http://127.0.0.1:4310. Keep the server running for background work.

## Conversation services

Edit `.env` on the server and restart after changes:

| Variable                                      | Purpose                                                       |
| --------------------------------------------- | ------------------------------------------------------------- |
| `INTELLIGENCE_API_KEY`                        | Optional: hosted conversations, Slack, and Learning           |
| `INTELLIGENCE_API_URL`, `INTELLIGENCE_WS_URL` | Endpoint overrides for your Intelligence deployment           |
| `OPENAI_API_KEY`, `OPENAI_MODEL`              | Model credential and model identifier                         |
| `OPENAI_BASE_URL`                             | Compatible model API endpoint                                 |
| `OPENAI_CODEX_MODEL`                          | Default model for the ChatGPT subscription provider           |
| `CREDENTIALS_SECRET`                          | Encrypts stored provider sign-ins; keep it stable             |
| `OWNER_ID`                                    | Stable identity used for this deployment's conversations      |
| `DATABASE_PATH`                               | SQLite file containing pages, workspace and work metadata     |
| `OWNER_TOKEN`                                 | Optional Bearer token for scripts and automation              |
| `APP_ORIGIN`                                  | Exact browser origin when using a proxy or custom domain      |
| `ALLOWED_HOSTS`                               | Extra host names for browser access, e.g. a LAN address       |
| `COOKIE_SECURE`                               | `auto` (default), `true`, or `false`; see [Sign-in](#sign-in) |
| `TRUST_PROXY`                                 | Rate-limit sign-in by the proxy's `X-Forwarded-For` client    |
| `AGENT_RUN_TIMEOUT_SECONDS`                   | Budget for one agent turn, 30–1800 s (default 300)            |

## Sign-in

The first start creates a single `admin` user. Its password is `ADMIN_INITIAL_PASSWORD` when set; otherwise `admin` when the server binds a loopback `HOST`, or a random one-time password printed once to the server log when it binds an external address (such as Docker's `0.0.0.0`), so a fresh deployment cannot be claimed by whoever reaches it first. The first sign-in requires a new password of 10 to 200 characters. Sessions use an HttpOnly, SameSite=Strict cookie and expire after 7 idle days or 30 days in total; changing the password signs out every other session. Repeated failed sign-ins are rate-limited: five failures from one address block it for 15 minutes, and 50 failures for a username within 15 minutes block that username for every address, so rotating addresses does not buy more guesses. A browser that has signed in successfully keeps a one-year trusted-device cookie and is limited separately (five failures per device), so neither a guessing sweep nor a shared proxy address locks the owner out of a browser they already use. Behind a reverse proxy, every request comes from the proxy's address (the server logs a warning when it sees `X-Forwarded-For` without this setting); set `TRUST_PROXY=true` so the limit uses the right-most `X-Forwarded-For` entry instead. Enable it only when a single proxy you control is the only way to reach the server, or clients could choose their own address.

To reset a forgotten password, run `npm run admin:reset-password` (or `npm run admin:reset-password:prod` after a build; in a container, `docker compose exec app node dist/server/server/reset-admin.js NEW_PASSWORD`). Alternatively set `ADMIN_PASSWORD_RESET` for one restart and remove it afterwards; it is applied once per value (later restarts with the same value leave your new password alone) and must meet the password rules. A reset signs out all sessions and asks for another new password at the next sign-in.

Browser requests must use `localhost`, `127.0.0.1`, the `APP_ORIGIN` host, or a host listed in `ALLOWED_HOSTS`; this blocks DNS-rebinding attacks on the sign-in form. To reach the app by a LAN IP, add that IP to `ALLOWED_HOSTS`. Requests with a valid `OWNER_TOKEN` Bearer header skip sign-in and the host check, for scripts and automation. Because of that, `OWNER_TOKEN` must be at least 24 characters whenever it is set, including on loopback; the server refuses to start otherwise. With `COOKIE_SECURE=auto`, an `https://` `APP_ORIGIN` makes the session cookie `Secure`; otherwise it follows the request (HTTPS or `X-Forwarded-Proto`). Set `COOKIE_SECURE=true` behind an HTTPS proxy that does not send `X-Forwarded-Proto`. A browser `Origin` must match `APP_ORIGIN`, or be the same host as the request on `localhost` or an `ALLOWED_HOSTS` entry.

`AGENT_RUN_TIMEOUT_SECONDS` limits one agent turn (default 300, clamped to 30–1800). Dot-to-Dot delegation runs inside the delegating turn: the delegate must finish 15 seconds before the parent's deadline, delegation needs at least 30 seconds left, and chains stop at two levels and four delegations per turn. Raise the timeout if Dots often delegate long research. A delegated run never gets more access than the Dots that asked for it: only the Spaces, research permission, computer capabilities and MCP servers they all share. Turn delegation off per Dot in its settings. Scheduled tasks wait 15 seconds longer so the agent's own error is recorded. A failed recurring task stays scheduled: it retries after 1 minute, doubling per consecutive failure up to its interval.

## Model providers

Choose a default provider and model in **Settings → Model provider**, and optionally override them for a Dot in its settings. **Automatic** uses the first ready provider. Changing a provider or model stops active work.

- **OpenAI-compatible API key**: `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_BASE_URL` in `.env`.
- **ChatGPT Plus/Pro subscription**: choose **Sign in with ChatGPT**, open the displayed link, and enter the code. This uses the Codex CLI's sign-in and the ChatGPT backend, as [hermes-agent](https://github.com/NousResearch/hermes-agent) does. It is unofficial and undocumented: OpenAI may change it or not permit it for third-party apps, and usage counts against your ChatGPT plan limits. Tokens are stored only on the server, encrypted when `CREDENTIALS_SECRET` is set; if that secret changes, sign in again. This sign-in also enables realtime voice calls (see [Calls](#calls)).

`MODEL_MAX_OUTPUT_TOKENS` caps output tokens for OpenAI-compatible (chat-completions) models: default 16000, clamped to 1000–200000; it does not apply to the ChatGPT subscription provider. `MODEL_REASONING_EFFORT` (`minimal`, `low`, `medium`, or `high`) sets reasoning effort for both providers; unset uses the model's default, and an invalid value stops the server at startup.

The Model menus in Settings and in each Dot list the provider's models with their context windows. The OpenAI-compatible provider lists `GET {OPENAI_BASE_URL}/models` with its key; the ChatGPT provider asks the Codex backend's model list. When a list cannot be loaded, the menu says so and offers a built-in list instead; **Custom model…** accepts any exact model id. Each chat header shows the model in use, the size of the latest model call against the context window, and the tokens the conversation has used (hover for input, cached, output, and reasoning counts). Token counts come from the provider's usage reports; the automatic memory extraction call is not included.

The model environment variable names follow the configured provider adapter. Provider credentials belong in `.env`, not client-side variables or source code. With `INTELLIGENCE_API_KEY`, conversation history lives in the Intelligence project and copying the SQLite file alone does not back it up. Without it, conversations run on the local runtime and their history is stored in the SQLite file; Slack, Automatic Learning, and generated thread names need Intelligence.

## Pages and page conversations

Select a Space to open its page library. Search for a document, switch between grid and list views, or create a new page. The visual editor supports formatting, headings, lists, checklists, tables, and slash commands. Use `/` to insert a block and Cmd/Ctrl+S to save immediately. Pages autosave after editing pauses; the save status tells you whether changes reached the server.

Page actions include creating subpages, moving a page within its Space, and editing Markdown source. Existing documents with unsupported visual-editor syntax stay in source mode to preserve their content. Manual editing works without conversation credentials.

Open a page's chat and choose a specialist with access to that Space. Grant access from the Dot’s settings in the sidebar. The server creates or reuses a CopilotKit Thread for that page and specialist. The Dot receives the current saved page as context and can read, create, and edit pages in its authorized Spaces. The page conversation uses that page’s Space by default; other chats use the Dot’s default page destination. Save your manual edits before asking it to revise the document. Revision checks reject stale writes; a conflict keeps your local draft available for recovery. Failed saves stop automatic retries until you retry or resolve the conflict, so a disconnected session does not silently replace newer content.

Use the conversation's save-to-page action to create a document from its saved text history. This requires a working conversation service. Pages retain a link to the source conversation, and page links in chat open the document workspace.

Back up the SQLite file (pages, thread bindings, and local conversation history) and, when configured, the Intelligence project. The template does not include multi-user page sharing, realtime collaboration, file uploads, or arbitrary interactive embeds.

## Browser tool

Parallel is selected by default (`WEB_SEARCH_PROVIDER=parallel`). Live research needs the model configuration, but no browser worker. An optional server-side `PARALLEL_API_KEY` enables authenticated usage and higher limits. The anonymous MCP endpoint is free for light use. Queries, selected URLs, research objectives and a stable session identifier go to Parallel. See [public-web research](../README.md#public-web-research) for data sharing, permissions and limitations.

Set `WEB_SEARCH_PROVIDER=disabled` to turn off these research tools, or `WEB_SEARCH_PROVIDER=browser` for the existing URL-only reader. The browser service reads a supplied public URL and returns page text and a capture. Configure `BROWSER_URL` and `BROWSER_SECRET`, then run:

```sh
npx playwright install chromium
npm run browser
```

Use the same secret on the app and browser processes. Browser navigation is read-only with JavaScript disabled. Private addresses, redirects, and authenticated pages are unsupported; provide a canonical public URL. This is a bounded research tool, not a general desktop or shell.

## Persistent Dot computers

For a separate browser, persistent files, and optional shell for each specialist, follow [Computer setup](COMPUTERS.md). This uses pinned OpenBot computer/supervisor services and per-Dot permissions. Parallel research tools remain available alongside configured computer tools. With the browser provider selected, Dots use their computer tools in place of the read-only public-page tool; enable each Dot's required capabilities before use.

## Slack

OpenDots uses `@copilotkit/channels` with a managed Slack connection, following the runtime and channel pattern in [OpenTag](https://github.com/CopilotKit/OpenTag). The application declares the channel and its specialist agent; Intelligence manages the Slack adapter and delivery. You do not need a separate Slack webhook server or Socket Mode connection in OpenDots.

### Create the managed channel

Select the same Intelligence project used by this application, then create a uniquely named channel:

```sh
npx --yes copilotkit@latest project select
npx --yes copilotkit@latest channels add --name opendots --display-name "OpenDots" --adapter slack --json
```

Follow the CLI's returned `nextAction` to create the Slack app from its generated manifest, supply credentials through the managed setup flow, and run its `resumeCommand`. A `blocked` response means a Slack-console step is still needed; a `failed` response must be resolved before continuing. Keep Socket Mode off. Install or reinstall the generated app in your workspace with its requested scopes. Use a distinct channel name for separate deployments so they do not compete for deliveries.

See [OpenTag's setup guide](https://github.com/CopilotKit/OpenTag/blob/main/setup.md) for the Slack-console walkthrough. Slack bot tokens and signing secrets belong in the managed adapter configuration, not the browser or this application's `.env`.

### Connect a specialist

Configure the application server's `.env` alongside its Intelligence and model credentials:

```dotenv
SLACK_CHANNEL_NAME=opendots
SLACK_TEAM_ID=T_REPLACE_WITH_WORKSPACE_ID
SLACK_USER_IDS=U_REPLACE_WITH_YOUR_USER_ID
SLACK_DOT_ID=REPLACE_WITH_DOT_ID
```

`SLACK_CHANNEL_NAME` must exactly match the managed channel name, not a Slack conversation name such as `#general`. OpenTag calls this setting `INTELLIGENCE_CHANNEL_NAME`; OpenDots uses `SLACK_CHANNEL_NAME`. `SLACK_TEAM_ID` and the comma-separated `SLACK_USER_IDS` restrict who may invoke the specialist. Every listed user acts as the owner; with more than one listed, Slack conversations neither save nor learn memories, because a message cannot be attributed to you. `SLACK_DOT_ID` selects an existing Dot; find IDs in the authenticated `/api/workspace` response. If omitted, it defaults to the initial Dot.

Restart OpenDots after changing environment settings and inspect Slack status in Settings & setup. Channel activation must complete before trying a message. Mention the installed bot in a channel it can access; subsequent messages in that followed thread go to the same specialist. Unrelated threads, bot events, edits, deletions, and users outside the allowlist do not start agent runs. Editing a message to add a mention is not supported; send a new message instead.

This template maps permitted Slack users to the single OpenDots owner. Replies are visible to the Slack conversation's audience, so choose the specialist's Space access and permitted tools accordingly. This is not a multi-user identity model.

### Verify your deployment

From an allowed user, mention the bot and verify a response in the same Slack thread. Reply in that thread and confirm continuity. Check that an unrelated thread and an unapproved user cannot invoke it. Pause the assistant in OpenDots and verify that a permitted request receives a paused notice. Check Settings & setup for channel connection failures.

Local tests exercise channel behavior with fixtures. A live Slack mention/reply remains unverified until you provision the managed connection and model credentials. [Channels SDK documentation](https://github.com/CopilotKit/channels-sdk) describes extending the adapter and channel behavior.

## Calls

Calls use realtime speech over WebRTC and keep text and voice in one conversation. There are two ways to run them; when both are set up, the ChatGPT sign-in is tried first and the API key is the fallback.

**ChatGPT subscription (unofficial).** With **Sign in with ChatGPT** connected, calls use the same realtime voice the Codex CLI uses on ChatGPT Plus/Pro, with ChatGPT's voices (`cove` by default; also `juniper`, `maple`, `spruce`, `ember`, `vale`, `breeze`, `arbor`, `sol`). `VOICE_CHATGPT_VOICE` and `VOICE_CHATGPT_MODEL` (default `gpt-live-1-codex`) override them. This follows an undocumented protocol: OpenAI may change it at any time, and usage counts against your plan's voice limits. If a call fails, the error lists the HTTP status from each endpoint tried. During the call, the voice model hands tasks to the Dot (`delegation.created` on the WebRTC data channel); the browser relays each one to the same Dot agent that serves the chat, with the same tools and permissions, and sends the result back for the voice to summarize. A call can run up to 20 tasks. Spoken delegation over the ChatGPT protocol is not yet verified live.

**Realtime API key.** The included speech adapter uses the Realtime API at `api.openai.com`. Set `VOICE_API_KEY` to a key with access to that API and `VOICE_MODEL` to a supported Realtime model (the local UI test used `gpt-realtime-2.1`); `VOICE_NAME` selects the voice. `OPENAI_BASE_URL` changes the compute model endpoint only, not speech. Calls use browser microphone access and WebRTC. Hosted deployments need HTTPS. The server mediates provider setup and delegates compute to the selected Dot's conversation.

A configured key is not evidence of a successful call. Verify microphone access, audio playback, compute delegation, interruption, hangup, and the saved receipt with your deployment before relying on voice workflows.

## Memory

Dots remember lasting facts about you across conversations. Memories come from three places, labeled in the **Memories** view:

- **Added by you** in the Memories view.
- **Saved by a Dot** when you say "remember that…", share a lasting preference, or ask it to forget something (`save_memory`, `update_memory`, `forget_memory` tools). A chip in the chat shows each change.
- **Learned automatically**: after each chat turn, a separate model call extracts durable facts about you. It is on by default; turn it off with **Settings → Learn memories automatically**. It adds one model call per turn, which counts against provider limits (including ChatGPT plan limits). Scheduled tasks, voice compute, and receipts are skipped.

A memory is either for every Dot or for one Dot. Dots only see global memories and their own. The newest memories that fit a fixed budget are included in each turn and in Realtime call instructions. **Use saved memories** (globally or per Dot) turns all of this off. Memories are stored in the local database and sent to your model provider with each turn; never store secrets in them, and obvious passwords, keys, and card numbers are refused.

## Skills and MCP servers

Open **Skills & MCP** in the sidebar to give Dots new abilities. Both are available to every Dot by default; limit each one to chosen Dots, or switch it off. Changing what a Dot may use stops its active run, like other permissions.

**Skills** use the [Agent Skills](https://agentskills.io) `SKILL.md` format: a name, a one-line description, Markdown instructions, and optional bundled text files (templates, references, scripts). Create one in the editor, import a `SKILL.md`, or import a skill folder. A Dot sees only each skill's name and description; it loads the instructions with `load_skill` when a task matches and reads bundled files with `read_skill_file`. Skills are text: a bundled script runs only if the Dot copies it into its computer and runs it there. Dots can also write skills: when you ask, a Dot saves a new skill with `create_skill` and improves its own skills with `update_skill` (owner-written skills stay read-only to Dots). A Dot's new skill is available only to that Dot and shows **Created by** in Skills & MCP, where you can review, edit, or share it with other Dots. Turn this off per Dot with **Create skills** in its settings. Read imported skills before enabling them — they are instructions the Dot will follow.

**MCP servers** connect Dots to remote [Model Context Protocol](https://modelcontextprotocol.io) servers over Streamable HTTP (SSE as a fallback). Add the server URL and any headers it needs, such as `Authorization: Bearer …`; header values are stored on the server, encrypted with `CREDENTIALS_SECRET` when it is set, and never sent back to the browser. Then select **Test connection**: Dots get only the tools listed by the last successful test, optionally narrowed to the tools you check, so a server cannot add tools without your review. Tools appear to the model as `mcp_<server>_<tool>`. A server that is down is skipped for that turn and the Dot is told it is unavailable. MCP OAuth sign-in is not supported yet; use servers that accept a token header.

Local (stdio) MCP servers are not run by OpenDots, because that would run commands on the host. Run them in their own container behind an HTTP bridge and add the bridge URL instead. For example, with [supergateway](https://github.com/supercorp-ai/supergateway) in `compose.override.yml`:

```yaml
services:
  mcp-files:
    image: node:24-bookworm-slim
    command: >
      npx -y supergateway --port 8000
      --stdio "npx -y @modelcontextprotocol/server-filesystem /files"
    volumes:
      - ./mcp-files:/files
    networks: [mcp-link]
  app:
    networks: [mcp-link]
networks:
  mcp-link:
    internal: true
```

Then add the server in OpenDots with the URL `http://mcp-files:8000/sse`. Keep bridges on an internal network: anything that can reach the bridge can use its tools.

## Containers

Set `BROWSER_SECRET` to a random secret of at least 24 characters in `.env` (and optionally a different `OWNER_TOKEN` for automation), then run:

```sh
docker compose up --build -d
```

Open http://localhost:4310 and sign in as `admin` with `ADMIN_INITIAL_PASSWORD`, or, if unset, the one-time password in `docker compose logs app` (the container binds `0.0.0.0`, so it does not use `admin`). You must choose a new password at first sign-in. The app port binds to loopback on the host. The image has a health check against the unauthenticated `GET /api/health`, which returns only `{"ok":true}`. The browser service is optional: set a 24+ character `BROWSER_SECRET` and run `docker compose --profile browser up --build` to enable it; it has no published port. Application metadata lives in the `opendots-data` volume. The container runs as the `node` user (UID 1000); if you replace the volume with a bind mount such as `./data:/data`, run `sudo chown -R 1000:1000 ./data` first.

```sh
# Stop services while retaining saved data.
docker compose down
```

For remote hosting, follow [Deploy on a VPS](#deploy-on-a-vps). See [Security](../SECURITY.md) for the template's deployment boundary.

## Deploy on a VPS

1. **DNS.** Point an `A`/`AAAA` record for your domain (e.g. `dots.example.com`) at the server, and open ports 80 and 443 only.
2. **`.env`.** Besides your model settings:

   ```dotenv
   APP_ORIGIN=https://dots.example.com
   COOKIE_SECURE=true
   TRUST_PROXY=true
   ADMIN_INITIAL_PASSWORD=choose-a-long-first-password
   CREDENTIALS_SECRET=a-long-random-secret-kept-stable
   # Optional: AGENT_RUN_TIMEOUT_SECONDS=300
   ```

   Generate secrets with `openssl rand -base64 32`. Without `ADMIN_INITIAL_PASSWORD`, read the one-time password from `docker compose logs app`. Either way you set a new password at first sign-in.

3. **Start.** `docker compose up --build -d`. Compose publishes the app only on `127.0.0.1:4310`, so it is reachable solely through the proxy; this is what makes `TRUST_PROXY=true` safe. Stopping waits up to 15 seconds (`stop_grace_period`) while the server finishes requests and closes open streams.
4. **Reverse proxy.** Terminate HTTPS and forward to `127.0.0.1:4310`, keeping the `Host` header, adding the client to `X-Forwarded-For`, setting `X-Forwarded-Proto`, and not buffering streamed agent responses. Agent turns stream for up to `AGENT_RUN_TIMEOUT_SECONDS`, and request bodies to `/api/copilotkit` can reach 32 MB.

   **Caddy** (preferred; obtains certificates automatically and sets the forwarding headers):

   ```caddy
   dots.example.com {
   	reverse_proxy 127.0.0.1:4310 {
   		flush_interval -1
   	}
   }
   ```

   **nginx** (with a certificate from e.g. certbot):

   ```nginx
   map $http_upgrade $connection_upgrade {
       default upgrade;
       ''      '';
   }
   server {
       listen 443 ssl;
       http2 on;
       server_name dots.example.com;
       ssl_certificate     /etc/letsencrypt/live/dots.example.com/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/dots.example.com/privkey.pem;
       client_max_body_size 32m;
       location / {
           proxy_pass http://127.0.0.1:4310;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection $connection_upgrade;
           proxy_buffering off;
           # At least AGENT_RUN_TIMEOUT_SECONDS plus a margin.
           proxy_read_timeout 360s;
           proxy_send_timeout 360s;
       }
   }
   ```

5. **Verify.** `curl -fsS https://dots.example.com/api/health` returns `{"ok":true}`; then sign in and change the password. Back up the `opendots-data` volume.

## Automatic Learning

OpenDots connects [CopilotKit Automatic Learning](https://docs.copilotkit.ai/learning)
to individual Dots. It uses the existing server-side `INTELLIGENCE_API_KEY` and
optional `INTELLIGENCE_API_URL`; no additional model key or frontend key is needed.

1. Open **Learning** in the same Intelligence project and create a container for
   one focused workflow, such as `research-workflow`. IDs use 1–64 lowercase
   letters, numbers, and single hyphens.
2. In OpenDots, edit the Dot and enter that ID under **Automatic Learning**.
   Saving the ID configures routing; it does not create or verify the remote container.
3. Start new conversations and complete related workflows. Each conversation keeps
   the container assigned when it was created. Existing conversations, including
   ones created before this integration, are not enrolled retroactively. Changing
   or clearing the Dot's ID affects only new conversations. This applies to page
   chat, scheduled and voice compute in those conversations, and new Slack threads.
4. In Intelligence, inspect the evidence, run Learning manually or use its schedule,
   and review and publish proposed skills. The default automatic threshold is 15
   eligible threads; use the readiness count shown in your deployment.
5. Enable **Skill delivery** on the Intelligence container, then enable **Use
   published skills** in the Dot's settings. Start a new turn in an enrolled
   conversation. BuiltInAgent loads the latest verified published catalog; its
   TanStack AI factory runs the model and exposes `copilotkit_load_skill` and `copilotkit_read_skill_file`.
   The model decides which relevant skills to load. Check the run's tool calls to
   verify actual use; saving settings alone does not establish connectivity.

Skill delivery always uses the conversation's original container, even after the
Dot is pointed at another container. The Dot's delivery checkbox applies to all its
conversations. Unchecking it stops delivery on subsequent turns; changing Learning
settings also stops active work. Conversations without a container do not request
skills. Existing research, memory, page, and computer permissions still apply.

Ingestion and delivery are separate. Clearing the container does not unenroll older
conversations; pause Learning in Intelligence to stop its analysis. Turning off
delivery does not stop evidence collection. A delivery denial or an unavailable
initial skill snapshot fails the turn rather than silently continuing without the
configured skills. Restore delivery or uncheck **Use published skills** to continue
without them. Skills require review and publication in Intelligence; OpenDots does
not automatically approve them.

The integration uses an explicit container list, so ambient
`CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` and `CPK_INTELLIGENCE_SKILLS_REVISION`
variables do not override a conversation's configuration. Self-hosted Intelligence
must support the [skill delivery endpoints](https://docs.copilotkit.ai/intelligence/learned-skills).

## Development checks

```sh
npm run check-format
npm run lint
npm run typecheck
npm test
npm run build
```

Automated tests use service fixtures. Live model, Intelligence, Slack, and voice verification requires your own configured services.
