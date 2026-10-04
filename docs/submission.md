# MHacks submission

## Devpost text

**ReadyFor: catch surgery blockers days ahead, not on the morning of surgery.**

### Inspiration
Elective surgeries get cancelled on the day for reasons that were knowable a week earlier: pre-op blood work that's too old, a blood thinner nobody paused, no ride home, a new symptom nobody heard about. The facts exist, but they're spread across the health record, the patient's phone, and the OR schedule, and a coordinator has to stitch them together by hand.

### What it does
ReadyFor gives a surgical coordinator one board for the next two weeks.
- **Record check.** It reads the patient's record (synthetic FinchNode data), classifies every active medication through the NLM's RxClass, and applies documented, procedure-specific rules to list what's missing, each with its source.
- **Patient conversation over iMessage.** Through Photon, it texts the patient for what only they can provide. Gemini reads their replies and photos of outside lab reports, checks the date, name and required results, and queues the evidence for staff to verify.
- **Staff stay in charge.** Nothing clinical is cleared by the AI. Medication messages come from staff-approved templates that a nurse or surgeon fills in. Every action is attributed to a signed-in person through Neon Auth, with role-based permissions (coordinators can't clear labs or medication).
- **Urgent escalation.** A reported symptom pages the on-call nurse by text; if nobody acknowledges within minutes, it escalates to the surgeon, then the next person. Staff accept with one tap or by replying ACK, and only then is the patient told who has it.
- **Honest delivery.** Every outbound message is queued, delivered or failed, with retry, and patient acknowledgement is tracked apart from readiness.
- **Schedule check.** A synthetic FHIR scheduling feed flags OR booking mismatches, unconfirmed pre-op visits and missing anesthesia consults, separately from patient readiness.
- **ASI:One.** A Fetch.ai agent lets an authorised coordinator ask "what's at risk this week?", see urgent alerts, and confirm tasks or verifications in chat.

### How we built it
Bun + Hono core with a documented API contract; Neon Postgres (with schema upgrades on start) and Neon Auth (JWT verification against the branch JWKS, staff allowlist, service tokens for the iMessage adapter and agent); Gemini for message classification and lab-report extraction, with retries and model fallback; Photon Spectrum for iMessage; FinchNode and RxClass for clinical data; a Fetch.ai uAgent on the Chat Protocol; and a dependency-free dashboard behind a same-origin gateway. 300+ automated tests.

### Challenges
Keeping the AI out of clinical decisions while still making it useful; making failures visible (a retired Gemini model, an iMessage line that could only text registered users) instead of silently degrading; and authorising an agent that anyone on ASI:One can message.

### What's next
Real FHIR scheduling and EHR integration, patient enrolment with a consent opt-in at booking, and per-clinic on-call rotas.

**All data in this project is synthetic.**

## Tracks and sponsors

| Track / prize | Where it is in the code |
| --- | --- |
| Theme: Actually Intelligent | Gemini reads messages and photos; rules and staff make the decisions (`core/src/llm/`, `core/src/conversation/`). |
| Neon | Postgres store (`core/src/store/`), Neon Auth sign-in and JWT verification (`core/src/auth/`, `dashboard/auth.js`). |
| Photon | iMessage adapter on Spectrum (`imessage/`), staff alert texts through the same outbox. |
| Fetch.ai (Agentverse / ASI:One) | `agent/`; register and submit the agent address separately. |
| Gemini API | `core/src/llm/gemini.ts`. |
| FinchNode | Synthetic patient records (`core/src/clinical/finchnode.ts`). |
| Judged by an LLM (opt-in) | This file, the README and `docs/contract.md` explain the design. |

Check each sponsor's own rules before submitting; some need a separate form (Fetch.ai) or a specific framework (Photon requires Spectrum, which we use).

## Checklist

**Code and tests**
- [ ] Merge `claude/outreach-status` into `main`.
- [ ] `bun test`, `bun run typecheck`, `bun run --cwd dashboard typecheck`, `bun run seed:check`, and `cd agent && .venv/bin/python -m pytest -q tests` all pass.
- [ ] Build both Docker images once (`docs/deploy.md`); the Docker daemon wasn't running when they were written, so they are untested.

**Live run (needs your accounts)**
- [ ] Sign in, refresh the page (session survives), sign out, sign back in. Check that your name and role show in the top bar.
- [ ] Sign in as a coordinator and confirm lab and medication actions are refused.
- [ ] Full phone run from `docs/demo-script.md`: record check, text, photo, verify, approve, urgent alert, ACK.
- [ ] Restart the core and confirm everything is still there (Neon persistence).
- [ ] Set `ONCALL_PRIMARY_PHONE`; both phones registered as Photon users and have texted the line.

**Fetch.ai**
- [ ] Fix Python's certificate trust if the mailbox connection fails (`/Applications/Python 3.x/Install Certificates.command`); don't disable verification.
- [ ] Connect the mailbox in Agentverse, link your ASI:One sender in `STAFF_ALLOWLIST`, and test: "what's at risk this week?", "any urgent alerts?", "take Harriet's alert" → CONFIRM.
- [ ] Submit the agent address through Fetch.ai's form.

**Deployment and submission**
- [ ] Deploy core and dashboard (`docs/deploy.md`); add the dashboard origin to Neon Auth trusted domains and `CORS_ORIGINS`.
- [ ] Register a .tech domain if you want the domain prize.
- [ ] Record a backup demo video of the full run.
- [ ] Devpost: paste the text above, add screenshots (board with runway, Harriet's checklist with sources, the urgent alert, the iMessage thread), the repo link, the video, and select every track above.
