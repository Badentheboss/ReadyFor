# ReadyFor

ReadyFor is a synthetic-data care-coordination demo that helps a surgical team find preparation blockers before surgery day. Staff verify evidence and approve medication templates; the system does not write medication instructions.

## Run the dashboard

Requires Bun. From the repository root:

```sh
bun install
bun run dashboard
```

Open [http://localhost:4173](http://localhost:4173). The mock dashboard shows three surgeries, readiness levels, blocker owners, and coordinator actions. Those actions update only the in-memory demo fixture and do not contact patients or write to Neon.

`DASHBOARD_PROVIDER=mock` is the default. The `core` provider is intentionally unavailable until the core API routes and response types are documented in `docs/contract.md`.

## Validate demo seed data

```sh
bun run seed:check
```

This checks the synthetic fixture structure and safety placeholders. It does not connect to Neon or write data. A database seed loader will be added once `db/schema.sql` is available.

## Run the Fetch.ai coordinator agent

Requires Python 3.11 or newer. The agent scaffold uses Fetch.ai's Chat Protocol and currently returns a clear unavailable response until core routes are defined.

```sh
cd agent
python -m venv .venv
source .venv/bin/activate
python -m pip install -e .
cp .env.example .env
```

Set `UAGENT_SEED` in `agent/.env` to a private, stable seed phrase, then run:

```sh
python -m readyfor_agent
```

Configure the Agentverse mailbox using its account interface when ready. Never commit `.env`, private seed phrases, or service credentials.

## Environment and Photon

Copy the repository `.env.example` to `.env` and fill in credentials locally. `.env` is ignored by Git.

```sh
cp .env.example .env
```

The generated Spectrum starter lives under `src/` and uses `PROJECT_ID` and `PROJECT_SECRET`. Gemini and Neon credentials are listed in `.env.example`. Test live iMessage behavior from a phone after configuring Photon.

## Integration status and safety

Dashboard data loads from `db/seed/fixtures.json`. The database writer, dashboard live-core adapter, and agent's route calls must follow `docs/contract.md` and `db/schema.sql` when those shared files land; no route, payload, or table shape is assumed in this branch. Keep all data synthetic. Medication wording must be staff-approved, and blockers count as cleared only after staff verification.
