# ReadyFor

ReadyFor is an iMessage care-coordination demo that helps a surgical team find and clear preparation blockers before surgery day. The demo uses synthetic patients and a rules-based readiness level. Staff review and approve requirements; the agent does not create medication instructions.

## Repository areas

- `core/` and `imessage/` — core service and patient channel
- `dashboard/` — coordinator dashboard; currently uses local synthetic mock data
- `db/seed/` — synthetic fixtures, to be mapped to the shared schema
- `agent/` — Fetch.ai coordinator agent, to be wired to the documented core contract
- `docs/contract.md` and `db/schema.sql` — shared API and database contract

## Run the dashboard mock

The dashboard is intentionally independent of the core until the shared contract is available. It demonstrates three synthetic surgeries, readiness states, open blockers, owners, and mock coordinator actions.

```sh
bun run dashboard/server.ts
```

Then open [http://localhost:4173](http://localhost:4173). Set `DASHBOARD_PORT` to use another port. The mock actions update only browser memory and do not write to a database or send patient messages.

## Environment setup

Copy `.env.example` to `.env` and fill values locally. `.env` is ignored by Git; never commit or paste credentials into issues, chats, or source files.

```sh
cp .env.example .env
```

Photon requires `PROJECT_ID` and `PROJECT_SECRET`. Gemini requires `GEMINI_API_KEY`. Neon requires `DATABASE_URL`. Fetch.ai Agentverse credentials belong in the local environment when agent registration is ready. Keep ElevenLabs variables out unless the spoken-reminder stretch is implemented.

The Photon adapter is the generated Spectrum starter under `src/`. Its live iMessage behavior requires the Photon project credentials and a phone-based integration check.

## Integration status

The dashboard fixture and the seed JSON are temporary contract-independent work. Once `docs/contract.md` and `db/schema.sql` are available, connect the dashboard to the documented core routes, map and load the seed data, and implement the uAgents chat protocol using the same route and response types. Do not infer or change the shared contract from the dashboard or agent branch; coordinate proposed changes through the contract owner.

## Safety and demo data

Use synthetic data only. Medication wording must come from staff-approved templates, and each blocker must be verified by staff before it counts as cleared. FinchNode is read-only; surgery schedules and requirement lists are app-owned data.
