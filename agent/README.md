# ReadyFor Fetch.ai coordinator agent

This uAgents service uses Fetch.ai’s Chat Protocol for ASI:One coordinator requests and calls the ReadyFor routes in `docs/contract.md`. It can report surgeries at risk within seven days, return a patient’s brief, and stage task creation or requirement verification. The agent asks for a `CONFIRM` before it writes a task or marks a requirement verified; `CANCEL` discards the pending action. Core readiness rules remain the source of truth.

## Run locally

Requires Python 3.11 or newer:

```sh
cd agent
python -m venv .venv
source .venv/bin/activate
python -m pip install -e .
cp .env.example .env
```

Set a private, stable `UAGENT_SEED` in `agent/.env`. `READYFOR_CORE_URL` defaults to `http://localhost:8787`, where the core runs after `bun start`. Never commit or paste the seed or account credentials.

```sh
python -m readyfor_agent
```

The agent connects through the Agentverse mailbox, so it can receive ASI:One messages without exposing the agent’s local port. On first run, open the Inspector URL printed in the terminal and connect the local agent to a mailbox in Agentverse. The core URL must still be reachable from the agent process; set it to the deployed core URL when the core is on a different machine.

## Supported chat actions

- “What is at risk this week?” reads `GET /surgeries` and lists at-risk surgeries up to seven days away.
- “What is blocking Harriet’s surgery?” reads `GET /surgeries/:id/brief`.
- “Assign a task for Harriet to call her clinic to the nurse” stages `POST /tasks` and waits for `CONFIRM`.
- “Verify pre-op blood work for Harriet” looks up the requirement, states its current status, and waits for `CONFIRM` before calling `POST /requirements/:id/actions` with `verify`.

The agent relays the core’s documented summaries. It does not make readiness decisions or provide medication advice.
