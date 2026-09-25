# Orders CLI (Rust) requirements

R1. `orders_cli add <name>` persists the order so a later invocation can read it back.
R2. `orders_cli add <name>` prints the created order as JSON with `ok: true`.
R3. `orders_cli add` without a name fails with exit code 2 and writes nothing.
