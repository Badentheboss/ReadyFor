"""Fetch.ai chat agent for documented ReadyFor coordinator operations."""

from datetime import datetime, timezone
import re
from uuid import uuid4

from httpx import HTTPError
from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    TextContent,
    chat_protocol_spec,
)

from readyfor_agent.client import ReadyForCoreClient
from readyfor_agent.config import load_settings

OWNER_TERMS = {"coordinator": "coordinator", "nurse": "nurse", "surgeon": "surgeon"}


def message_text(message: ChatMessage) -> str:
    return "\n".join(
        item.text.strip()
        for item in message.content
        if isinstance(item, TextContent) and item.text.strip()
    )


def surgery_name(item: dict) -> str:
    return str(item.get("patient", {}).get("displayName", "Unknown patient"))


def surgery_id(item: dict) -> str:
    return str(item.get("surgery", {}).get("id", ""))


def find_surgery(surgeries: list[dict], text: str) -> dict | None:
    lowered = text.casefold()
    for surgery in surgeries:
        patient = surgery.get("patient", {})
        if surgery_id(surgery).casefold() in lowered or surgery_name(surgery).casefold() in lowered:
            return surgery
        display = surgery_name(surgery)
        if display.casefold().split()[0] in lowered:
            return surgery
        if patient.get("finchnodeSubject") and str(patient["finchnodeSubject"]).casefold() in lowered:
            return surgery
    return None


def at_risk_summary(surgeries: list[dict]) -> str:
    selected = []
    for item in surgeries:
        readiness = item.get("readiness", {})
        days = readiness.get("daysUntil", 10_000)
        if readiness.get("level") == "at_risk" and days <= 7:
            selected.append(f"• {surgery_name(item)} — {readiness.get('headline', 'At risk')}")
    if not selected:
        return "No surgeries are currently at risk within the next seven days."
    return "Surgeries at risk within seven days:\n" + "\n".join(selected)


def owner_from_text(text: str) -> str:
    lowered = text.casefold()
    for keyword, owner in OWNER_TERMS.items():
        if re.search(rf"\b{keyword}\b", lowered):
            return owner
    return "coordinator"


def task_title(text: str, patient: str) -> str:
    match = re.search(r"\btask\s*:\s*(.{4,120})", text, re.I)
    if match:
        title = match.group(1).strip(" .")
    else:
        match = re.search(r"\b(?:call|contact|obtain|schedule|arrange|check|review|follow up)\b.{2,100}", text, re.I)
        title = match.group(0).strip(" .") if match else f"Coordinator follow-up with {patient}"
    title = re.sub(r"\s+(?:to|for)\s+(?:the\s+)?(?:coordinator|nurse|surgeon)\.?$", "", title, flags=re.I)
    title = re.sub(r"\s+(?:for|about)\s+(?:harriet|morgan|jordan|the patient)\b.*$", "", title, flags=re.I)
    if len(title) < 4 or len(title) > 120:
        return f"Coordinator follow-up with {patient}"
    return title[0].upper() + title[1:]


def requirement_match(requirements: list[dict], text: str) -> dict | None:
    eligible = [r for r in requirements if r.get("status") in {"open", "evidence_received"}]
    if not eligible:
        return None
    lowered = text.casefold()
    scored = []
    for requirement in eligible:
        terms = {requirement.get("key", ""), requirement.get("title", "")}
        terms |= set(re.findall(r"[a-z0-9]+", str(requirement.get("title", "")).casefold()))
        score = sum(1 for term in terms if term and term.casefold() in lowered and len(term) > 2)
        scored.append((score, requirement))
    best_score, best = max(scored, key=lambda pair: pair[0])
    return best if best_score or len(eligible) == 1 else None


