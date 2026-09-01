// ===========================================
// Viz Server — loopback dashboard host
// ===========================================
// A decoupled, read-only HTTP server (zero deps, node:http only) that serves
// the baseline-test dashboard and streams live activity to it. Binds 127.0.0.1
// ONLY — the dashboard surfaces unscrubbed tool I/O, so it must never leave the
// loopback interface.
//
// It builds its OWN ProjectGraph from the working tree and tails the existing
// activity.jsonl for live events — the harness daemon is not required and is
// never touched, so `interlinked viz` works offline.

import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectGraph } from "../../harness/project-graph.js";
import { buildFeeds, defaultFeedPaths, type FeedPaths, type VizFeed } from "./feeds.js";
import { buildGraphSnapshot, type VizGraphSnapshot } from "./graph-snapshot.js";

/** Default loopback port for the viz dashboard. Public API. */
export const DEFAULT_VIZ_PORT = 6403;

const ROUTE = {
	ROOT: "/",
	INDEX: "/index.html",
	GRAPH: "/api/graph",
	HEALTH: "/api/health",
} as const;

const HTTP = { OK: 200, NOT_FOUND: 404, SERVER_ERROR: 500 } as const;

interface VizServerOptions {
	root: string;
	port?: number;
	host?: string;
	/** Override the dashboard asset directory (dev/test). */
	webRoot?: string;
	/** Activity log to tail for live events (default: cwd/.interlinked/activity.jsonl). */
	activityPath?: string;
	/** Check-results log to tail for gate decisions (default: cwd/.interlinked/check-results.jsonl). */
	checkResultsPath?: string;
	/** Test feed to tail for the TESTS lens (default: cwd/.interlinked/test-events.jsonl). */
	testEventsPath?: string;
	/** Mutation manifest to watch for the MUTANTS lens (default: cwd/.interlinked/mutation-manifest.json). */
	mutationManifestPath?: string;
	/** Tailer poll interval in ms (default 1000). */
	pollMs?: number;
}

export interface VizServerHandle {
	url: string;
	port: number;
	close: () => Promise<void>;
}

interface SseClient {
	res: ServerResponse;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
};

/** Map a filename to a Content-Type, defaulting to octet-stream. */
export function contentTypeFor(name: string): string {
	const dot = name.lastIndexOf(".");
	const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
	return MIME[ext] ?? "application/octet-stream";
}

/**
 * Resolve a web asset across the dev tree and the bundled `dist/` layout.
 * In dev (tsx) this file is `src/lib/viz/server.ts` → `./web/<name>`; in the
 * published build it is bundled into `dist/index.js` and the asset is copied
 * to `dist/viz/<name>` (see scripts/copy-runtime-assets.mjs).
 */
export function resolveVizAsset(name: string): string | null {
	const candidates = [
		fileURLToPath(new URL(`./web/${name}`, import.meta.url)),
		fileURLToPath(new URL(`./viz/${name}`, import.meta.url)),
		join(process.cwd(), "src/lib/viz/web", name),
		join(process.cwd(), "dist/viz", name),
	];
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return null;
}

/** Read the dashboard HTML once at startup (startup sync I/O is fine; per-request is not). */
function loadDashboardHtml(webRoot: string | undefined): Buffer | null {
	const file = webRoot ? join(webRoot, "index.html") : resolveVizAsset("index.html");
	return file && existsSync(file) ? readFileSync(file) : null;
}

/** Start the loopback dashboard server. Resolves once it is listening. */
export async function startVizServer(opts: VizServerOptions): Promise<VizServerHandle> {
	const host = opts.host ?? "127.0.0.1";
	const rootLabel = basename(opts.root.replace(/[/\\]+$/, "")) || opts.root;
	const feeds = buildFeeds(resolveFeedPaths(opts), opts.pollMs ?? 1000);
	const hosted = feeds.map(hostFeed);
	let snapshot: VizGraphSnapshot | null = null;

	// The graph body is ~1MB of JSON on a mid-size repo and never changes while
	// the server runs, so it is serialized ONCE and every later request is a
	// buffer write. Re-stringifying per request cost ~10ms of main-loop time on
	// each reconnect for a byte-identical result.
	let graphBody: Buffer | null = null;

	const getSnapshot = (): VizGraphSnapshot => {
		if (!snapshot) {
			const graph = new ProjectGraph(opts.root);
			graph.initialize();
			snapshot = buildGraphSnapshot(graph, rootLabel);
		}
		return snapshot;
	};

	const getGraphBody = (): Buffer => {
		if (!graphBody) graphBody = Buffer.from(JSON.stringify(getSnapshot()));
		return graphBody;
	};

	const dashHtml = loadDashboardHtml(opts.webRoot);
	const server = createServer((req, res) => handleRequest(req, res, { getSnapshot, getGraphBody, dashHtml, hosted }));
	await new Promise<void>((resolve) => server.listen(opts.port ?? DEFAULT_VIZ_PORT, host, resolve));

	// Warm the graph the moment we are listening, not on the first request. The
	// walk+parse costs ~2s on a 3k-file repo; running it here overlaps it with
	// the browser fetching and parsing the page, so `/api/graph` is usually
	// already a cached buffer by the time the dashboard asks for it. Deferred by
	// one tick so `listen` resolves first — the URL must be printable instantly.
	setImmediate(() => {
		try {
			getGraphBody();
		} catch (err) {
			void err; /* a build failure surfaces on the request path, not here */
		}
	});

	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? DEFAULT_VIZ_PORT);

	const close = (): Promise<void> => {
		for (const feed of hosted) feed.close();
		return new Promise<void>((resolve) => server.close(() => resolve()));
	};

	return { url: `http://${host}:${port}`, port, close };
}

