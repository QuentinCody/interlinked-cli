import { nonNull } from "../lib/non-null.js";
// Tests for the ephemeral-write ledger: classification (the `.json` blind spot
// the placement guard never saw) and the never-throw append contract.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendEphemeralWrite,
	buildEphemeralWriteRecord,
	classifyEphemeralWrite,
} from "./ephemeral-write-log.js";

const temps: string[] = [];
const makeRoot = (withInterlinked: boolean): string => {
	const root = mkdtempSync(join(tmpdir(), "ephemeral-log-"));
	temps.push(root);
	if (withInterlinked) mkdirSync(join(root, ".interlinked"), { recursive: true });
	return root;
};

afterEach(() => {
	while (temps.length > 0) {
		const p = temps.pop();
		if (p) rmSync(p, { recursive: true, force: true });
	}
});

describe("classifyEphemeralWrite", () => {
	it("classifies code extensions", () => {
		expect(classifyEphemeralWrite("/tmp/s/scratchpad/probe.mjs")).toBe("code");
		expect(classifyEphemeralWrite("/tmp/s/scratchpad/fix.py")).toBe("code");
	});

	it("classifies the .json manifest blind spot", () => {
		expect(classifyEphemeralWrite("/tmp/s/scratchpad/def.json")).toBe("manifest");
		expect(classifyEphemeralWrite("/tmp/s/scratchpad/ci.yml")).toBe("manifest");
	});

	it("classifies captured external-agent output", () => {
		expect(classifyEphemeralWrite("/tmp/s/scratchpad/codex-review-2-result.md")).toBe(
			"agent-output",
		);
		expect(classifyEphemeralWrite("/tmp/s/scratchpad/sol-audit.md")).toBe("agent-output");
	});

	it("does not claim every markdown note is agent output", () => {
		expect(classifyEphemeralWrite("/tmp/s/scratchpad/notes.md")).toBe("other");
	});

	it("classifies bulk downloads", () => {
		expect(classifyEphemeralWrite("/tmp/s/scratchpad/pkg.tgz")).toBe("bulk");
		expect(classifyEphemeralWrite("/tmp/s/scratchpad/shot.png")).toBe("bulk");
	});

	it("falls back to other for extensionless files", () => {
		expect(classifyEphemeralWrite("/tmp/s/scratchpad/Makefile")).toBe("other");
	});
});

describe("buildEphemeralWriteRecord", () => {
	it("captures tool, byte length, extension, and blocked flag", () => {
		const rec = buildEphemeralWriteRecord({
			sessionId: "s1",
			tool: "Write",
			absPath: "/tmp/s/scratchpad/def.json",
			content: '{"a":1}',
			blocked: true,
			now: () => "2026-08-04T00:00:00.000Z",
		});
		expect(rec).toEqual({
			ts: "2026-08-04T00:00:00.000Z",
			session_id: "s1",
			tool: "Write",
			path: "/tmp/s/scratchpad/def.json",
			ext: ".json",
			bytes: 7,
			kind: "manifest",
			blocked: true,
		});
	});

	it("measures bytes, not characters", () => {
		const rec = buildEphemeralWriteRecord({
			sessionId: undefined,
			tool: "Edit",
			absPath: "/tmp/s/scratchpad/x.txt",
			content: "é",
			blocked: false,
		});
		expect(rec.bytes).toBe(2);
	});
});

describe("appendEphemeralWrite", () => {
	const record = buildEphemeralWriteRecord({
		sessionId: "s1",
		tool: "Write",
		absPath: "/tmp/s/scratchpad/a.json",
		content: "{}",
		blocked: false,
		now: () => "2026-08-04T00:00:00.000Z",
	});

	it("appends one JSON line per call", () => {
		const root = makeRoot(true);
		appendEphemeralWrite(root, record);
		appendEphemeralWrite(root, record);
		const lines = readFileSync(join(root, ".interlinked", "ephemeral-writes.jsonl"), "utf-8")
			.trim()
			.split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(nonNull(lines[0])).kind).toBe("manifest");
	});

	it("no-ops when .interlinked/ is absent rather than creating it", () => {
		const root = makeRoot(false);
		appendEphemeralWrite(root, record);
		expect(existsSync(join(root, ".interlinked"))).toBe(false);
	});

	it("never throws on an unwritable root", () => {
		const file = join(makeRoot(false), "not-a-directory");
		writeFileSync(file, "fixture");
		expect(() => appendEphemeralWrite(join(file, "nested"), record)).not.toThrow();
	});
});
