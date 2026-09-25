// orders HTTP service — public boundary of the fixture project, written in TypeScript.
// POST /orders persists an order under DATA_DIR and answers 201 with it; GET /orders/:id
// reads it back; GET /health answers 200. build.mjs compiles this file into dist/server.js;
// the public service is that BUILD ARTIFACT, never this source.
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
