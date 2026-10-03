# Demo seed files

- `demo.json` is the core-owned source fixture. The core loads it on start when storage is empty and reloads it through the documented `POST /demo/reset` route.
- `fixtures.json` is a separate Codex-owned fallback for the dashboard's `DASHBOARD_PROVIDER=mock` mode. It does not write to the core or Neon.
- `assets/sample-lab-report.svg` and `.png` are synthetic lab report examples for the demo. The marked report is not real patient data.

`bun run seed:check` validates only the fallback dashboard fixture and medication placeholder. It does not connect to or change a database. The core's reset route clears and reseeds its configured database, so use it only with the hackathon demo database.
