# Deploying ReadyFor

ReadyFor runs as four processes. Only the first two need a public HTTPS URL.

| Process | Command | Public? | Health check |
| --- | --- | --- | --- |
| Core API | `bun core/src/main.ts` | Yes, for the Fetch.ai agent (or keep private and run the agent beside it) | `GET /ready` |
| Dashboard | `bun dashboard/server.ts` | Yes, staff open it in a browser | `GET /` |
| iMessage adapter | `bun imessage/src/main.ts` | No, it only calls out to Photon and the core | process stays up; logs `Spectrum started` |
| Fetch.ai agent | `python -m readyfor_agent` (in `agent/`) | No, it uses an Agentverse mailbox | logs its agent address |

All four read their settings from environment variables. Never bake `.env` into an image; `.dockerignore` excludes it.

## Container images

```sh
docker build -t readyfor-core .
docker build -f dashboard/Dockerfile -t readyfor-dashboard .
```

The core image runs the core by default and the adapter with a different command:

```sh
docker run --env-file .env -p 8787:8787 readyfor-core
docker run --env-file .env readyfor-core bun imessage/src/main.ts
docker run --env-file .env -p 4173:4173 readyfor-dashboard
```

The core image sets `AUTH_REQUIRED=1`, so it refuses to start without Neon Auth. Its `HEALTHCHECK` calls `/ready`, which answers 200 only when the database responds.

Any container host works (Railway, Render, Fly.io, a VM). Point the platform's health check at `/ready` for the core.

## Settings per process

**Core**

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon pooled connection string. Schema upgrades run on start and are idempotent. |
| `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL` | yes | From `neon env pull`. |
| `STAFF_ALLOWLIST` | yes | `email,role,Name[,asiSender]; ...` |
| `IMESSAGE_SERVICE_TOKEN`, `AGENT_SERVICE_TOKEN` | yes | 32+ characters each, different from each other. |
| `CORS_ORIGINS` | yes | The dashboard's HTTPS origin. |
| `AUTH_REQUIRED` | set to `1` | Already set in the image. |
| `GEMINI_API_KEY` | yes | `GEMINI_MODEL` defaults to `gemini-3.8-flash`, with fallbacks. |
| `DEMO_PATIENT_PHONE`, `ONCALL_*_PHONE` | for the phone demo | Each number must be a user on the Photon project. |
| `ESCALATION_MINUTES` | no | Use `1` while presenting. |
| `CORE_PORT` | no | Default 8787. Most hosts inject `PORT`; set `CORE_PORT` to the same value. |

**Dashboard**

| Variable | Notes |
| --- | --- |
| `DASHBOARD_ORIGIN` | Its own public HTTPS origin, e.g. `https://readyfor.tech`. |
| `READYFOR_CORE_URL` | The core's URL as the dashboard server reaches it (internal URL is fine). |
| `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET` | Cookie secret 32+ characters. |
| `DASHBOARD_PORT` | Default 4173. |

Register the dashboard origin with Neon Auth before anyone signs in:

```sh
neon neon-auth domain add https://readyfor.tech
```

**iMessage adapter:** `PROJECT_ID`, `PROJECT_SECRET`, `CORE_URL`, `IMESSAGE_SERVICE_TOKEN`.

**Agent:** `UAGENT_SEED`, `READYFOR_CORE_URL`, `AGENT_SERVICE_TOKEN`. Link each ASI:One sender to a staff entry in the core's `STAFF_ALLOWLIST`.

## Order of operations

1. Create or reuse the Neon project; run `neon deploy` and `neon env pull`.
2. Start the core; confirm `GET /health` shows `"database":"neon"`, a Gemini model, and `"auth":"neon"`, and `GET /ready` returns 200.
3. Start the dashboard with `READYFOR_CORE_URL` pointing at the core. It checks the core's health once at startup, so start it **after** the core is up; restart it if the core was down.
4. Start the adapter; it should log `Spectrum started` and then nothing until there is traffic.
5. Start the agent; open the Inspector link it prints and connect the mailbox in Agentverse.

## Photon on the shared (free/pro) plan

Shared lines only message numbers registered as users on the Photon project, and only after that number has texted the line once. Add the patient and on-call numbers under **Users** in the Photon dashboard and text the line from each phone before the demo. Otherwise sends fail with `Target not allowed for this project`; ReadyFor shows the failure on the card with a **Retry send** button.

## Local development

See the README. In short: `bun start` (core), `bun run dashboard`, `bun run imessage`, each in its own terminal, core first.
