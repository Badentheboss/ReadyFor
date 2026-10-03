# Synthetic demo fixtures

`fixtures.json` is the source for the dashboard's initial mock scenario. It contains invented patients and must not be loaded into a shared database until it has been mapped to `db/schema.sql` from the contract checkpoint.

Medication wording is deliberately a placeholder. Add only staff-approved text; the agent must never author medication instructions.

Run `bun run seed:check` to validate JSON structure, IDs, dates, and the medication-template placeholder. This is a local preflight only: it does not connect to Neon or execute SQL. A database loader should be added only after `docs/contract.md` and `db/schema.sql` define the agreed tables and fields.
