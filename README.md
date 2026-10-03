# ReadyFor

ReadyFor is a synthetic-data care-coordination demo that helps a surgical team find preparation blockers before surgery day. The core applies documented readiness rules; staff verify evidence and approve medication templates. It does not generate medication instructions.

## Run the core and coordinator dashboard

Requires Bun. Copy the environment template and keep any keys in the ignored local `.env`:

```sh
cp .env.example .env
bun install
bun start
```

The core listens on `http://localhost:8787`. It runs with in-memory storage and a keyword fallback model when `DATABASE_URL` and `GEMINI_API_KEY` are unset. Set `RECORD_FIXTURES=1` to use the offline FinchNode/RxClass fixtures.

In a second terminal, run the dashboard:

```sh
cd dashboard
bun install --frozen-lockfile
cd ..
bun run dashboard
```

Open [http://localhost:4173](http://localhost:4173). The dashboard requires Neon Auth and an allowlisted staff account before loading surgery data. For an explicit local synthetic preview, use `DASHBOARD_PROVIDER=mock bun run dashboard` outside production.

## Staff sign-in and roles

`neon.ts` declares `auth: true`. Enable the provider and pull its branch URLs:

```sh
neon deploy
neon env pull --service auth --file .env
```

Keep keys in the ignored local `.env`. `NEON_AUTH_BASE_URL` and `NEON_AUTH_JWKS_URL` come from Neon. Set `STAFF_ALLOWLIST` as `email,role,Name[,asiSender]`, with entries separated by semicolons. Email matches require verification; creating a Neon account alone grants no access. Assign the initial owner the `admin` role. Set `AUTH_REQUIRED=1` so startup refuses to run without auth.

Generate separate `IMESSAGE_SERVICE_TOKEN` and `AGENT_SERVICE_TOKEN` locally (`openssl rand -hex 32`), and give each service only its own token. The agent's local configuration must use the same `AGENT_SERVICE_TOKEN` as the core. Generate `NEON_AUTH_COOKIE_SECRET` of at least 32 characters for the managed SDK's signed session cache. Never paste these values into chat or commit them.

The dashboard uses `@neondatabase/auth` for signup, email-code verification, sign-in, password recovery and signout. It calls the core's `GET /me` to show the server-resolved staff name and role. Coordinators can act on logistics and instructions; lab, medication and health actions require nurse, surgeon or admin. Reset requires admin. Server checks remain authoritative.

Provider requests use the same-origin `/auth/provider/` gateway and core requests use `/api/`. A fresh JWT is obtained for every call; 401 triggers one refresh/retry, then returns the user to sign-in. 403 is shown without retry. JWTs are not persisted in browser storage. Lab reports are fetched with the token and displayed using temporary blob URLs. Client-provided audit actors are omitted.

Register the exact dashboard origin as a trusted Neon Auth domain (`neon neon-auth domain add http://localhost:4173`) and set `CORS_ORIGINS` when using a different browser origin. `DASHBOARD_ORIGIN` defaults to `http://localhost:4173`; `READYFOR_CORE_URL` defaults to `http://localhost:8787`. The dashboard verifies that core health reports `auth: "neon"` before enabling staff login. Public self-signup, invitation management and onboarding tables are separate future work; this version's permissions use the local allowlist.

Validate with `bun test`, `bun run typecheck`, `bun run --cwd dashboard typecheck`, `bun run seed:check`, and the agent's offline auth tests. Account rate limits are per dashboard process; multiple instances need shared or ingress limits. Live sign-in and verification require the user to create or enter their own password in the browser.

Use **Reset demo** to reload the synthetic surgeries, then open Harriet’s surgery and select **Run record check**. Reset clears all current demo records in the configured database before reloading the fixture; with a `DATABASE_URL`, use this only on the demo database. The record check creates the readiness requirements from FinchNode/RxClass or their offline fixtures.

The right panel supports staff verification, staff-approved template approval, reject/waive flows, task creation and completion, simulated patient replies, and photo/PDF uploads. Medication approval prompts for a staff-written sentence when the selected approved template requires it. The bundled [sample lab report](db/seed/assets/sample-lab-report.png) is synthetic and can be sent directly from the patient-message panel. Real photo extraction requires `GEMINI_API_KEY`; the fake model intentionally cannot read ordinary images.

## Validate the dashboard’s offline fixture

```sh
bun run seed:check
```

This checks `db/seed/fixtures.json`, the fallback dashboard fixture. It does not write to the database. The core’s own seed is `db/seed/demo.json` and is loaded by the documented `/demo/reset` route.

## Run the Fetch.ai coordinator agent

Requires Python 3.11 or newer:

```sh
cd agent
python -m venv .venv
source .venv/bin/activate
python -m pip install -e .
cp .env.example .env
```

Set a private, stable `UAGENT_SEED` in `agent/.env`. `READYFOR_CORE_URL` defaults to `http://localhost:8787`; it must point to a reachable core URL when the agent runs outside the same machine/network. Start the agent with:

```sh
python -m readyfor_agent
```

The agent uses Fetch.ai’s Chat Protocol and sends its service token plus the incoming ASI:One sender on every request. It can report surgeries at risk this week, fetch a patient’s documented readiness brief, and stage task creation or requirement verification for explicit chat confirmation. It calls the documented `/surgeries`, `/surgeries/:id/brief`, `/tasks`, and `/requirements/:id/actions` routes. Readiness remains in the core rules, and the agent does not provide clinical advice.

For ASI:One, open the Inspector URL printed by the agent and connect it to a mailbox through Agentverse. The mailbox receives ASI:One messages without exposing the agent’s local port. Link the incoming sender to a staff entry in `STAFF_ALLOWLIST` before reads or writes will be permitted. Send a greeting through ASI:One and read the agent's `ReadyFor chat sender` log to obtain that address; it is not ReadyFor's own address. The core URL must be reachable by the agent process; keep the agent seed and any account credentials out of Git and out of chat.

## Photon and environment

The Spectrum adapter under `imessage/` is a separate process that calls the core. Configure `PROJECT_ID`, `PROJECT_SECRET`, and `DEMO_PATIENT_PHONE` in the root `.env`, then start it with `bun run imessage`. Test the live connection from a phone; the simulated dashboard channel works without iMessage.

The shared API and workflow rules are in [docs/contract.md](docs/contract.md). Use synthetic data only. `DATABASE_URL` should point to the hackathon/demo database, never a real clinical system.
