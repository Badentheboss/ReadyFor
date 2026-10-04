"""Patient selection and confirmation lifetime regressions, entirely offline."""
import unittest
from unittest.mock import AsyncMock

from readyfor_agent.client import ReadyForCoreClient
from readyfor_agent.__main__ import coordinator_reply, find_surgery


def surgery(identifier, name):
    return {"surgery": {"id": identifier}, "patient": {"displayName": name}}


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.surgeries = [surgery("sur_a", "Morgan Rivera"), surgery("sur_b", "Morgan Ellis")]

    def test_shared_first_name_is_ambiguous(self):
        self.assertIsNone(find_surgery(self.surgeries, "task for Morgan"))

    def test_full_name_wins_regardless_of_list_order(self):
        for items in (self.surgeries, list(reversed(self.surgeries))):
            self.assertEqual(find_surgery(items, "verify Morgan Ellis")['surgery']['id'], "sur_b")

    def test_surgery_id_wins_over_first_name(self):
        self.assertEqual(find_surgery(self.surgeries, "Morgan sur_b")['surgery']['id'], "sur_b")

    def test_multiple_explicit_matches_remain_ambiguous(self):
        self.assertIsNone(find_surgery(self.surgeries, "Morgan Rivera and Morgan Ellis"))

    def test_substrings_and_empty_ids_do_not_match(self):
        self.assertIsNone(find_surgery(self.surgeries, "Morganite"))
        self.assertIsNone(find_surgery([surgery('', 'Morgan Rivera')], 'unrelated'))


class ConfirmationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.core = AsyncMock(spec=ReadyForCoreClient)
        self.core.is_configured = True
        self.core.list_surgeries.return_value = [surgery('sur_a', 'Morgan Rivera'), surgery('sur_b', 'Morgan Ellis')]
        self.core.surgery_detail.return_value = {'requirements': [{'id': 'req_a', 'title': 'Transport', 'status': 'open'}]}
        self.core.create_task.return_value = {'task': {'title': 'Call clinic'}}
        self.pending = {}
        self.now = 1000

    async def reply(self, text):
        return await coordinator_reply(self.core, 'sender', text, self.pending, clock=lambda: self.now)

    async def test_ambiguous_request_lists_full_names_without_writes(self):
        self.assertEqual(await self.reply('assign task for Morgan'), 'Which patient did you mean: Morgan Rivera or Morgan Ellis?')
        self.assertEqual(self.pending, {})
        self.core.surgery_detail.assert_not_awaited()
        self.core.create_task.assert_not_awaited()

    async def test_confirm_before_expiry_applies(self):
        await self.reply('assign task: Call clinic for Morgan Ellis')
        self.assertEqual(self.pending['sender']['created_at'], 1000)
        self.now += 599
        await self.reply('confirm')
        self.core.create_task.assert_awaited_once()
        self.assertEqual(self.pending, {})

    async def test_all_pending_action_types_expire_at_ten_minutes(self):
        for request in ('assign task: Call clinic for Morgan Ellis', 'verify Transport for Morgan Ellis', "take Morgan Ellis alert"):
            with self.subTest(request=request):
                self.core.list_alerts.return_value = [{'id': 'alr_a', 'patientName': 'Morgan Ellis', 'status': 'open'}]
                await self.reply(request)
                self.now += 600
                self.assertIn('expired', await self.reply('confirm'))
                self.assertEqual(self.pending, {})
        self.core.create_task.assert_not_awaited()
        self.core.verify_requirement.assert_not_awaited()
        self.core.acknowledge_alert.assert_not_awaited()

    async def test_expired_request_does_not_block_a_new_request(self):
        await self.reply('assign task: Call clinic for Morgan Ellis')
        self.now += 601
        await self.reply('assign task: Review transport for Morgan Rivera')
        self.assertEqual(self.pending['sender']['patient'], 'Morgan Rivera')
        self.assertEqual(self.pending['sender']['created_at'], self.now)
