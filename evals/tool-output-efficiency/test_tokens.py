import importlib.util, pathlib, types, unittest
from unittest.mock import patch
from tokens import blocks, normalized_line, paths, text_of
class TokenTests(unittest.TestCase):
    def test_import_is_offline_and_encoding_is_lazy(self):
        calls = []
        fake = types.SimpleNamespace(get_encoding=lambda name: calls.append(name) or types.SimpleNamespace(encode_ordinary=lambda text: list(text)))
        spec = importlib.util.spec_from_file_location("tokens_offline_test", pathlib.Path(__file__).with_name("tokens.py"))
        module = importlib.util.module_from_spec(spec)
        with patch.dict("sys.modules", {"tiktoken": fake}):
            spec.loader.exec_module(module)
            self.assertEqual(calls, [])
            self.assertEqual(module.tokens("abc"), 3)
            self.assertEqual(module.tokens("def"), 3)
            self.assertEqual(calls, ["o200k_base"])
    def test_lossless_blocks(self):
        text = "a"*5001 + "\r\n" + "😀x\n"*40
        parts = list(blocks(text))
        self.assertEqual("".join(x[1] for x in parts), text)
        self.assertTrue(all(text[o:o+len(s)] == s and len(s)<=2000 for o,s in parts))
    def test_prefix_and_paths(self):
        self.assertEqual(normalized_line("  12→const value = 42;"), "const value = 42;")
        self.assertEqual(paths("src/foo.ts:4"), {"src/foo.ts"})
        self.assertEqual(text_of({"type":"input_image","data":"secret"}), "")

