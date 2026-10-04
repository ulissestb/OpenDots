# Security

OpenDots is an application template under development, not a hosted service. The local prototype is single-owner; Space membership, Slack identity mapping, and voice delegation require additional enforcement before connected multi-user use. It is not a security-audited autonomous agent.

## Intended boundary

- Run local development on loopback.
- Protect remote deployments with HTTPS. Change the initial `admin` password before exposing the app; sign-in uses HttpOnly SameSite=Strict session cookies, scrypt password hashes, and failed-attempt rate limits.
- Provider sign-ins (such as ChatGPT) are stored server-side and never returned to the browser. Set `CREDENTIALS_SECRET` to encrypt them at rest; this protects copied databases, not a compromised host.
- Keep the browser service isolated from the application host and private networks. Do not expose its port publicly.
- Keep Intelligence, model, speech, and browser credentials on the server. Never commit `.env` files or local databases.
- Treat page text, uploaded content, and model output as untrusted data, not authorization to change permissions.
- Authorize every Space, Dot, and thread operation on the server. Map Slack actors explicitly; never treat a display name or client-supplied user ID as proof of identity.
- Voice sessions must use scoped, short-lived credentials and route compute actions through the same permissions as text and Slack. ChatGPT-subscription calls are created by the server with the stored sign-in; the browser only receives the WebRTC answer, never the token.
- Memories are untrusted data in prompts. Saved and automatically learned memories are sent to the model provider with each turn, and automatic learning sends each finished exchange to the provider once more. Memory writes persist across conversations, so a prompt injection that reaches a memory survives the turn: Dots are instructed to save only what the owner says directly, and obvious secrets are refused, but review the Memories view periodically. Disable memory or automatic learning in Settings when that is not acceptable.
- Dot-to-Dot delegation is on by default. A delegate runs under its own permissions, so a Dot can reach tools it lacks by delegating, and text a page or message injects into one Dot can travel to another as a delegated task. Delegated turns are marked internal: they never save memories and are not used for automatic learning. Each delegation is a separate conversation you can inspect; turn delegation off per Dot where that is not acceptable.
- A new skill or MCP server is available to every Dot unless you limit it to chosen Dots, and Dot-to-Dot delegation is on by default, so adding one MCP server lets any Dot use that service directly or through another Dot. Limit servers that can write to outside services to the Dots that need them, and turn delegation off for Dots that should not reach them.
- Skills are owner-provided instructions: a Dot follows a loaded skill, so read imported skills before enabling them. Skill files are text and never run on the host. Dots may write skills of their own (on by default per Dot): like memories, a written skill persists across conversations, so a prompt injection that reaches one survives the turn. Dot-written skills start private to their author, cannot overwrite owner skills, are never written from delegated tasks, and are listed with their author for review; turn off **Create skills** for Dots that read untrusted content.
- MCP servers act on outside services with the credentials you give them. Only remote servers are supported; stdio servers would run commands on the host, so run them in a separate container behind an HTTP bridge on an internal network. Header values are encrypted at rest with `CREDENTIALS_SECRET` and never returned to the browser. Dots get only tools from the server's last tested list (optionally narrowed by you), and tool results are untrusted data. Any URL is accepted, including private addresses, so a bridge can be reached; add only servers you trust, and remember a Dot can reach another Dot's servers by delegating.
- Research browsing is read-only. Page tools can edit local documents in the executing Dot’s Space; those writes use revision checks. Adding external writes requires a separate authorization and review design.

Recurring work requires an available server. A sample run is not evidence that a live provider or deployment is safe or configured correctly. Review results before using them for important decisions.

## Reporting

Use the repository's private vulnerability reporting feature when available. If it is unavailable, open an issue asking for a private reporting channel without including exploit details, credentials, private URLs, or personal data.

Do not post sensitive reproduction data in a public issue. This project does not currently promise a response-time SLA or offer a bug bounty.
