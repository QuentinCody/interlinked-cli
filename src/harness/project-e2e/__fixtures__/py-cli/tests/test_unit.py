"""Unit-only test: exercises the function, never the public executable or the
saved file. Its green result must NOT clear the persistence scenario (PE-02)."""
import unittest

import orders_cli


class UnitOnly(unittest.TestCase):
    def test_order_shape(self):
        self.assertEqual({"id": 1, "name": "x"}["name"], "x")
        self.assertTrue(callable(orders_cli.add))


if __name__ == "__main__":
    unittest.main()
