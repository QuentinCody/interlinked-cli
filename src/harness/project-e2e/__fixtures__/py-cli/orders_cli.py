"""orders CLI (Python) — public executable of the fixture project.

`add <name>` persists a receipt to data/orders.json and prints it as JSON.
Invalid input fails with exit 2 and must not write.
"""
import json
import os
import sys


def load():
    if os.path.exists("data/orders.json"):
        with open("data/orders.json", encoding="utf-8") as handle:
            return json.load(handle)
    return []


def add(name):
    orders = load()
    order = {"id": len(orders) + 1, "name": name}
    orders.append(order)
    os.makedirs("data", exist_ok=True)
    with open("data/orders.json", "w", encoding="utf-8") as handle:
        json.dump(orders, handle, separators=(",", ":"))
    return order


def main(argv):
    if len(argv) >= 2 and argv[0] == "add":
        print(json.dumps({"ok": True, "order": add(argv[1])}, separators=(",", ":")))
        return 0
    if argv[:1] == ["list"]:
        print(json.dumps(load(), separators=(",", ":")))
        return 0
    print("usage: orders_cli.py add <name> | list", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
