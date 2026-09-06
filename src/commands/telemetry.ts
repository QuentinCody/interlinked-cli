// ===========================================
// interlinked telemetry — view the local JSONL spool
// ===========================================
// Reads the local telemetry spool at .interlinked/offline-spool.jsonl (see
// harness/telemetry-spool.ts). `--follow` tails new events as they land.
// Read-only, local-only — no remote transport and no config toggles.

import { createReadStream, existsSync, watchFile } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createTelemetrySpool, type SpoolEvent } from "../harness/telemetry-spool.js";

export interface TelemetryOptions {
	json?: boolean;
	follow?: boolean;
	limit?: string;
	spool?: string;
	/**
	 * Test-only injection point: replaces the infinite poll wait inside
	 * follow mode. Real callers never set this, so the default (undefined)
	 * preserves the "never resolves — poll until ctrl-c" behavior exactly.
	 * Set only in tests, to let an await on telemetryShowCommand({follow})
	 * observe the watcher installed and then return instead of hanging.
	 */
	waitForever?: () => Promise<void>;
}

export async function telemetryShowCommand(options: TelemetryOptions): Promise<void> {
	const spoolPath = options.spool ?? join(process.cwd(), ".interlinked", "offline-spool.jsonl");
	if (!existsSync(spoolPath)) {
		if (options.json) {
			process.stdout.write(`${JSON.stringify({ ok: true, events: [], path: spoolPath })}\n`);
		} else {
			process.stdout.write(`[interlinked] no spool at ${spoolPath}\n`);
		}
		return;
	}

	if (options.follow) {
		await followSpool(spoolPath, options);
		return;
	}

	const spool = createTelemetrySpool({ spoolPath });
	const limit = parseLimit(options.limit);
	const events = spool.readAll();
	const slice = limit === null ? events : events.slice(-limit);

	if (options.json) {
		process.stdout.write(
			`${JSON.stringify({ ok: true, events: slice, path: spoolPath }, null, 2)}\n`,
		);
		return;
	}
	for (const e of slice) printEventLine(e);
}

async function followSpool(spoolPath: string, options: TelemetryOptions): Promise<void> {
	// Read the existing content once, then tail for new lines. We use
	// readline over a read stream and re-open when the file grows.
	let lastSize = 0;

	// Initial read.
	const fs = await import("node:fs/promises");
	const stat = await fs.stat(spoolPath);
	const printInitial = options.limit !== undefined;
	if (printInitial) {
		const spool = createTelemetrySpool({ spoolPath });
		const limit = parseLimit(options.limit);
		const events = spool.readAll();
		const slice = limit === null ? events : events.slice(-limit);
		for (const e of slice) printEventLine(e);
	}
	lastSize = stat.size;

	await new Promise<void>((resolve) => {
		// `watchFile` is cheap and fires when the file grows. In production
		// this promise never resolves — poll until the user ctrl-c's;
		// `options.waitForever`, when a test supplies it, resolves it so the
		// call can return right after the watcher below is installed.
		watchFile(spoolPath, { interval: 250 }, (curr) => {
			if (curr.size > lastSize) {
				// Partial read starting from last known offset.
				const start = lastSize;
				lastSize = curr.size;
				const stream = createReadStream(spoolPath, { start, encoding: "utf-8" });
				const rl = createInterface({ input: stream });
				rl.on("line", (line) => handleLine(line, options));
				rl.on("close", () => {
					stream.close();
				});
			}
		});
		if (options.waitForever) {
			void options.waitForever().then(resolve);
		}
	});
}

function handleLine(line: string, options: TelemetryOptions): void {
	if (!line) return;
	let ev: SpoolEvent | null = null;
	try {
		const parsed = JSON.parse(line);
		if (parsed && typeof parsed === "object") ev = parsed as SpoolEvent;
	} catch {
		ev = null;
	}
	if (!ev) return;
	if (options.json) {
		process.stdout.write(`${line}\n`);
	} else {
		printEventLine(ev);
	}
}

function printEventLine(e: SpoolEvent): void {
	const session = typeof e.session_id === "string" ? e.session_id : "-";
	const extra = e.kind === "hook_decision" ? ((e.decision as string | undefined) ?? "") : "";
	process.stdout.write(`${e.ts}  ${e.kind.padEnd(22)} ${session.padEnd(20)} ${extra}\n`);
}

function parseLimit(raw: string | undefined): number | null {
	if (!raw) return null;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}
