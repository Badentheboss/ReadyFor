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
bun run dashboard
```

Open [http://localhost:4173](http://localhost:4173). The dashboard uses the live core by default (`GET /surgeries`, `GET /surgeries/:id`, and the documented action routes). To deliberately view its local-only demo fixture instead, run `DASHBOARD_PROVIDER=mock bun run dashboard`. The mock mode does not change the core or Neon.

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
