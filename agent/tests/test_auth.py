"""Offline security-boundary tests; no credentials or Agentverse connection needed."""

import asyncio
import json
import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from readyfor_agent.client import ReadyForCoreClient, ReadyForCoreError
from readyfor_agent.config import load_settings
from readyfor_agent.__main__ import coordinator_reply

TOKEN = "a" * 64  # Synthetic test credential, never a live token.
SENDER = "agent1test-staff"
SURGERY = {
    "surgery": {"id": "surgery-test"},
    "patient": {"displayName": "Harriet Test"},
    "readiness": {"level": "at_risk", "daysUntil": 2, "headline": "Pending lab"},
}


class ConfigurationTests(unittest.TestCase):
    def test_client_rejects_missing_short_or_invalid_token(self):
        for token in (None, "", "short", "a" * 31, "a" * 32 + "\n", " " * 64):
            with self.subTest(token_length=len(token) if token else 0):
                with self.assertRaisesRegex(ValueError, "AGENT_SERVICE_TOKEN"):
                    ReadyForCoreClient("http://core.test", token)

    def test_settings_reject_missing_or_short_token_without_reading_env_file(self):
        for token in ("", "a" * 31):
            with patch("readyfor_agent.config.load_dotenv"), patch.dict(
                os.environ, {"UAGENT_SEED": "synthetic-private-test-seed", "AGENT_SERVICE_TOKEN": token}, clear=True
            ):
                with self.assertRaisesRegex(ValueError, "AGENT_SERVICE_TOKEN"):
                    load_settings()

    def test_settings_load_token_without_exposing_it_in_repr(self):
        with patch("readyfor_agent.config.load_dotenv"), patch.dict(
            os.environ, {"UAGENT_SEED": "synthetic-private-test-seed", "AGENT_SERVICE_TOKEN": TOKEN}, clear=True
        ):
            settings = load_settings()
        self.assertEqual(settings.service_token, TOKEN)
        self.assertNotIn(TOKEN, repr(settings))


class ClientTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.core = ReadyForCoreClient("http://core.test", TOKEN)
        self.requests = []
        self.original_async_client = httpx.AsyncClient

    def transport_patch(self, handler):
        transport = httpx.MockTransport(handler)
        return patch(
            "readyfor_agent.client.httpx.AsyncClient",
            side_effect=lambda **kwargs: self.original_async_client(transport=transport, **kwargs),
        )

    async def test_all_methods_send_exact_auth_and_sender_headers_without_actor_forging(self):
        async def handler(request):
            self.requests.append(request)
            if request.url.path == "/surgeries":
                payload = {"surgeries": [SURGERY]}
            elif request.url.path.endswith("/brief"):
                payload = {"text": "Test brief"}
            else:
                payload = {"task": {"title": "Call clinic"}}
            return httpx.Response(200, json=payload)

        with self.transport_patch(handler):
            await self.core.list_surgeries(sender=SENDER)
            await self.core.surgery_brief("surgery-test", sender=SENDER)
            await self.core.surgery_detail("surgery-test", sender=SENDER)
            await self.core.create_task("surgery-test", "Call clinic", "nurse", "Follow up", sender=SENDER)
            await self.core.verify_requirement("requirement-test", sender=SENDER)
        self.assertEqual([(r.method, r.url.path) for r in self.requests], [
            ("GET", "/surgeries"), ("GET", "/surgeries/surgery-test/brief"),
            ("GET", "/surgeries/surgery-test"), ("POST", "/tasks"),
            ("POST", "/requirements/requirement-test/actions"),
        ])
        for request in self.requests:
            self.assertEqual(request.headers["authorization"], f"Bearer {TOKEN}")
            self.assertEqual(request.headers["x-readyfor-sender"], SENDER)
            if request.content:
                self.assertNotIn("actor", json.loads(request.content))
        self.assertEqual(json.loads(self.requests[-1].content), {"action": "verify"})

    async def test_missing_or_unsafe_sender_never_makes_a_request(self):
        with patch("readyfor_agent.client.httpx.AsyncClient") as client:
            for sender in (None, "", " ", "agent\nInjected", "agent sender"):
                with self.assertRaisesRegex(ValueError, "sender address"):
                    await self.core.list_surgeries(sender=sender)
            client.assert_not_called()
        with self.assertRaises(TypeError):
            await self.core.list_surgeries()

    async def test_concurrent_chats_keep_their_request_local_sender(self):
        entered = asyncio.Event()
        count = 0

        async def handler(request):
            nonlocal count
            count += 1
            self.requests.append(request)
            if count == 2:
                entered.set()
            await asyncio.wait_for(entered.wait(), timeout=2)
            return httpx.Response(200, json={"text": request.headers["x-readyfor-sender"]})

        with self.transport_patch(handler):
            replies = await asyncio.gather(
                self.core.surgery_brief("first", sender="agent1first"),
                self.core.surgery_brief("second", sender="agent1second"),
            )
        self.assertEqual(replies, ["agent1first", "agent1second"])
        self.assertEqual({r.url.path: r.headers["x-readyfor-sender"] for r in self.requests}, {
            "/surgeries/first/brief": "agent1first", "/surgeries/second/brief": "agent1second",
        })

    async def test_forbidden_surfaces_core_message_and_is_not_retried(self):
        def handler(request):
            self.requests.append(request)
            return httpx.Response(403, json={"error": {"code": "FORBIDDEN", "message": "Sender is not linked to staff."}})

        with self.transport_patch(handler):
            with self.assertRaises(ReadyForCoreError) as caught:
                await self.core.list_surgeries(sender=SENDER)
        self.assertEqual(caught.exception.status_code, 403)
        self.assertIn("Sender is not linked to staff.", str(caught.exception))
        self.assertIn("403", str(caught.exception))
        self.assertEqual(len(self.requests), 1)


class ChatSenderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.core = AsyncMock(spec=ReadyForCoreClient)
        self.core.is_configured = True
        self.core.list_surgeries.return_value = [SURGERY]
        self.core.surgery_brief.return_value = "Test brief"
        self.core.surgery_detail.return_value = {"requirements": [{
            "id": "lab-test", "key": "blood_work", "title": "Pre-op blood work", "status": "evidence_received",
        }]}
        self.core.create_task.return_value = {"task": {"title": "Call clinic"}}
        self.pending = {}

    async def test_reads_and_requirement_confirmation_forward_actual_chat_sender(self):
        await coordinator_reply(self.core, SENDER, "What's blocking Harriet?", self.pending)
        self.core.list_surgeries.assert_awaited_with(sender=SENDER)
        self.core.surgery_brief.assert_awaited_with("surgery-test", sender=SENDER)
        await coordinator_reply(self.core, SENDER, "Verify pre-op blood work for Harriet", self.pending)
        self.core.surgery_detail.assert_awaited_with("surgery-test", sender=SENDER)
        await coordinator_reply(self.core, "agent1other", "confirm", self.pending)
        self.core.verify_requirement.assert_not_awaited()
        await coordinator_reply(self.core, SENDER, "confirm", self.pending)
        self.core.verify_requirement.assert_awaited_once_with("lab-test", sender=SENDER)

    async def test_task_confirmation_uses_sender_and_denial_is_not_retried(self):
        await coordinator_reply(self.core, SENDER, "Assign task: Call clinic for Harriet to nurse", self.pending)
        self.core.create_task.side_effect = ReadyForCoreError(403, "Role cannot do this action.")
        with self.assertRaisesRegex(ReadyForCoreError, "Role cannot do this action"):
            await coordinator_reply(self.core, SENDER, "confirm", self.pending)
        self.assertEqual(self.core.create_task.await_count, 1)
        self.assertEqual(self.core.create_task.await_args.kwargs, {"sender": SENDER})
        self.assertNotIn(SENDER, self.pending)


if __name__ == "__main__":
    unittest.main()
