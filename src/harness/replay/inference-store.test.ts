// G1 inference-envelope store — round-trip, torn-line tolerance, and the
// tool_use_id join lookup (docs/design/reproducibility/g1-inference-capture.md).

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendEnvelope,
	envelopeForToolUseId,
	type InferenceEnvelope,
	loadEnvelopes,
	parseInferenceEnvelope,
	pendingEnvelopePath,
} from "./inference-store.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempReplayDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-inference-store-"));
	cleanups.push(dir);
	return dir;
}

function envelope(overrides: Partial<InferenceEnvelope> = {}): InferenceEnvelope {
	return {
		schema: "inference-envelope.v1",
		request_index: 1,
		ts_request: "2026-07-24T12:00:00.000Z",
		ts_response: "2026-07-24T12:00:04.000Z",
		latency_ms: 4000,
		provider: "anthropic",
		request_headers: { "anthropic-version": "2023-06-01" },
		request: { model: "vendor-model-v6", messages: [] },
		response: { id: "msg_1", stop_reason: "tool_use", content: [] },
		tool_use_ids: ["toolu_abc"],
		request_sha256: "deadbeef",
		session_id: null,
		seq: null,
		...overrides,
	};
}

describe("inference-store", () => {
	it("pendingEnvelopePath nests under inference/", () => {
		expect(pendingEnvelopePath("/x/replay")).toBe(join("/x/replay", "inference", "pending.jsonl"));
	});

	it("appendEnvelope creates the directory and loadEnvelopes round-trips", () => {
		const dir = tempReplayDir();
		appendEnvelope(dir, envelope({ request_index: 1 }));
		appendEnvelope(dir, envelope({ request_index: 2, tool_use_ids: [] }));
		const loaded = loadEnvelopes(pendingEnvelopePath(dir));
		expect(loaded).toHaveLength(2);
		expect(loaded[0]?.request_index).toBe(1);
		expect(loaded[1]?.tool_use_ids).toEqual([]);
	});

	it("loadEnvelopes skips torn and foreign lines", () => {
		const dir = tempReplayDir();
		appendEnvelope(dir, envelope());
		const path = pendingEnvelopePath(dir);
		appendFileSync(path, '{"torn": tru\n');
		appendFileSync(path, `${JSON.stringify({ schema: "other.v1" })}\n`);
		appendEnvelope(dir, envelope({ request_index: 9 }));
		const loaded = loadEnvelopes(path);
		expect(loaded).toHaveLength(2);
		expect(loaded[1]?.request_index).toBe(9);
	});

	it("loadEnvelopes returns [] for a missing file", () => {
		expect(loadEnvelopes("/nonexistent/nowhere.jsonl")).toEqual([]);
	});

	it("envelopeForToolUseId finds the envelope carrying the id, else null", () => {
		const a = envelope({ request_index: 1, tool_use_ids: ["toolu_a"] });
		const b = envelope({ request_index: 2, tool_use_ids: ["toolu_b1", "toolu_b2"] });
		expect(envelopeForToolUseId([a, b], "toolu_b2")?.request_index).toBe(2);
		expect(envelopeForToolUseId([a, b], "toolu_zzz")).toBeNull();
	});
});

describe("parseInferenceEnvelope", () => {
	it("P1: accepts a well-formed envelope", () => {
		const e = envelope();
		expect(parseInferenceEnvelope(e)).toEqual(e);
	});

	it("P2: accepts an empty tool_use_ids array and a null session_id/seq", () => {
		const e = envelope({ tool_use_ids: [], session_id: null, seq: null });
		expect(parseInferenceEnvelope(e)).toEqual(e);
	});

	it("N1: rejects the wrong schema tag", () => {
		expect(parseInferenceEnvelope({ ...envelope(), schema: "other.v1" })).toBeNull();
	});

	it("N2: rejects a provider other than anthropic", () => {
		expect(
			parseInferenceEnvelope({ ...envelope(), provider: "openai" }),
		).toBeNull();
	});

	it("N3: rejects a non-string-array tool_use_ids", () => {
		const raw = { ...envelope(), tool_use_ids: ["ok", 42] };
		expect(parseInferenceEnvelope(raw)).toBeNull();
	});

	it("N4: rejects a non-object request body", () => {
		const raw = { ...envelope(), request: "not-an-object" };
		expect(parseInferenceEnvelope(raw)).toBeNull();
	});

	it("N5: rejects a non-object line (array)", () => {
		expect(parseInferenceEnvelope(["inference-envelope.v1"])).toBeNull();
	});
});
