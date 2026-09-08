// ===========================================
// Inline-hook fallback — file-dump output budget
// ===========================================
// Regression parity: the inline fallback baked into the generated
// `.interlinked/hooks/interlinked-activity.mjs` must apply the same
// tail/head/cat output-budget rule as the harness daemon. When the daemon
// is down (the cold-fallback case the e2e probes already pin), the inline
// guard is the only thing standing between an agent and a 25k-token dump
// from `cat huge.jsonl`. Tests the EXACT runtime function evaluated from
// the chunk source, following the pattern in `guards-inline-graph-shard.test.ts`.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUARDS_INLINE_CHUNK } from "../guards-inline.js";

interface GuardDecision {
	decision: string;
	reason?: string;
	rule_id?: string;
	severity?: string;
	category?: string;
}

type InlineFn = (
	hookEvent: string,
	toolName: string,
	toolInput: Record<string, unknown>,
) => GuardDecision | null;

function buildRuntimeInlineGuard(): InlineFn {
	// SAFETY: argument names bind the exact fs imports referenced by GUARDS_INLINE_CHUNK, which declares the returned inlineGuardCheck; the suite exercises its verdicts.
	const factory = new Function(
		"existsSync",
		"statSync",
		"readFileSync",
		`${GUARDS_INLINE_CHUNK}\nreturn inlineGuardCheck;`,
	) as (
		e: typeof existsSync,
		s: typeof statSync,
		r: typeof readFileSync,
	) => InlineFn;
	return factory(existsSync, statSync, readFileSync);
}

let dir: string;
// SPY, not process.chdir(): chdir THROWS in a worker thread ("process.chdir()
// is not supported in workers"), and Stryker's vitest runner pins its own
// pool, so a real chdir here fails the mutation dry run for any file whose
// graph-selected test scope includes this one. All paths passed into the
// inline guard in this file are already absolute (`join(dir, name)`), so the
// generated code's `resolve(process.cwd(), t)` fallback is never exercised
// on a relative path here — the spy just keeps `process.cwd()` from drifting.
let cwdSpy: ReturnType<typeof vi.spyOn>;

function writeFile(name: string, bytes: number): string {
	const p = join(dir, name);
	writeFileSync(p, "x".repeat(bytes));
	return p;
}

function writeFileLines(name: string, lineCount: number): string {
	const p = join(dir, name);
	writeFileSync(p, "x\n".repeat(lineCount));
	return p;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "inline-file-dump-"));
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(() => {
	cwdSpy.mockRestore();
	rmSync(dir, { recursive: true, force: true });
});

describe("inlineFileDumpCheck — `tail -f` foreground", () => {
	it("blocks `tail -f foo.log` in foreground", () => {
		const p = writeFile("foo.log", 100);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `tail -f ${p}` });
		expect(r?.decision).toBe("block");
		expect(r?.rule_id).toBe("inline-tail-follow-foreground");
	});

	it("blocks `tail -F foo.log` (capital -F)", () => {
		const p = writeFile("foo.log", 100);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `tail -F ${p}` });
		expect(r?.decision).toBe("block");
	});

	it("allows `tail -f foo.log &` (backgrounded)", () => {
		const p = writeFile("foo.log", 100);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `tail -f ${p} &` });
		expect(r).toBeNull();
	});

	it("allows `nohup tail -f foo.log` (nohup detaches)", () => {
		const p = writeFile("foo.log", 100);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `nohup tail -f ${p}` });
		expect(r).toBeNull();
	});
});

describe("inlineFileDumpCheck — file size cap", () => {
	it("blocks `cat big.log` when file > 100KB and no filter", () => {
		const p = writeFile("big.log", 200 * 1024);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `cat ${p}` });
		expect(r?.decision).toBe("block");
		expect(r?.rule_id).toBe("inline-file-dump-large-file");
		expect(r?.reason).toContain("200KB");
	});

	it("allows `cat small.txt` (under 100KB)", () => {
		const p = writeFile("small.txt", 4 * 1024);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `cat ${p}` });
		expect(r).toBeNull();
	});

	it("allows `cat big.log | jq` (filter present)", () => {
		const p = writeFile("big.log", 200 * 1024);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `cat ${p} | jq '.x'` });
		expect(r).toBeNull();
	});

	it("allows `cat big.log > out.txt` (redirect)", () => {
		const p = writeFile("big.log", 200 * 1024);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `cat ${p} > out.txt` });
		expect(r).toBeNull();
	});
});

