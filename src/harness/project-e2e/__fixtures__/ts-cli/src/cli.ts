// orders CLI — public executable of the fixture project, written in TypeScript.
// `add <name>` persists an order to data/orders.json and prints it as JSON.
// build.mjs compiles this file (type stripping) into dist/cli.js; the
// public executable is that BUILD ARTIFACT, never this source.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

interface Order { id: number; name: string; }
type Command = "add" | "list";

function load(): Order[] {
    return existsSync("data/orders.json") ? (JSON.parse(readFileSync("data/orders.json", "utf8")) as Order[]) : [];
}
function add(name: string): Order {
    const orders = load();
    const order: Order = { id: orders.length + 1, name };
    orders.push(order);
    mkdirSync("data", { recursive: true });
    writeFileSync("data/orders.json", JSON.stringify(orders));
    return order;
}
const [command, name] = process.argv.slice(2) as [Command | undefined, string | undefined];
if (command === "add" && name) {
    console.log(JSON.stringify({ ok: true, order: add(name) }));
} else if (command === "list") {
    console.log(JSON.stringify(load()));
} else {
    console.error("usage: cli add <name> | list");
    process.exitCode = 2;
}
