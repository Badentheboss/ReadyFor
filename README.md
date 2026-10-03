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

Open [http://localhost:4173](http://localhost:4173). This staff-onboarding branch shows a configuration screen until Neon Auth and core authorization are connected. To view the local synthetic dashboard while that integration is pending, run `DASHBOARD_PROVIDER=mock bun run dashboard`. Mock mode is explicit, limited to localhost outside production, and does not change the core or Neon.

## Staff signup integration status

This branch prepares invitation signup, email-code verification, sign-in, password recovery, pending access, a short staff introduction, and administrator-generated invitation links. Patients continue through iMessage. Invitations are links for an administrator to share; the dashboard does not send invitation emails.

The managed Neon SDK is pinned in `dashboard/package.json`. Provider requests use the same-origin `/auth/provider/` gateway; core requests use `/api/` with a short-lived bearer JWT. The client does not persist JWTs in browser storage. Evidence images are fetched with authorization and displayed through temporary blob URLs. The gateway checks request origins, restricts routes, bounds bodies, and limits account writes per client address.

**Not yet connected:** the shared core contract, membership/invitation tables, server-side JWT/role checks, initial admin bootstrap, and Neon Auth provisioning. The required API and validation checklist are in [dashboard/auth-contract.md](dashboard/auth-contract.md). The existing core still has no authentication; this dashboard preparation does not secure its direct port. Keep the core local and use synthetic data until server authorization is implemented.

Once the core extension is implemented, configure these locally without posting credentials in chat:

| Variable | Purpose |
| --- | --- |
| `NEON_AUTH_BASE_URL` | Managed Auth URL for the selected Neon branch |
| `NEON_AUTH_COOKIE_SECRET` | Random local secret of at least 32 characters for the official SDK's session cache |
| `DASHBOARD_ORIGIN` | Exact browser origin, defaults to `http://localhost:4173` |
| `READYFOR_CORE_URL` | Core upstream, defaults to `http://localhost:8787` |
| `STAFF_AUTH_ENABLED=1` | Explicit activation after core authorization is ready |

The dashboard also requires the core health response to advertise the implemented auth contract. A configured Neon provider alone cannot activate staff mode against the inherited unauthenticated core. The first administrator email is still to be selected; never grant admin to the first arbitrary signup. Configure the exact dashboard origin in Neon Auth's trusted origins. Managed verification and password-recovery emails require provider setup; live delivery has not been tested.

Validate this branch with `bun test`, `bun run typecheck`, `bun run --cwd dashboard typecheck`, and `bun run seed:check`. Gateway rate limiting is per process; a deployment with multiple dashboard instances needs a shared limiter or ingress rate limits.

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

The agent uses Fetch.ai’s Chat Protocol. It can report surgeries at risk this week, fetch a patient’s documented readiness brief, and stage task creation or requirement verification for explicit chat confirmation. It calls the documented `/surgeries`, `/surgeries/:id/brief`, `/tasks`, and `/requirements/:id/actions` routes. Readiness remains in the core rules, and the agent does not provide clinical advice.

For ASI:One, open the Inspector URL printed by the agent and connect it to a mailbox through Agentverse. The mailbox receives ASI:One messages without exposing the agent’s local port. The core URL must be reachable by the agent process; keep the agent seed and any account credentials out of Git and out of chat.

## Photon and environment

The Spectrum adapter under `imessage/` is a separate process that calls the core. Configure `PROJECT_ID`, `PROJECT_SECRET`, and `DEMO_PATIENT_PHONE` in the root `.env`, then start it with `bun run imessage`. Test the live connection from a phone; the simulated dashboard channel works without iMessage.

The shared API and workflow rules are in [docs/contract.md](docs/contract.md). Use synthetic data only. `DATABASE_URL` should point to the hackathon/demo database, never a real clinical system.
