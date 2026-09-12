import { parseWire, wireString } from "../lib/value-validation.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	createTelemetrySpool,
	parseJsonl,
	redactSecretsShallow,
	type SpoolEvent,
	truncateFilePaths,
} from "./telemetry-spool.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-spool-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function makeEvent(over: Partial<SpoolEvent> = {}): SpoolEvent {
	return {
		schema: "v1",
		kind: "hook_decision",
		ts: "2026-04-23T00:00:00.000Z",
		session_id: "s",
		...over,
	};
}

describe("TelemetrySpool.append + readAll", () => {
	it("persists events as newline-delimited JSON", () => {
		const path = join(tmp, "spool.jsonl");
		const spool = createTelemetrySpool({ spoolPath: path });
		spool.append(makeEvent({ kind: "hook_decision" }));
		spool.append(makeEvent({ kind: "check_finding" }));
		const text = readFileSync(path, "utf-8");
		expect(text.split("\n").filter(Boolean).length).toBe(2);
	});

	it("readAll returns parsed events", () => {
		const spool = createTelemetrySpool({ spoolPath: join(tmp, "s.jsonl") });
		spool.append(makeEvent({ kind: "hook_decision" }));
		spool.append(makeEvent({ kind: "session_lifecycle" }));
		const events = spool.readAll();
		expect(events.length).toBe(2);
		expect(nonNull(events[1]).kind).toBe("session_lifecycle");
	});
});

describe("TelemetrySpool.size", () => {
	it("returns zero bytes when file missing", () => {
		const spool = createTelemetrySpool({ spoolPath: join(tmp, "missing.jsonl") });
		expect(spool.size().bytes).toBe(0);
	});
	it("grows as events are appended", () => {
		const spool = createTelemetrySpool({ spoolPath: join(tmp, "s.jsonl") });
		spool.append(makeEvent({ kind: "hook_decision" }));
		const first = spool.size().bytes;
		spool.append(makeEvent({ kind: "hook_decision" }));
		expect(spool.size().bytes).toBeGreaterThan(first);
	});
});

describe("TelemetrySpool.compact — preferential preservation", () => {
	it("keeps session_lifecycle events under pressure", () => {
		const path = join(tmp, "s.jsonl");
		// Large auto-compact threshold so the internal trigger never fires
		// during appends; we drive compact() manually below.
		const spool = createTelemetrySpool({
			spoolPath: path,
			max_bytes: 2000,
			trim_threshold: 10,
		});
		for (let i = 0; i < 30; i++) {
			spool.append(makeEvent({ kind: "hook_decision", session_id: `s-${i}` }));
		}
		spool.append(makeEvent({ kind: "session_lifecycle", session_id: "s-special" }));
		const before = spool.readAll().length;
		const { removed, kept } = spool.compact();
		const events = spool.readAll();
		expect(removed).toBeGreaterThan(0);
		expect(kept).toBe(events.length);
		expect(events.length).toBeLessThan(before);
		const hasLifecycle = events.some((e) => e.kind === "session_lifecycle");
		expect(hasLifecycle).toBe(true);
	});

	it("preserves all events when well under cap", () => {
		const path = join(tmp, "small.jsonl");
		const spool = createTelemetrySpool({
			spoolPath: path,
			max_bytes: 1024 * 1024,
			trim_threshold: 0.9,
		});
		for (let i = 0; i < 5; i++) spool.append(makeEvent({ session_id: `s-${i}` }));
		const { removed } = spool.compact();
		expect(removed).toBe(0);
	});
});

describe("redactors", () => {
	it("redactSecretsShallow strips the secrets key", () => {
		const raw = makeEvent({ kind: "hook_decision", secrets: ["X"] });
		const out = redactSecretsShallow(raw);
		expect("secrets" in out).toBe(false);
	});

	it("preserves telemetry that has no secrets field", () => {
		const event = makeEvent({ kind: "hook_decision" });
		expect(redactSecretsShallow(event)).toEqual(event);
	});

	it("truncateFilePaths shortens long paths", () => {
		const raw = makeEvent({ kind: "check_finding", file_path: "a".repeat(500) });
		const out = truncateFilePaths(raw);
		expect(typeof out.file_path).toBe("string");
		expect((parseWire(out.file_path, wireString, "test JSON value")).length).toBeLessThan(300);
	});
});

describe("parseJsonl — robustness", () => {
	it("skips an unsupported event kind without dropping a valid adjacent record", () => {
		const valid = makeEvent({ kind: "custom", detail: "retained" });
		const text = `${JSON.stringify({ ...valid, kind: "unsupported" })}\n${JSON.stringify(valid)}\n`;
		expect(parseJsonl(text)).toEqual([valid]);
	});
	it("ignores malformed lines", () => {
		const text = ['{"schema":"v1","kind":"hook_decision","ts":"x"}', "not json", ""].join("\n");
		expect(parseJsonl(text).length).toBe(1);
	});

	it("rejects events missing required fields", () => {
		const text = '{"schema":"v1","kind":"hook_decision"}';
		expect(parseJsonl(text).length).toBe(0);
	});

	it("round-trips an externally-written file", () => {
		const path = join(tmp, "external.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify(makeEvent({ kind: "hook_decision" }))}\n${JSON.stringify(makeEvent({ kind: "check_finding" }))}\n`,
		);
		const spool = createTelemetrySpool({ spoolPath: path });
		expect(spool.readAll().length).toBe(2);
	});
});
