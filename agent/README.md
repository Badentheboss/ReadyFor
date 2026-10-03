# Fetch.ai coordinator agent

The agent will expose the coordinator chat flow using uAgents and call the ReadyFor core over HTTP. Its request/response types and route paths are intentionally pending `docs/contract.md`; keep all core integration behind one client module and do not guess endpoints.

Once the contract lands, add the chat protocol, map coordinator questions to its documented routes, and configure the core base URL through the environment. Store Agentverse credentials in the local ignored `.env`, never in source or fixtures.
