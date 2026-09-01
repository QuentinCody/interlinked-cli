// ===========================================
// G1 inference proxy — transparent pass-through + envelope tee
// ===========================================
// A local listener the runner's ANTHROPIC_BASE_URL points at. Forwards every
// request to the real API and streams the response back UNBUFFERED; for
// POST /v1/messages it tees the stream through the SSE reassembler and
// appends an `inference-envelope.v1` record. Contract: capture is strictly
// fail-open — any tee/build/append failure is logged and forwarding proceeds;
// only an unreachable upstream produces an error (502) to the client.
// Credentials are forwarded live and NEVER persisted (inference-envelope.ts).
//
// Run: node dist/harness/replay/inference-proxy.js
//   PORT (default 8787) · ANTHROPIC_REAL_BASE_URL (default api.anthropic.com)
//   INTERLINKED_REPLAY_DIR (default <cwd>/.interlinked/replay)
// Then: export ANTHROPIC_BASE_URL=http://127.0.0.1:<port>

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonObject } from "../../lib/json-types.js";
import { buildEnvelope } from "./inference-envelope.js";
import { appendEnvelope } from "./inference-store.js";
import { createSseReassembler } from "./sse-reassembly.js";

interface InferenceProxyOptions {
	/** 0 = ephemeral (tests). */
	port: number;
	upstreamUrl: string;
	replayDir: string;
	log?: (msg: string) => void;
	/** Injectable clock for deterministic tests; production default is ISO now. */
	now?: () => string;
}

export interface InferenceProxy {
	server: Server;
	url: string;
	close(): void;
}

const BAD_GATEWAY = 502;
/** Bounds the wait for upstream HEADERS only. Deliberately NOT a whole-body
 *  timeout: a hard model turn can stream for many minutes, and aborting the
 *  body would sever live sessions. The timer clears the moment fetch resolves
 *  (headers received); from then on the stream runs unbounded, like the
 *  runner's own connection would. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 30_000;

/** Hop-by-hop / recomputed headers that must not be forwarded upstream.
 *  `accept-encoding` is pinned to identity so the tee sees plain text. */
const NON_FORWARDED = new Set([
	"host",
	"connection",
	"content-length",
	"transfer-encoding",
	"keep-alive",
	"upgrade",
	"proxy-connection",
	"te",
	"trailer",
	"accept-encoding",
]);

/** Response headers the proxy recomputes rather than relays. */
const NON_RELAYED = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

function forwardHeaders(req: IncomingMessage): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (NON_FORWARDED.has(name.toLowerCase())) continue;
		if (typeof value === "string") out[name] = value;
		else if (Array.isArray(value)) out[name] = value.join(",");
	}
	out["accept-encoding"] = "identity";
	return out;
}

function relayResponseHeaders(upstream: Response, res: ServerResponse): void {
	const headers: Record<string, string> = {};
	upstream.headers.forEach((value, name) => {
		if (!NON_RELAYED.has(name.toLowerCase())) headers[name] = value;
	});
	res.writeHead(upstream.status, headers);
}

/** Capture only the messages endpoint itself — sub-paths like
 *  /v1/messages/count_tokens and /v1/messages/batches are not model turns.
 *  Exported as the documented capture contract (unit-pinned in the test). */
export function shouldCapture(method: string | undefined, url: string | undefined): boolean {
	return method === "POST" && /^\/v1\/messages(?:\?|$)/.test(url ?? "");
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolveBody, rejectBody) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolveBody(Buffer.concat(chunks)));
		req.on("error", rejectBody);
	});
}

function parseJsonObject(text: string): JsonObject | null {
	try {
		// SAFETY: JSON.parse returns `any`; widening to `unknown` forces the
		// shape check below before any property access.
		const parsed = JSON.parse(text) as unknown;
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? // SAFETY: non-null, non-array object was just verified — the JSON
				// object case is exactly what JsonObject models.
				(parsed as JsonObject)
			: null;
	} catch (err) {
		void err; // malformed body — forward anyway, just skip capture
		return null;
	}
}

/** Everything one in-flight capture needs; built per captured request. */
interface CaptureContext {
	replayDir: string;
	requestIndex: number;
	tsRequest: string;
	requestHeaders: Record<string, unknown>;
	requestBody: JsonObject;
	log: (msg: string) => void;
	now: () => string;
}

/** The per-server runtime handleRequest closes over (options + counter). */
interface ProxyRuntime {
	opts: InferenceProxyOptions;
	log: (msg: string) => void;
	now: () => string;
	nextIndex: () => number;
}

/** Persist the envelope. Fail-open by contract: capture must never break
 *  forwarding, so every failure lands in the log and nowhere else. */
