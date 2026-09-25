// orders web service — public boundary of the browser fixture project. GET /
// serves the page a user drives (name box + Create button; the page calls
// POST /orders and shows the result), POST /orders persists an order under
// DATA_DIR and answers 201, GET /orders/:id reads it back, GET /health answers
// 200. build.mjs compiles this file into dist/server.js; the public service is
// that BUILD ARTIFACT, never this source.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

interface Order { id: number; name: string; }
const dataDir = process.env.DATA_DIR ?? "data";
const file = join(dataDir, "orders.json");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
// interlinked-ignore: ubs_hardcoded_localhost — a test fixture service that must only ever bind loopback
const host = "127.0.0.1";
// A supervised stop is SIGTERM; exiting normally lets Node flush NODE_V8_COVERAGE (runtime observations, plan §7.4).
process.on("SIGTERM", () => process.exit(0));
const PAGE =`<!doctype html><html><head><meta charset="utf-8"><title>Orders</title></head><body>
<h1>Orders</h1>
<label>Name <input id="name" type="text"></label>
<button id="create" type="button">Create</button>
<p id="result"></p>
<script>
document.getElementById("create").addEventListener("click", async () => {
    const name = document.getElementById("name").value;
    const response = await fetch("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const body = await response.json();
    document.getElementById("result").textContent = response.status === 201 ? "created " + body.order.id + ": " + body.order.name : "error: " + body.error;
});
</script>
</body></html>`;

function load(): Order[] {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Order[]) : [];
}
function save(orders: Order[]): void {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(orders));
    renameSync(`${file}.tmp`, file);
}
function send(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}
function readBody(request: IncomingMessage): Promise<string> {
    return new Promise(resolve => { let text = ""; request.on("data", chunk => { text += String(chunk); }); request.on("end", () => resolve(text)); });
}
async function create(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let name: unknown;
    try { name = (JSON.parse(await readBody(request)) as { name?: unknown }).name; } catch { name = undefined; }
    if (typeof name !== "string" || !name) { send(response, 400, { error: "name required" }); return; }
    const orders = load();
    const order: Order = { id: orders.length + 1, name };
    orders.push(order);
    save(orders);
    send(response, 201, { ok: true, order });
}
createServer((request, response) => {
    const url = request.url ?? "/";
    if (request.method === "GET" && url === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(PAGE); return; }
    if (request.method === "GET" && url === "/health") { send(response, 200, { ok: true }); return; }
    if (request.method === "POST" && url === "/orders") { void create(request, response); return; }
    const match = /^\/orders\/(\d+)$/.exec(url);
    if (request.method === "GET" && match) {
        const order = load().find(row => row.id === Number(match[1]));
        if (order) send(response, 200, order); else send(response, 404, { error: "not found" });
        return;
    }
    send(response, 404, { error: "no such route" });
}).listen(port, host);
