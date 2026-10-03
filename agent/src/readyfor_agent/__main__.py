"""Executable uAgents Chat Protocol entry point."""

from datetime import datetime, timezone
from uuid import uuid4

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


def build_agent() -> Agent:
    settings = load_settings()
    core = ReadyForCoreClient(settings.core_url, settings.core_timeout_seconds)
    coordinator_chat = Protocol(spec=chat_protocol_spec)
    agent = Agent(
        name=settings.name,
        seed=settings.seed,
        port=settings.port,
        endpoint=[f"http://{settings.host}:{settings.port}/submit"],
        mailbox=True,
        publish_agent_details=True,
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
        # Extracting text here gives the integration point a bounded, explicit
        # input, without making assumptions about core operations before contract.
        text = "\n".join(
            item.text.strip()
            for item in message.content
            if isinstance(item, TextContent) and item.text.strip()
        )

        if not text:
            reply = "Please send a text message so I can help with your readiness check."
        elif not core.is_configured:
            reply = (
                "The ReadyFor coordinator is not connected to its service yet. "
                "Please try again after setup is complete."
            )
        else:
            # A URL alone does not define the API. Don't issue speculative calls;
            # the documented coordinator operations are added once the contract lands.
            reply = "The coordinator service is available, but its chat actions are not configured yet."

        await ctx.send(
            sender,
            ChatMessage(
                timestamp=datetime.now(timezone.utc),
                msg_id=uuid4(),
                content=[
                    TextContent(type="text", text=reply),
                    EndSessionContent(type="end-session"),
                ],
            ),
        )

    @coordinator_chat.on_message(ChatAcknowledgement)
    async def handle_acknowledgement(
        ctx: Context, sender: str, message: ChatAcknowledgement
    ) -> None:
        ctx.logger.debug("Chat acknowledgement from %s for %s", sender, message.acknowledged_msg_id)

    agent.include(coordinator_chat, publish_manifest=True)
    return agent


def main() -> None:
    build_agent().run()


if __name__ == "__main__":
    main()
