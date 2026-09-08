// ===========================================
// TSC Overlay Sidecar — process entry
// ===========================================
// A disposable child process that runs ONE overlay check request and exits.
// Spawned by tsc-overlay-sidecar-client.ts so the whole-project TypeScript
// LanguageService heap (~1-2GB on this repo) never lives in the daemon —
// it lives here, and is released to the OS the moment this process exits.
//
// Protocol: read one line-delimited JSON SidecarOverlayRequest from stdin,
// write one line-delimited JSON SidecarOverlayResponse to stdout, exit 0.
// Never throws past this file's boundary — every failure becomes an
// `{id, error}` response so the client's JSON.parse always succeeds when the
// process itself didn't crash outright (crash/timeout are the client's
// concern, not this file's).
//
// Run directly:
//   echo '{"id":1,"method":"overlayCheck","protocolVersion":1,"params":{...}}' \
//     | node dist/harness/check-engine/tool-runners/tsc-overlay-sidecar-main.js

import { isJsonObject } from "../../../lib/json-types.js";
import { isOverlayParams } from "./tsc-overlay-wire.js";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { SidecarOverlayRequest, SidecarOverlayResponse } from "./tsc-overlay-protocol.js";
import { runOverlayCheckInProcess } from "./tsc-overlay-service.js";

/** Parse the raw stdin text into a request, or null if it isn't one. Kept
 *  permissive — a malformed request degrades to an error response, not a
 *  crash, per the sidecar's fail-closed-on-the-client contract. */
function parseRequest(raw: string): SidecarOverlayRequest | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.trim());
	} catch {
		return null;
	}
	if (!isJsonObject(parsed)) return null;
	if (typeof parsed.id !== "number" || !Number.isFinite(parsed.id) || parsed.method !== "overlayCheck") return null;
	if (!isOverlayParams(parsed.params)) return null;

	// The constructed object literal is checked against SidecarOverlayRequest
	// by the compiler — every required field above was validated, not assumed.
	return { id: parsed.id, method: "overlayCheck", protocolVersion: 1, params: parsed.params };
}

/** Run the request and produce a response — this is the only place the
 *  sidecar's own exceptions are caught, so a bad request or a LanguageService
 *  throw always degrades to `{id, error}` instead of a nonzero exit. */
function handleOne(req: SidecarOverlayRequest): SidecarOverlayResponse {
	try {
		const result = runOverlayCheckInProcess(req.params);
		return { id: req.id, result };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { id: req.id, error: `sidecar: ${message}` };
	}
}

/** Entry point — reads all of stdin synchronously (the client writes one
 *  request then closes stdin via spawnSync's `input` option, so EOF arrives
 *  immediately) and writes exactly one response line to stdout. */
export function main(): void {
	let raw: string;
	try {
		// fd 0 = stdin. Blocking read to EOF — correct here because the client
		// always writes its full request before closing the pipe.
		raw = readFileSync(0, "utf-8");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		process.stdout.write(`${JSON.stringify({ id: -1, error: `sidecar: stdin read failed: ${message}` })}\n`);
		process.exitCode = 1;
		return;
	}

	const req = parseRequest(raw);
	if (!req) {
		process.stdout.write(
			`${JSON.stringify({ id: -1, error: "sidecar: malformed request" } satisfies SidecarOverlayResponse)}\n`,
		);
		process.exitCode = 1;
		return;
	}

	const res = handleOne(req);
	process.stdout.write(`${JSON.stringify(res)}\n`);
}

// Run only when invoked directly (matches the inference-proxy convention),
// not when imported by tests exercising handleOne/parseRequest in isolation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
