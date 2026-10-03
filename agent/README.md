# ReadyFor Fetch.ai coordinator agent

This is the Fetch.ai/uAgents entry point for coordinator chat. It uses Fetch.ai's published Chat Protocol so Agentverse/ASI:One clients can discover and message it. It is deliberately fail-closed: until the ReadyFor core contract is present, it acknowledges a message and says the service is not connected. It does not infer medical instructions, provide medication advice, or use an LLM to make clinical decisions.

## Run locally

Requires Python 3.11 or newer.

```sh
cd agent
python -m venv .venv
source .venv/bin/activate
python -m pip install -e .
cp .env.example .env
```

Set `UAGENT_SEED` in `agent/.env` to a private, stable seed phrase. Never commit it or paste it into chat. To use the Agentverse mailbox, enable the mailbox for the agent in Agentverse and follow its generated connection instructions. The Agentverse token is not embedded in source. Optional values and their defaults are documented in `.env.example`.

Start the local agent:

```sh
python -m readyfor_agent
```

By default it listens on `127.0.0.1:8000`. It prints its agent address and inspector link at startup. The address can be used to test the agent locally; a reachable deployment is required for remote Agentverse messaging.

## Core integration status

`client.py` is the only place intended to make ReadyFor core HTTP requests. It intentionally defines no routes or payloads. Set `READYFOR_CORE_URL` after the core contract is available, then implement the coordinator operations there from `docs/contract.md`. Until that work is done, requests raise `CoreClientNotConfigured` (or the corresponding explicit unavailable error); the chat handler returns a safe unavailable message.

When integrating the contract, preserve the boundary: validate chat text and map supported coordinator actions to documented core routes, pass through structured results, and keep clinical readiness decisions in the rules-based core service. Do not send credentials or private health details to model providers.
