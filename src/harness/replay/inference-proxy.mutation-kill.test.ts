// Mutation-directed companion for inference-proxy.ts (fleet W8, 56 surviving
// mutants as of the 2026-08-14 census — see
// scratch/fleet-r3/receipts/src_harness_replay_inference-proxy.ts.jsonl for
// the full per-mutant disposition). Each `it()` closes a specific
// observable gap the existing inference-proxy.test.ts left open; the
// `// test-contract:` line above each case names the real behavior it
// pins, independent of any mutant (per CONTRACT-W6's receipts rule).
//
// Every fixture here was validated empirically against the pristine module
// (and, per the fleet contract, against shadow-built mutant copies) before
// being written — see scratch/fleet-r3/probes/inference-proxy-header-probe.mts
// and scratch/fleet-r3/shadow-verify/inference-proxy-shadow-verify.mts.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInferenceProxy, type InferenceProxy } from "./inference-proxy.js";

const cleanups: Array<() => void> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) fn();
});

function tempReplayDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-proxy-mk-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function listen(server: Server): Promise<string> {
	return new Promise((resolveUrl) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			cleanups.push(() => server.close());
			resolveUrl(`http://127.0.0.1:${port}`);
		});
	});
}

async function startProxy(
	upstreamUrl: string,
	replayDir: string,
	log?: (msg: string) => void,
): Promise<InferenceProxy> {
	const proxy = await createInferenceProxy({
		port: 0,
		upstreamUrl,
		replayDir,
		log: log ?? (() => undefined),
	});
	cleanups.push(() => proxy.close());
	return proxy;
}

/** A minimal upstream that answers every request the same way and records
 *  the headers Node parsed off the LAST request it received. */
function startHeaderRecordingUpstream(): { url: Promise<string>; received: () => Record<string, unknown> } {
	let received: Record<string, unknown> = {};
	const server = createServer((req, res) => {
		received = req.headers;
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
	return { url: listen(server), received: () => received };
}

/** Sends one raw HTTP/1.1 request with caller-supplied extra header lines
 *  and returns the full response text — mirrors the raw-socket technique
 *  already used by inference-proxy.test.ts's "duplicate header values" case. */
function rawRequest(port: number, extraHeaderLines: string[]): Promise<string> {
	return new Promise((resolveDone, rejectDone) => {
		let buf = "";
		const sock = netConnect(port, "127.0.0.1", () => {
			sock.write(
				[
					"GET /v1/models HTTP/1.1",
					`Host: 127.0.0.1:${port}`,
					"Connection: close",
					...extraHeaderLines,
					"",
					"",
				].join("\r\n"),
			);
		});
		sock.on("data", (c: Buffer) => {
			buf += c.toString("utf-8");
		});
		sock.on("close", () => resolveDone(buf));
		sock.on("error", rejectDone);
		setTimeout(() => rejectDone(new Error(`rawRequest timed out; buf so far: ${buf}`)), 5000);
	});
}

describe("forwardHeaders — NON_FORWARDED hop-by-hop headers are stripped", () => {
	// test-contract: every header name in the NON_FORWARDED set (proxy-connection,
	// te, trailer, keep-alive) never reaches upstream, accept-encoding is always
	// forced to "identity" regardless of what the client sent, and a header NOT
	// in the set passes through unchanged. Kills: deleting any NON_FORWARDED
	// entry, dropping the `out["accept-encoding"] = "identity"` override, and
	// dropping the `out[name] = value` preserve branch.
	it("drops hop-by-hop headers, pins accept-encoding to identity, keeps other headers", async () => {
		const replayDir = tempReplayDir();
		const { url, received } = startHeaderRecordingUpstream();
		const upstreamUrl = await url;
		const proxy = await startProxy(upstreamUrl, replayDir);
		const port = Number(new URL(proxy.url).port);

		await rawRequest(port, [
			"Proxy-Connection: PROBE-PC-MARKER",
			"TE: PROBE-TE-MARKER",
			"Trailer: PROBE-TRAILER-MARKER",
			"Keep-Alive: timeout=5",
			"Accept-Encoding: gzip",
			"X-Custom-Marker: keep-me",
		]);

		const got = received();
		expect(got["proxy-connection"]).toBeUndefined();
		expect(got.te).toBeUndefined();
		expect(got.trailer).toBeUndefined();
		expect(got["keep-alive"]).toBeUndefined();
		expect(got["accept-encoding"]).toBe("identity");
		expect(got["x-custom-marker"]).toBe("keep-me");
	});
});

describe("relayResponseHeaders — NON_RELAYED response headers are recomputed, not relayed", () => {
	// test-contract: content-encoding is excluded from what the client sees (it
	// is a NON_RELAYED name), an unrelated response header passes through
	// unchanged, and the upstream's status code is forwarded verbatim. Kills:
	// deleting "content-encoding" from NON_RELAYED, dropping the header-copy
	// loop, and hardcoding/ignoring `upstream.status`.
	it("strips content-encoding, relays a custom header, and forwards the status code", async () => {
		const replayDir = tempReplayDir();
		const upstream = createServer((_req, res) => {
			res.writeHead(201, {
				"content-type": "application/json",
				"content-encoding": "gzip",
				"x-upstream-marker": "abc",
			});
			res.end(JSON.stringify({ ok: true }));
		});
		const upstreamUrl = await listen(upstream);
		const proxy = await startProxy(upstreamUrl, replayDir);

		const res = await fetch(`${proxy.url}/v1/models`);
		expect(res.status).toBe(201);
		expect(res.headers.get("content-encoding")).toBeNull();
		expect(res.headers.get("x-upstream-marker")).toBe("abc");
	});
});
