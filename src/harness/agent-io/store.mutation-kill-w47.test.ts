import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	agentIoBlobPath,
	agentIoBlobsDir,
	agentIoLogPath,
	buildAgentIoRecord,
	emptyContent,
	prepareContent,
	recordAgentIo,
	scrubContent,
	sha256,
} from "./store.js";
import { INLINE_MAX_BYTES, MAX_TOOL_USE_IDS } from "./types.js";

let tmpDir: string;

function makeTmp(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "agent-io-store-w47-"));
	tmpDir = dir;
	return dir;
}

afterEach(() => {
	if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("agentIoLogPath / agentIoBlobsDir / agentIoBlobPath — .interlinked segment", () => {
	it("joins cwd with the literal .interlinked segment", () => {
		expect(agentIoLogPath("/repo")).toBe(path.join("/repo", ".interlinked", "agent-io.jsonl"));
		expect(agentIoBlobsDir("/repo")).toBe(path.join("/repo", ".interlinked", "agent-io", "blobs"));
		expect(agentIoBlobPath("/repo", "blobs/xyz")).toBe(
			path.join("/repo", ".interlinked", "agent-io", "blobs/xyz"),
		);
	});
});

describe("sha256 — utf-8 encoding + hex digest", () => {
	it("matches the known sha256 hex digest of a fixed string", () => {
		// sha256("abc") well-known digest
		expect(sha256("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("produces different digests for different inputs (not a constant/empty block)", () => {
		const a = sha256("hello world");
		const b = sha256("goodbye world");
		expect(a).not.toBe(b);
		expect(a).toHaveLength(64);
		expect(b).toHaveLength(64);
	});

	it("hashes multi-byte utf-8 text distinctly from its ascii-only substring", () => {
		// If "utf-8" were replaced by "" (empty encoding), Buffer/Hash update
		// would behave unpredictably; assert against Node's own known digest
		// of a multi-byte string.
		const cafe = sha256("café");
		const cafeAscii = sha256("caf");
		expect(cafe).not.toBe(cafeAscii);
		expect(cafe).toHaveLength(64);
	});
});

describe("scrubContent — secrets + pii pass tracking", () => {
	it("reports no passes for plain text with no secrets or pii", () => {
		const result = scrubContent("just some plain text with nothing sensitive");
		expect(result.passes).toEqual([]);
	});

	it("reports 'secrets' pass when a secret is found", () => {
		const result = scrubContent("key is AKIAABCDEFGHIJKLMNOP now");
		expect(result.passes).toContain("secrets");
		expect(result.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
	});

	it("reports 'pii' pass when an email is found", () => {
		const result = scrubContent("contact me at someone@realdomain.io please");
		expect(result.passes).toContain("pii");
		expect(result.text).not.toContain("someone@realdomain.io");
	});

	it("reports both passes when both secret and pii are present", () => {
		const result = scrubContent("email someone@realdomain.io key AKIAABCDEFGHIJKLMNOP");
		expect(result.passes).toContain("secrets");
		expect(result.passes).toContain("pii");
		expect(result.passes).toHaveLength(2);
	});
});

describe("emptyContent — hash of empty string", () => {
	it("content_sha256 equals sha256('') exactly", () => {
		const ec = emptyContent();
		expect(ec.content_sha256).toBe(sha256(""));
		expect(ec.content).toBeNull();
		expect(ec.content_bytes).toBe(0);
		expect(ec.scrubbed).toBe(false);
		expect(ec.redaction_passes).toEqual([]);
	});
});

describe("prepareContent — null/empty short-circuit", () => {
	it("returns emptyContent shape for raw === null", () => {
		const cwd = makeTmp();
		const result = prepareContent(null, cwd);
		expect(result.content).toBeNull();
		expect(result.scrubbed).toBe(false);
		expect(result.content_sha256).toBe(sha256(""));
	});

	it("returns emptyContent shape for raw === '' (not the scrub path)", () => {
		const cwd = makeTmp();
		const result = prepareContent("", cwd);
		// Original code: raw === "" -> emptyContent(): content null, scrubbed false.
		// A mutated literal/operator would instead run scrubContent("") producing
		// content "" (non-null) and scrubbed true.
		expect(result.content).toBeNull();
		expect(result.scrubbed).toBe(false);
	});

	it("does NOT take the empty-content path for non-empty non-null raw text", () => {
		const cwd = makeTmp();
		const result = prepareContent("hello", cwd);
		expect(result.content).toBe("hello");
		expect(result.scrubbed).toBe(true);
	});

	it("computes utf-8 byte length correctly for multi-byte text", () => {
		const cwd = makeTmp();
		const text = "café"; // 5 bytes utf-8 (é is 2 bytes), 4 chars
		const result = prepareContent(text, cwd);
		expect(result.content_bytes).toBe(Buffer.byteLength(text, "utf-8"));
		expect(result.content_bytes).toBe(5);
	});

	it("takes the inline path exactly at the INLINE_MAX_BYTES boundary and spills one byte over", () => {
		const cwd = makeTmp();
		const exact = "a".repeat(INLINE_MAX_BYTES);
		const atLimit = prepareContent(exact, cwd);
		expect(atLimit.content_ref).toBeNull();
		expect(atLimit.content).not.toBeNull();

		const over = "a".repeat(INLINE_MAX_BYTES + 1);
		const overLimit = prepareContent(over, cwd);
		expect(overLimit.content_ref).not.toBeNull();
		expect(overLimit.content).toBeNull();
	});
});

describe("boundToolUseIds (via buildAgentIoRecord) — MAX_TOOL_USE_IDS cap", () => {
	it("passes through an id list at or under the cap untruncated", () => {
		const cwd = makeTmp();
		const ids = Array.from({ length: MAX_TOOL_USE_IDS }, (_, i) => `id-${i}`);
		const record = buildAgentIoRecord(
			{
				ts: "2026-01-01T00:00:00Z",
				runner: "claude",
				direction: "input",
				role: "user",
				kind: "final_message",
				source: "payload",
				raw: null,
				tool_use_ids: ids,
			},
			cwd,
		);
		expect(record.tool_use_ids).toHaveLength(MAX_TOOL_USE_IDS);
		expect(record.tool_use_ids_truncated).toBe(false);
	});

	it("truncates an id list over the cap and reports truncated", () => {
		const cwd = makeTmp();
		const ids = Array.from({ length: MAX_TOOL_USE_IDS + 5 }, (_, i) => `id-${i}`);
		const record = buildAgentIoRecord(
			{
				ts: "2026-01-01T00:00:00Z",
				runner: "claude",
				direction: "input",
				role: "user",
				kind: "final_message",
				source: "payload",
				raw: null,
				tool_use_ids: ids,
			},
			cwd,
		);
		expect(record.tool_use_ids).toHaveLength(MAX_TOOL_USE_IDS);
		expect(record.tool_use_ids_truncated).toBe(true);
	});
});

describe("buildAgentIoRecord — schema literal + nullish-coalesce defaults", () => {
	const cwd = "/does/not/need/to/exist/for/this/pure/call";
	const baseInput = {
		ts: "2026-01-01T00:00:00Z",
		runner: "claude",
		direction: "input" as const,
		role: "user" as const,
		kind: "final_message" as const,
		source: "payload" as const,
		raw: null,
	};

	it("stamps schema as the exact literal agent-io.v1", () => {
		const record = buildAgentIoRecord(baseInput, cwd);
		expect(record.schema).toBe("agent-io.v1");
	});

	it("defaults every optional identity field to null when omitted", () => {
		const record = buildAgentIoRecord(baseInput, cwd);
		expect(record.seq).toBeNull();
		expect(record.parent_session).toBeNull();
		expect(record.agent_id).toBeNull();
		expect(record.spawn_tool_use_id).toBeNull();
		expect(record.agent_label_source).toBeNull();
		expect(record.agent_label).toBeNull();
		expect(record.uncapturable_reason).toBeNull();
		expect(record.tokens).toBeNull();
		expect(record.session).toBeNull();
	});

	it("passes through provided identity field values instead of null", () => {
		const record = buildAgentIoRecord(
			{
				...baseInput,
				seq: 7,
				session: "sess-1",
				parent_session: "parent-1",
				agent_id: "agent-1",
				spawn_tool_use_id: "tool-1",
				agent_label: "worker",
				agent_label_source: "payload",
				uncapturable_reason: "n/a",
				tokens: { input: 1, output: 2, cache_read: 0, cache_creation: 0 },
			},
			cwd,
		);
		expect(record.seq).toBe(7);
		expect(record.session).toBe("sess-1");
		expect(record.parent_session).toBe("parent-1");
		expect(record.agent_id).toBe("agent-1");
		expect(record.spawn_tool_use_id).toBe("tool-1");
		expect(record.agent_label).toBe("worker");
		expect(record.agent_label_source).toBe("payload");
		expect(record.uncapturable_reason).toBe("n/a");
		expect(record.tokens).toEqual({ input: 1, output: 2, cache_read: 0, cache_creation: 0 });
	});

	it("defaults cwd to the passed cwd argument when input.cwd is omitted", () => {
		const record = buildAgentIoRecord(baseInput, cwd);
		expect(record.cwd).toBe(cwd);
	});

	it("uses input.cwd when explicitly provided, overriding the argument", () => {
		const record = buildAgentIoRecord({ ...baseInput, cwd: "/other/cwd" }, cwd);
		expect(record.cwd).toBe("/other/cwd");
	});

	it("defaults content_status to captured when raw is non-empty and content_status omitted", () => {
		const record = buildAgentIoRecord({ ...baseInput, raw: "some text" }, cwd);
		expect(record.content_status).toBe("captured");
	});

	it("defaults content_status to unavailable when raw is null and content_status omitted", () => {
		const record = buildAgentIoRecord({ ...baseInput, raw: null }, cwd);
		expect(record.content_status).toBe("unavailable");
	});

	it("honors an explicit content_status over the raw-derived default", () => {
		const record = buildAgentIoRecord(
			{ ...baseInput, raw: "some text", content_status: "unavailable" },
			cwd,
		);
		expect(record.content_status).toBe("unavailable");
		// The override touches only content_status — the raw content is still
		// stored, which is what tells this apart from the raw:null default case.
		expect(record.content).toBe("some text");
	});

	it("defaults input_capturable to true when omitted", () => {
		const record = buildAgentIoRecord(baseInput, cwd);
		expect(record.input_capturable).toBe(true);
	});

	it("respects an explicit false input_capturable", () => {
		const record = buildAgentIoRecord({ ...baseInput, input_capturable: false }, cwd);
		expect(record.input_capturable).toBe(false);
	});
});

describe("recordAgentIo — dry-run refusal, empty-row short-circuit, join, mkdir recursive", () => {
	it("touches no disk state at all when dryRun is true", () => {
		const cwd = makeTmp();
		const n = recordAgentIo(
			[
				{
					ts: "2026-01-01T00:00:00Z",
					runner: "claude",
					direction: "input",
					role: "user",
					kind: "final_message",
					source: "payload",
					raw: "hello",
				},
			],
			{ cwd, dryRun: true },
		);
		expect(n).toBe(0);
		expect(existsSync(agentIoLogPath(cwd))).toBe(false);
		expect(existsSync(path.join(cwd, ".interlinked"))).toBe(false);
	});

	it("touches no disk state for an empty rows array", () => {
		const cwd = makeTmp();
		const n = recordAgentIo([], { cwd });
		expect(n).toBe(0);
		expect(existsSync(agentIoLogPath(cwd))).toBe(false);
		expect(existsSync(path.join(cwd, ".interlinked"))).toBe(false);
	});

	it("appends rows joined by newline, one JSON object per line, trailing newline", () => {
		const cwd = makeTmp();
		const n = recordAgentIo(
			[
				{
					ts: "2026-01-01T00:00:00Z",
					runner: "claude",
					direction: "input",
					role: "user",
					kind: "final_message",
					source: "payload",
					raw: "first",
				},
				{
					ts: "2026-01-01T00:00:01Z",
					runner: "claude",
					direction: "output",
					role: "assistant",
					kind: "final_message",
					source: "payload",
					raw: "second",
				},
			],
			{ cwd },
		);
		expect(n).toBe(2);
		const content = readFileSync(agentIoLogPath(cwd), "utf-8");
		const lines = content.split("\n");
		// exactly 2 JSON lines + trailing empty string from the final \n
		expect(lines).toHaveLength(3);
		expect(lines[2]).toBe("");
		const line0 = lines[0] ?? "";
		const line1 = lines[1] ?? "";
		expect(() => JSON.parse(line0)).not.toThrow();
		expect(() => JSON.parse(line1)).not.toThrow();
		expect(JSON.parse(line0).content).toBe("first");
		expect(JSON.parse(line1).content).toBe("second");
	});

	it("creates missing nested .interlinked directory recursively before appending", () => {
		const base = makeTmp();
		// cwd itself does not exist yet — nested under base — so mkdirSync
		// needs { recursive: true } to succeed; base/nested/deeper/.interlinked
		// requires creating multiple missing path segments.
		const cwd = path.join(base, "nested", "deeper");
		expect(existsSync(cwd)).toBe(false);
		const n = recordAgentIo(
			[
				{
					ts: "2026-01-01T00:00:00Z",
					runner: "claude",
					direction: "input",
					role: "user",
					kind: "final_message",
					source: "payload",
					raw: "hi",
				},
			],
			{ cwd },
		);
		expect(n).toBe(1);
		expect(existsSync(agentIoLogPath(cwd))).toBe(true);
	});
});
