import unittest
from classify import category, edited_paths
class ClassificationTests(unittest.TestCase):
    def test_command_not_search_argument(self):
        self.assertEqual(category("Bash", {"command":"rg 'vitest' src"}), "search")
        self.assertEqual(category("Bash", {"command":"npm test"}), "test_build")
    def test_mixed(self):
        self.assertEqual(category("exec", 'await tools.exec_command({cmd: "rg foo src"}); await tools.exec_command({cmd: "npm test"});'), "mixed")
    def test_edit_targets(self):
        self.assertEqual(edited_paths("apply_patch", "*** Update File: src/a.ts\n+hello"), {"src/a.ts"})

