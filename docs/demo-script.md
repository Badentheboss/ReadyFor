# ReadyFor demo script (3 minutes)

Synthetic data only. One presenter at the laptop, one phone playing the patient Harriet (and, optionally, the on-call nurse).

## Before you present (10 minutes ahead)

- [ ] `.env` has `DATABASE_URL`, `GEMINI_API_KEY`, Neon Auth values, `DEMO_PATIENT_PHONE`, and `ONCALL_PRIMARY_PHONE` (can be the same phone). Set `ESCALATION_MINUTES=1`.
- [ ] Both phone numbers are **Users** on the Photon project, and each has texted the Photon line once.
- [ ] Start, in this order and in separate terminals: `bun start`, `bun run dashboard`, `bun run imessage`.
- [ ] `curl localhost:8787/health` shows `"database":"neon"`, a `gemini:` model, `"auth":"neon"`.
- [ ] Sign in to http://localhost:4173 as an **admin** staff account; click **Reset demo**; do **not** run Harriet's record check yet.
- [ ] Open `db/seed/assets/sample-lab-report.png` on a second screen so the phone can photograph it.
- [ ] Optional: start the Fetch.ai agent and have ASI:One open with your linked account.
- [ ] Backup: if anything live fails, run `DASHBOARD_PROVIDER=mock bun run dashboard` for the offline walkthrough.

## Script

**0:00 – The problem (20 s).** "Surgeries get cancelled on the day for preventable reasons: blood work that's too old, a blood thinner nobody paused, no ride home. Coordinators find out too late because the facts are spread across the record, the patient's phone, and the schedule."

**0:20 – The board (20 s).** Show the 14-day runway. "Each dot is a surgery, coloured by readiness. Harriet is in five days and hasn't been checked." Point out that schedule status (the calendar chips) is separate from readiness.

**0:40 – Record check (30 s).** Open Harriet, click **Run record check**. "ReadyFor reads her synthetic FinchNode record and classifies every medication through the NLM's RxClass. No AI decides this; these are documented rules." Point at the **FINCHNODE** and **RXCLASS** source tags on *Blood thinner plan* and *Pre-op blood work*. Her phone buzzes with the first text.

**1:10 – The patient replies (40 s).** On the phone, photograph the sample lab report and send it with "did these at another clinic last week". "Gemini reads the photo and the message." In the dashboard, *Pre-op blood work* moves to **Needs your review** with checks: date within 30 days, name matches, all four results present. Click **Verify evidence**. The blocker count drops.

**1:50 – Medication plan (20 s).** On *Blood thinner plan*, click **Approve & send**, type a staff instruction. "The AI never writes medication advice; it picks a staff-approved template and a person fills in the instruction." The outreach strip shows *Plan approved → Message delivered → Awaiting acknowledgement*.

**2:10 – Urgent escalation (35 s).** From the phone: "I've had chest pain since this morning." The urgent queue appears at the top: *Paged Priya Shah (nurse) · goes to Dr. Avery Demo at … if unanswered*. "The patient was told it went to the team as urgent, not promised a call." Reply **ACK** from the on-call phone (or click **I'll take it**). The card shows *Accepted by nurse: Priya Shah*, and the patient gets "Priya Shah from your care team has your message."

**2:45 – Close (15 s).** "Everything is logged in Activity with who did what. Staff sign in with Neon Auth and only see what their role allows. A coordinator can do the same from ASI:One through our Fetch.ai agent. ReadyFor: catch it days ahead, not on the morning of surgery."

## If something goes wrong

| Symptom | Fix |
| --- | --- |
| Dashboard says sign-in is being configured | The core wasn't running when the dashboard started. Restart the dashboard. |
| A text card says *Delivery failed: Target not allowed* | That number isn't a Photon user or hasn't texted the line. Fix in Photon, then **Retry send**. |
| Replies are all "passed to your care team" | Gemini is unreachable; the core log says so. The fallback models usually recover; otherwise continue, everything else still works. |
| Photo didn't produce an evidence card | Gemini was busy. Send it again, or use **Send sample lab report** in the Conversation tab. |