async def coordinator_reply(
    core: ReadyForCoreClient,
    sender: str,
    text: str,
    pending: dict[str, dict],
) -> str:
    if not core.is_configured:
        return "The ReadyFor service URL is not set. Configure READYFOR_CORE_URL and try again."

    lowered = text.casefold().strip()
    queued = pending.get(sender)
    if queued:
        if lowered in {"confirm", "yes", "confirm it", "do it", "approve"}:
            pending.pop(sender, None)
            if queued["action"] == "verify":
                await core.verify_requirement(queued["requirement_id"])
                return f"Verified “{queued['title']}” for {queued['patient']}. The core recalculated readiness."
            result = await core.create_task(
                queued["surgery_id"], queued["title"], queued["owner"], queued["detail"]
            )
            task = result.get("task", {})
            return f"Assigned “{task.get('title', queued['title'])}” to {queued['owner']}."
        if lowered in {"cancel", "no", "never mind"}:
            pending.pop(sender, None)
            return "Okay, I did not change anything."
        return "I have a change waiting for confirmation. Reply CONFIRM to apply it, or CANCEL to discard it."

    surgeries = await core.list_surgeries()
    if any(phrase in lowered for phrase in ("at risk", "risk this week", "what's urgent", "what is urgent")):
        return at_risk_summary(surgeries)

    selected = find_surgery(surgeries, text)
    if any(word in lowered for word in ("blocking", "blocker", "brief", "readiness", "what is happening")):
        if not selected:
            return "Which patient or surgery should I check? Try a patient name, such as Harriet."
        return await core.surgery_brief(surgery_id(selected))

    if any(word in lowered for word in ("verify", "confirm requirement")):
        if not selected:
            return "Which patient's requirement should I verify? Include the patient's name."
        detail = await core.surgery_detail(surgery_id(selected))
        requirement = requirement_match(detail.get("requirements", []), text)
        if not requirement:
            return "I couldn't identify one open requirement from that message. Include a requirement name, such as ‘verify pre-op blood work for Harriet’."
        pending[sender] = {
            "action": "verify",
            "requirement_id": requirement["id"],
            "title": requirement["title"],
            "patient": surgery_name(selected),
        }
        return f"I found “{requirement['title']}” for {surgery_name(selected)} (currently {requirement['status']}). Reply CONFIRM to record staff verification, or CANCEL."

    if "task" in lowered or lowered.startswith("assign "):
        if not selected:
            return "Which surgery is this follow-up for? Include the patient's name."
        owner = owner_from_text(text)
        title = task_title(text, surgery_name(selected))
        pending[sender] = {
            "action": "task",
            "surgery_id": surgery_id(selected),
            "patient": surgery_name(selected),
            "title": title,
            "owner": owner,
            "detail": text,
        }
        return f"I can assign “{title}” to the {owner} for {surgery_name(selected)}. Reply CONFIRM to create the task, or CANCEL."

    if selected:
        return await core.surgery_brief(surgery_id(selected))
    return "Ask what is at risk this week, what is blocking a patient's surgery, or ask me to assign a follow-up."


def build_agent() -> Agent:
    settings = load_settings()
    core = ReadyForCoreClient(settings.core_url, settings.core_timeout_seconds)
    pending: dict[str, dict] = {}
    coordinator_chat = Protocol(spec=chat_protocol_spec)
    agent = Agent(
        name=settings.name,
        seed=settings.seed,
        port=settings.port,
        mailbox=True,
        publish_agent_details=True,
        readme_path="README.md",
    )

    @coordinator_chat.on_message(ChatMessage)
    async def handle_chat(ctx: Context, sender: str, message: ChatMessage) -> None:
        await ctx.send(
            sender,
            ChatAcknowledgement(
                timestamp=datetime.now(timezone.utc),
                acknowledged_msg_id=message.msg_id,
            ),
        )
        text = message_text(message)
        try:
            reply = await coordinator_reply(core, sender, text, pending) if text else "Please send a text message so I can help with your readiness check."
        except (HTTPError, ValueError, RuntimeError) as error:
            ctx.logger.warning("ReadyFor core request failed: %s", error)
            reply = f"I couldn't complete that request: {error}"

        await ctx.send(
            sender,
            ChatMessage(
                timestamp=datetime.now(timezone.utc),
                msg_id=uuid4(),
                content=[TextContent(type="text", text=reply), EndSessionContent(type="end-session")],
            ),
        )

    @coordinator_chat.on_message(ChatAcknowledgement)
    async def handle_acknowledgement(ctx: Context, sender: str, message: ChatAcknowledgement) -> None:
        ctx.logger.debug("Chat acknowledgement from %s for %s", sender, message.acknowledged_msg_id)

    agent.include(coordinator_chat, publish_manifest=True)
    return agent


def main() -> None:
    build_agent().run()


if __name__ == "__main__":
    main()
