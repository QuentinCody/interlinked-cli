import unittest
from replay import head_tail_retained, summary_metrics
class ReplayTests(unittest.TestCase):
    def test_whole_block_retention(self):
        self.assertTrue(head_tail_retained(0,20,100,40))
        self.assertTrue(head_tail_retained(80,20,100,40))
        self.assertFalse(head_tail_retained(40,20,100,40))
    def test_unused_is_not_saved(self):
        result=summary_metrics([{"tokens":100,"used":True,"retained":False},{"tokens":50,"used":False,"retained":True}])
        self.assertEqual(result["used_token_recall"],0)
        self.assertEqual(result["omitted_used_tokens"],100)