describe("inlineFileDumpCheck — line-count cap", () => {
	// Cap raised 50 → 200 (2026-07-24, mirrored from evaluator/file-dump-guard):
	// July telemetry showed bare `cat` of 76–106-line files blocked for no
	// budget win. These pins track the 200-line cap.
	it("blocks `head -n 300 foo` over the 200-line cap", () => {
		const p = writeFile("foo", 1024);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `head -n 300 ${p}` });
		expect(r?.decision).toBe("block");
		expect(r?.rule_id).toBe("inline-file-dump-too-many-lines");
	});

	it("blocks `tail -n 500 foo` well over the cap", () => {
		const p = writeFile("foo", 1024);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `tail -n 500 ${p}` });
		expect(r?.decision).toBe("block");
	});

	it("blocks `cat foo` when the file has > 200 lines (no filter)", () => {
		const p = writeFileLines("foo", 300);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `cat ${p}` });
		expect(r?.decision).toBe("block");
		expect(r?.rule_id).toBe("inline-file-dump-too-many-lines");
	});

	it("allows `cat foo` when the file has ≤ 200 lines (the July-telemetry friction case)", () => {
		const p = writeFileLines("foo", 100);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `cat ${p}` });
		expect(r).toBeNull();
	});

	it("allows `tail -n 200 foo` (exactly at the cap)", () => {
		const p = writeFile("foo", 1024);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `tail -n 200 ${p}` });
		expect(r).toBeNull();
	});

	it("allows `tail -n 10 foo` (default line count)", () => {
		const p = writeFile("foo", 1024);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `tail ${p}` });
		expect(r).toBeNull();
	});

	it("allows `tail -n 100 foo | grep INFO` (filter present)", () => {
		const p = writeFile("foo", 1024);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `tail -n 100 ${p} | grep INFO` });
		expect(r).toBeNull();
	});

	it("allows `head -c 5000 big.log` (byte slice = filter-equivalent)", () => {
		const p = writeFile("big.log", 200 * 1024);
		const fn = buildRuntimeInlineGuard();
		const r = fn("PreToolUse", "Bash", { command: `head -c 5000 ${p}` });
		expect(r).toBeNull();
	});
});

describe("inlineFileDumpCheck — fail-open on uncertain inputs", () => {
	it("allows `cat *.log` (glob)", () => {
		const fn = buildRuntimeInlineGuard();
		expect(fn("PreToolUse", "Bash", { command: "cat *.log" })).toBeNull();
	});

	it("allows `cat $FILE` (variable substitution)", () => {
		const fn = buildRuntimeInlineGuard();
		expect(fn("PreToolUse", "Bash", { command: "cat $FILE" })).toBeNull();
	});

	it("allows non-dump commands (ls, git status, npm test)", () => {
		const fn = buildRuntimeInlineGuard();
		expect(fn("PreToolUse", "Bash", { command: "ls -la" })).toBeNull();
		expect(fn("PreToolUse", "Bash", { command: "git status" })).toBeNull();
		expect(fn("PreToolUse", "Bash", { command: "npm test" })).toBeNull();
	});
});

describe("inlineFileDumpCheck — gate guards", () => {
	it("returns null for non-Bash tools", () => {
		const fn = buildRuntimeInlineGuard();
		expect(fn("PreToolUse", "Read", { file_path: "/x" })).toBeNull();
		expect(fn("PreToolUse", "Edit", { file_path: "/x" })).toBeNull();
	});

	it("returns null for PostToolUse (PreToolUse-only gate)", () => {
		const p = writeFile("big.log", 200 * 1024);
		const fn = buildRuntimeInlineGuard();
		expect(fn("PostToolUse", "Bash", { command: `cat ${p}` })).toBeNull();
	});
});
