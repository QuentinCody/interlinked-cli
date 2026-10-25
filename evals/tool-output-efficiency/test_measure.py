import unittest
from measure import later_use, repeat_kind, choose_winner
class MeasurementTests(unittest.TestCase):
    def test_later_use_three_paths(self):
        from tokens import shingles
        future = set(shingles("The authentication failure must never trigger another automatic retry attempt."))
        self.assertTrue(later_use("The authentication failure must never trigger another automatic retry attempt.", set(), future, set(), set()))
        self.assertTrue(later_use("src/a.ts:12", set(), set(), {"src/a.ts"}, set()))
        self.assertTrue(later_use("$ npm test", set(), set(), set(), {"npm test"}))
        self.assertFalse(later_use("unrelated information", set(), future, set(), set()))
    def test_compaction_and_actor_are_separate(self):
        self.assertEqual(repeat_kind((1,4), 1, 5, False), "same_epoch")
        self.assertEqual(repeat_kind((0,4), 1, 5, True), "across_compaction")
        self.assertEqual(repeat_kind(None, 1, 5, True), "between_agents")
        self.assertEqual(repeat_kind((1,5), 1, 5, False), "within_output")
    def test_fixed_selection(self):
        self.assertEqual(choose_winner({"search":{"unused_tokens":4},"file_reads":{"unused_tokens":9}}), "file_reads")

