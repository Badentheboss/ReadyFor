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

Set a private, stable `UAGENT_SEED` in `agent/.env`. Set `AGENT_SERVICE_TOKEN` to the same private token configured on the core (at least 32 characters; generate it locally with `openssl rand -hex 32`). Startup rejects a missing or short token. `READYFOR_CORE_URL` in the example points to `http://localhost:8787`, where the core runs after `bun start`. Never commit or paste the seed, token, or account credentials.

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

## Staff authorization

Every core request carries the service token and the actual ASI:One chat sender in `X-ReadyFor-Sender`. Link that address to a staff entry in the core's `STAFF_ALLOWLIST` fourth field as described in `docs/contract.md` section 9. Sender identity is passed separately for every request, including confirmed writes, so concurrent conversations cannot borrow another person's permissions.

To obtain your sender address, run the agent, open **Chat with Agent** from your ASI:One session, and send a greeting. The agent logs `ReadyFor chat sender: <address>` for incoming messages without logging their contents or credentials. Use that incoming sender address, not the ReadyFor agent's own address. Confirm the observed message came from the staff member's session before adding it to the allowlist.

A service token alone grants no access: unlinked senders receive 403 on reads and writes. The linked person's role controls actions; coordinators cannot verify lab, medication, or health requirements. The agent reports the core's denial and does not retry it. `CONFIRM` approves a staged action but never grants permissions. The core supplies the audit actor rather than accepting an actor label from the agent.

Run the local authentication tests without connecting to Agentverse:

```sh
python -m unittest discover -s tests -v
```