function persistEnvelope(ctx: CaptureContext, response: JsonObject): void {
	try {
		const envelope = buildEnvelope({
			requestIndex: ctx.requestIndex,
			tsRequest: ctx.tsRequest,
			tsResponse: ctx.now(),
			requestHeaders: ctx.requestHeaders,
			requestBody: ctx.requestBody,
			response,
		});
		appendEnvelope(ctx.replayDir, envelope);
	} catch (err) {
		ctx.log(
			`envelope append failed (capture skipped): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Relay an SSE body chunk-by-chunk while teeing into the reassembler. */
async function relaySseWithCapture(
	upstream: Response,
	res: ServerResponse,
	ctx: CaptureContext,
): Promise<void> {
	const reassembler = createSseReassembler();
	if (upstream.body) {
		for await (const chunk of upstream.body) {
			const buf = Buffer.from(chunk);
			res.write(buf);
			reassembler.push(buf.toString("utf-8"));
		}
	}
	res.end();
	const message = reassembler.finish();
	if (message) persistEnvelope(ctx, message);
}

/** Relay a buffered (non-streaming) body, capturing when it parses as JSON. */
async function relayBufferedWithCapture(
	upstream: Response,
	res: ServerResponse,
	ctx: CaptureContext,
): Promise<void> {
	const text = await upstream.text();
	res.end(text);
	const parsed = parseJsonObject(text);
	if (parsed) persistEnvelope(ctx, parsed);
}

/** Relay without capture (non-messages endpoints). */
async function relayPassthrough(upstream: Response, res: ServerResponse): Promise<void> {
	if (upstream.body) {
		for await (const chunk of upstream.body) {
			res.write(Buffer.from(chunk));
		}
	}
	res.end();
}

/** Fetch upstream with a HEADERS-arrival timeout (see the constant's note —
 *  never a body timeout). Returns null after logging on any failure. The init
 *  object is built field-by-field: exactOptionalPropertyTypes forbids passing
 *  explicit `undefined` for method/body. */
async function fetchUpstream(
	req: IncomingMessage,
	body: Buffer,
	runtime: ProxyRuntime,
): Promise<Response | null> {
	const controller = new AbortController();
	const connectTimer = setTimeout(() => controller.abort(), UPSTREAM_CONNECT_TIMEOUT_MS);
	try {
		const init: RequestInit = {
			method: req.method ?? "GET",
			headers: forwardHeaders(req),
			signal: controller.signal,
		};
		if (body.length > 0) init.body = new Uint8Array(body);
		return await fetch(`${runtime.opts.upstreamUrl}${req.url ?? "/"}`, init);
	} catch (err) {
		runtime.log(`upstream unreachable: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	} finally {
		clearTimeout(connectTimer);
	}
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	runtime: ProxyRuntime,
): Promise<void> {
	const tsRequest = runtime.now();
	const body = await readBody(req);
	const upstream = await fetchUpstream(req, body, runtime);
	if (!upstream) {
		res.writeHead(BAD_GATEWAY, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "inference-proxy: upstream unreachable" }));
		return;
	}

	relayResponseHeaders(upstream, res);

	const requestBody = shouldCapture(req.method, req.url)
		? parseJsonObject(body.toString("utf-8"))
		: null;
	if (!requestBody) {
		await relayPassthrough(upstream, res);
		return;
	}
	const ctx: CaptureContext = {
		replayDir: runtime.opts.replayDir,
		requestIndex: runtime.nextIndex(),
		tsRequest,
		requestHeaders: req.headers,
		requestBody,
		log: runtime.log,
		now: runtime.now,
	};
	const contentType = upstream.headers.get("content-type") ?? "";
	if (contentType.includes("text/event-stream")) {
		await relaySseWithCapture(upstream, res, ctx);
	} else {
		await relayBufferedWithCapture(upstream, res, ctx);
	}
}

/** Start the proxy. Resolves once listening; `url` is ready to use as an
 *  ANTHROPIC_BASE_URL value. */
export function createInferenceProxy(options: InferenceProxyOptions): Promise<InferenceProxy> {
	let counter = 0;
	const runtime: ProxyRuntime = {
		opts: options,
		log: options.log ?? ((msg) => console.error(`[inference-proxy] ${msg}`)),
		now: options.now ?? (() => new Date().toISOString()),
		nextIndex: () => ++counter,
	};

	const server = createServer((req, res) => {
		handleRequest(req, res, runtime).catch((err: unknown) => {
			runtime.log(`handler error: ${err instanceof Error ? err.message : String(err)}`);
			if (!res.headersSent) res.writeHead(BAD_GATEWAY);
			res.end();
		});
	});

	return new Promise((resolveProxy) => {
		// interlinked-ignore: ubs_hardcoded_localhost — loopback bind is the security design: this proxy carries live API credentials and must never listen beyond the local host.
		server.listen(options.port, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : options.port;
			resolveProxy({
				server,
				// interlinked-ignore: ubs_hardcoded_localhost — the advertised URL mirrors the loopback-only bind above.
				url: `http://127.0.0.1:${port}`,
				close: () => server.close(),
			});
		});
	});
}

/** CLI entry (the config boundary — env is read here only):
 *  `node dist/harness/replay/inference-proxy.js`. */
async function main(): Promise<void> {
	const port = Number(process.env.PORT ?? 8787);
	const upstreamUrl = process.env.ANTHROPIC_REAL_BASE_URL ?? "https://api.anthropic.com";
	const replayDir =
		process.env.INTERLINKED_REPLAY_DIR ?? join(process.cwd(), ".interlinked", "replay");
	const proxy = await createInferenceProxy({ port, upstreamUrl, replayDir });
	console.error(`[inference-proxy] listening on ${proxy.url} → ${upstreamUrl}`);
	console.error(`[inference-proxy] envelopes → ${replayDir}/inference/pending.jsonl`);
	console.error(
		`[inference-proxy] point your runner at it:  export ANTHROPIC_BASE_URL=${proxy.url}`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err: unknown) => {
		console.error(`[inference-proxy] fatal: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}
