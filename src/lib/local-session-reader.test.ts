import { chmodSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionState } from "./local-activity-types.js";
import {
	LocalSessionScanLimitError,
	MAX_LOCAL_SESSION_FILE_BYTES,
	readBoundedLocalSessions,
} from "./local-session-reader.js";
import { readLocalSessions } from "./local-activity.js";

function session(id: string): SessionState {
	return {
		session_id: id,
		agent: `agent-${id}`,
		phase: "ACTIVE",
		started_at: "2026-08-31T00:00:00.000Z",
		last_event_at: "2026-08-31T00:00:01.000Z",
		tool_count: 1,
		error_count: 0,
		files_touched: [],
		tools_used: { Read: 1 },
	};
}

function writePaddedSession(path: string, id: string, bytes: number): void {
	const json = JSON.stringify(session(id));
	if (json.length > bytes) throw new Error(`fixture is ${json.length} bytes, limit is ${bytes}`);
	writeFileSync(path, json.padEnd(bytes, " "));
}

describe("bounded local session reader", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "interlinked-local-sessions-"));
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("streams valid JSON files and skips malformed or unrelated entries", () => {
		writeFileSync(join(root, "valid.json"), JSON.stringify(session("valid")));
		writeFileSync(join(root, "broken.json"), "{");
		writeFileSync(join(root, "anchor.json"), JSON.stringify({ session_id: "anchor" }));
		writeFileSync(join(root, "notes.txt"), "ignored");

		expect(readBoundedLocalSessions(root).map((session) => session.session_id)).toEqual([
			"valid",
		]);
	});

	it("refuses an oversized session before reading or parsing its contents", () => {
		const path = join(root, "oversized.json");
		writeFileSync(path, "{}");
		truncateSync(path, MAX_LOCAL_SESSION_FILE_BYTES + 1);

		expect(() => readBoundedLocalSessions(root)).toThrow(LocalSessionScanLimitError);
	});

	it("propagates a scan-limit error through the public local-activity wrapper", () => {
		const sessionsDir = join(root, ".interlinked", "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const path = join(sessionsDir, "oversized.json");
		writeFileSync(path, "{}");
		truncateSync(path, MAX_LOCAL_SESSION_FILE_BYTES + 1);

		expect(() => readLocalSessions(root)).toThrow(LocalSessionScanLimitError);
	});

	it("accepts the per-file byte boundary and throws one byte above it", () => {
		const limits = { maxFiles: 2, maxFileBytes: 256, maxTotalBytes: 1024 };
		writePaddedSession(join(root, "boundary.json"), "boundary", limits.maxFileBytes);
		expect(readBoundedLocalSessions(root, limits)).toHaveLength(1);

		writeFileSync(join(root, "over.json"), " ".repeat(limits.maxFileBytes + 1));
		expect(() => readBoundedLocalSessions(root, limits)).toThrow(
			/per-file limit 256/,
		);
	});

	it("accepts the file-count boundary and throws on the next JSON file", () => {
		const limits = { maxFiles: 2, maxFileBytes: 1024, maxTotalBytes: 4096 };
		writeFileSync(join(root, "one.json"), JSON.stringify(session("one")));
		writeFileSync(join(root, "two.json"), JSON.stringify(session("two")));
		expect(readBoundedLocalSessions(root, limits)).toHaveLength(2);

		writeFileSync(join(root, "three.json"), JSON.stringify(session("three")));
		expect(() => readBoundedLocalSessions(root, limits)).toThrow(/more than 2 JSON files/);
	});

	it("accepts the aggregate byte boundary and throws when the sum exceeds it", () => {
		const limits = { maxFiles: 3, maxFileBytes: 256, maxTotalBytes: 512 };
		writePaddedSession(join(root, "one.json"), "one", 256);
		writePaddedSession(join(root, "two.json"), "two", 256);
		expect(readBoundedLocalSessions(root, limits)).toHaveLength(2);

		writeFileSync(join(root, "three.json"), " ");
		expect(() => readBoundedLocalSessions(root, limits)).toThrow(
			/JSON files exceed 512 total bytes/,
		);
	});

	it("skips an unreadable legacy file without hiding a readable session", () => {
		writeFileSync(join(root, "valid.json"), JSON.stringify(session("valid")));
		const unreadable = join(root, "unreadable.json");
		writeFileSync(unreadable, JSON.stringify(session("unreadable")));
		chmodSync(unreadable, 0o000);
		expect(readBoundedLocalSessions(root).map((item) => item.session_id)).toEqual([
			"valid",
		]);
	});

	it("returns an empty list for a missing directory", () => {
		const missing = join(root, "missing");
		expect(readBoundedLocalSessions(missing)).toEqual([]);
		mkdirSync(missing);
		expect(readBoundedLocalSessions(missing)).toEqual([]);
	});

	it("returns an empty list rather than throwing when the directory itself cannot be opened", () => {
		const locked = join(root, "locked");
		mkdirSync(locked);
		writeFileSync(join(locked, "valid.json"), JSON.stringify(session("valid")));
		chmodSync(locked, 0o000);
		// existsSync(locked) is true (it exists), but opendirSync throws EACCES —
		// a non-LocalSessionScanLimitError the reader must swallow, not propagate.
		const result = readBoundedLocalSessions(locked);
		chmodSync(locked, 0o755);
		expect(result).toEqual([]);
	});
});
