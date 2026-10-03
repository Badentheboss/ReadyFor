# Synthetic demo fixtures

`fixtures.json` is the source for the dashboard's initial mock scenario. It contains invented patients and must not be loaded into a shared database until it has been mapped to `db/schema.sql` from the contract checkpoint.

Medication wording is deliberately a placeholder. Add only staff-approved text; the agent must never author medication instructions.