/** Resolve every feed path, honoring per-path overrides over the cwd defaults. */
function resolveFeedPaths(opts: VizServerOptions): FeedPaths {
	const defaults = defaultFeedPaths(process.cwd());
	return {
		activity: opts.activityPath ?? defaults.activity,
		checkResults: opts.checkResultsPath ?? defaults.checkResults,
		testEvents: opts.testEventsPath ?? defaults.testEvents,
		mutationManifest: opts.mutationManifestPath ?? defaults.mutationManifest,
	};
}

/** A feed plus its connected clients and running subscription. */
interface HostedFeed {
	feed: VizFeed;
	clients: Set<SseClient>;
	close: () => void;
}

/**
 * Start a feed's subscription and broadcast every event to its clients. One
 * subscription per feed regardless of how many browsers are watching.
 */
function hostFeed(feed: VizFeed): HostedFeed {
	const clients = new Set<SseClient>();
	const subscription = feed.subscribe((ev) => {
		const data = sseFrame(ev);
		for (const client of clients) {
			if (!client.res.writableEnded) client.res.write(data);
		}
	});
	const close = (): void => {
		subscription.stop();
		for (const client of [...clients]) {
			if (!client.res.writableEnded) client.res.end();
		}
		clients.clear();
	};
	return { feed, clients, close };
}

/** Frame any serializable event as an SSE `data:` line. */
function sseFrame(ev: unknown): string {
	return `data: ${JSON.stringify(ev)}\n\n`;
}

interface RequestContext {
	getSnapshot: () => VizGraphSnapshot;
	/** Pre-serialized `/api/graph` body — built once, written many times. */
	getGraphBody: () => Buffer;
	dashHtml: Buffer | null;
	hosted: HostedFeed[];
}

function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): void {
	const path = (req.url ?? ROUTE.ROOT).split("?")[0] ?? ROUTE.ROOT;
	if (path === ROUTE.ROOT || path === ROUTE.INDEX) {
		serveDashboard(res, ctx.dashHtml);
		return;
	}
	if (path === ROUTE.GRAPH) {
		sendJsonBuffer(res, ctx.getGraphBody());
		return;
	}
	if (path === ROUTE.HEALTH) {
		const s = ctx.getSnapshot();
		sendJson(res, { ok: true, root: s.root, node_count: s.node_count, edge_count: s.edge_count });
		return;
	}
	const hosted = ctx.hosted.find((h) => h.feed.route === path);
	if (hosted) {
		openFeedStream(req, res, hosted);
		return;
	}
	if (serveHtmlLens(res, path)) return;
	sendStatus(res, HTTP.NOT_FOUND, "not found");
}

/** Extra HTML lenses ship as web assets next to index.html; only bare .html
 *  names resolve, so this is not a general file server. True when served. */
function serveHtmlLens(res: ServerResponse, path: string): boolean {
	if (!/^\/[a-z-]+\.html$/.test(path)) return false;
	const asset = resolveVizAsset(path.slice(1));
	if (!asset || !existsSync(asset)) return false;
	res.writeHead(HTTP.OK, { "Content-Type": contentTypeFor("index.html"), "Cache-Control": "no-store" });
	res.end(readFileSync(asset));
	return true;
}

function sendJson(res: ServerResponse, body: unknown): void {
	sendJsonBuffer(res, Buffer.from(JSON.stringify(body)));
}

/** Write an already-serialized JSON body. The graph path uses this to skip re-stringifying ~1MB. */
function sendJsonBuffer(res: ServerResponse, body: Buffer): void {
	res.writeHead(HTTP.OK, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(body);
}

function sendStatus(res: ServerResponse, code: number, message: string): void {
	res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
	res.end(message);
}

function serveDashboard(res: ServerResponse, html: Buffer | null): void {
	if (!html) {
		sendStatus(res, HTTP.SERVER_ERROR, "dashboard asset missing");
		return;
	}
	res.writeHead(HTTP.OK, { "Content-Type": contentTypeFor("index.html"), "Cache-Control": "no-store" });
	res.end(html);
}

/** Write the SSE response head + hello comment shared by both live streams. */
function openSseHead(res: ServerResponse, hello: string): void {
	res.writeHead(HTTP.OK, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	res.write(`: ${hello}\n\n`);
}

/**
 * Open a Server-Sent-Events connection for one feed: replay its recent backlog
 * as seed, then register the client so the feed's single subscription broadcasts
 * new events to it. Deregisters on disconnect.
 */
function openFeedStream(req: IncomingMessage, res: ServerResponse, hosted: HostedFeed): void {
	openSseHead(res, hosted.feed.hello);
	for (const ev of hosted.feed.seed()) res.write(sseFrame(ev));
	const client: SseClient = { res };
	hosted.clients.add(client);
	req.on("close", () => {
		hosted.clients.delete(client);
	});
}
