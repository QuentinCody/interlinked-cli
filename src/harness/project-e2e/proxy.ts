// ===========================================
// Recording proxy — the supervisor's own view of an owned app (Unit E2)
// ===========================================
// A loopback HTTP proxy the supervisor places in front of an OWNED service.
// The browser under test hits the proxy; every request is forwarded
// unchanged and recorded with its instant, method, path and status. With
// serial workers each case's window contains only its own requests, so the
// boundary observation is case-correlated by the supervisor (§10.2), never
// by a test's self-declared "real" label.

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";

// interlinked-ignore: ubs_hardcoded_localhost — the proxy and the owned app are loopback by contract (§9.2)
const LOOPBACK = "127.0.0.1";
const BAD_GATEWAY = 502;
export interface ProxyRequest { atMs: number; method: string; path: string; status: number; }
export interface RecordingProxy {
    port: number; baseUrl: string; readonly requests: ProxyRequest[];
    /** Requests whose instant lies in [fromMs, toMs]. */ requestsBetween(fromMs: number, toMs: number): ProxyRequest[];
    close(): Promise<void>;
}

function forward(targetPort: number, incoming: IncomingMessage, outgoing: ServerResponse, record: ProxyRequest): void {
    const upstream = httpRequest({ host: LOOPBACK, port: targetPort, method: incoming.method, path: incoming.url, headers: { ...incoming.headers, host: `${LOOPBACK}:${targetPort}` } }, response => {
        record.status = response.statusCode ?? 0;
        outgoing.writeHead(response.statusCode ?? 0, response.headers);
        response.pipe(outgoing);
    });
    upstream.once("error", () => {
        record.status = BAD_GATEWAY;
        if (!outgoing.headersSent) outgoing.writeHead(BAD_GATEWAY, { "content-type": "text/plain" });
        outgoing.end("owned application unreachable");
    });
    incoming.pipe(upstream);
}
export function startRecordingProxy(targetPort: number): Promise<RecordingProxy> {
    const requests: ProxyRequest[] = [];
    const server: Server = createServer((incoming, outgoing) => {
        const record: ProxyRequest = { atMs: Date.now(), method: incoming.method ?? "GET", path: incoming.url ?? "/", status: 0 };
        requests.push(record);
        forward(targetPort, incoming, outgoing, record);
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, LOOPBACK, () => {
            const address = server.address();
            const port = address && typeof address === "object" ? address.port : 0;
            resolve({
                port, baseUrl: `http://${LOOPBACK}:${port}`, requests,
                requestsBetween: (fromMs, toMs) => requests.filter(row => row.atMs >= fromMs && row.atMs <= toMs),
                close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }),
            });
        });
    });
}
