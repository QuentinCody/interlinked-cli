// Mutation-kill wave 31 for anchor-liveness.ts. Each case targets one or more
// surviving mutantIds from .interlinked/mutation-manifest.json (see receipts
// at scratch/fleet-r3/receipts/anchor-liveness.jsonl). Companion coverage
// lives in anchor-liveness.test.ts — this file adds only what's needed to
// distinguish specific mutants that file's happy-path cases don't reach.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureAnchor, classifyAnchor } from "./anchor-liveness.js";
import { type Finding, makeFinding } from "./corpus.js";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));
import { execSync } from "node:child_process";
const mockExecSync = vi.mocked(execSync);

let dir: string;
let file: string;
let fakeHome: string;
let prevInterlinkedHome: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "anchor-kill-w31-"));
	file = join(dir, "mod.ts");
	prevInterlinkedHome = process.env.INTERLINKED_HOME;
	fakeHome = mkdtempSync(join(tmpdir(), "anchor-kill-w31-home-"));
	process.env.INTERLINKED_HOME = fakeHome;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(fakeHome, { recursive: true, force: true });
	if (prevInterlinkedHome === undefined) delete process.env.INTERLINKED_HOME;
	else process.env.INTERLINKED_HOME = prevInterlinkedHome;
});

function findingAt(f: string, line: number): Finding {
	return makeFinding(
		{
			bug_class: "kill_w31",
			message: "m",
			file: f,
			line,
			source_runner: "w31",
			now: "2026-07-17T00:00:00.000Z",
		},
		dir,
	);
}

/** Mirrors hashSpan's normalization exactly, only so out-of-range-line
 *  fixtures (which captureAnchor itself refuses to anchor) can hand-craft a
 *  matching anchor_span_sha256 for a guard-bypass scenario. */
function refHashSpan(lines: string[]): string {
	const normalized = lines.map((l) => l.replace(/[ \t\r]+$/, "")).join("\n");
	return createHash("sha256").update(normalized).digest("hex");
}

describe("hashSpan join separator", () => {
	// test-contract: boundary — kills mutantId 84c3c0a68e11582a (hashSpan join "\n" -> "")
	it("distinguishes concatenations that only collide without the newline separator", () => {
		const fileX = join(dir, "x.ts");
		const fileY = join(dir, "y.ts");
		writeFileSync(fileX, "header\na  b\nfooter");
		writeFileSync(fileY, "head\nera  b\nfooter");
		const fx = captureAnchor(findingAt(fileX, 2), dir);
		const fy = captureAnchor(findingAt(fileY, 2), dir);
		expect(fx.anchor_span_sha256).not.toBe(fy.anchor_span_sha256);
	});
});

describe("hashSpan trailing-whitespace trim", () => {
	// test-contract: boundary — kills mutantIds 7b148659f5cdd4f8, 26ba1a8b7343def5,
	// 1665d5ca4da8d517 (regex variants) and dc824fe73417c7a3 (replacement text)
	it("normalizes only trailing whitespace, preserving internal spacing", () => {
		const fileA = join(dir, "a.ts");
		const fileB = join(dir, "b.ts");
		writeFileSync(fileA, "header\na  b   \nfooter");
		writeFileSync(fileB, "header\na  b\nfooter");
		const fa = captureAnchor(findingAt(fileA, 2), dir);
		const fb = captureAnchor(findingAt(fileB, 2), dir);
		expect(fa.anchor_span_sha256).toBe(fb.anchor_span_sha256);
	});
});

describe("offsetInWindow", () => {
	// test-contract: boundary — kills mutantId 10e8f42f61352c50 (offsetInWindow line-1 -> line+1)
	it("relocates the anchor's own offset correctly when the window starts clamped at line 1", () => {
		writeFileSync(file, "L1\nL2\nL3");
		const f = captureAnchor(findingAt(file, 1), dir);
		writeFileSync(file, "NEWLINE\nL1\nL2\nL3");
		expect(classifyAnchor(f, dir)).toEqual({ state: "moved", newLine: 2 });
	});
});

describe("treeStamp execSync command + options", () => {
	beforeEach(() => {
		mockExecSync.mockReset();
		const impl = (cmd: string, opts?: unknown) => {
			const expectedOpts = JSON.stringify({ cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
			if (cmd === "git rev-parse HEAD" && JSON.stringify(opts) === expectedOpts) {
				return Buffer.from("abc123\n");
			}
			if (cmd === "git status --porcelain" && JSON.stringify(opts) === expectedOpts) {
				return Buffer.from("");
			}
			throw new Error(`unexpected execSync call: ${cmd} ${JSON.stringify(opts)}`);
		};
		// The cast mirrors node:child_process's overloaded execSync test-double boundary.
		mockExecSync.mockImplementation(impl);
	});

	// test-contract: boundary — treeStamp must call execSync with the exact command and stdio config (kills bc7a3383d77d6334, 5177a2837e3b3329, 481c079792583588, 4c2fc719b8768741, 8e1bb1f34c5072e3, 65a393cedbb3b29c, 62a2d9204e7d3355, de21421a861bf874)
	it("stamps a clean tree using the exact command + cwd + stdio config", () => {
		writeFileSync(file, "content");
		const f = captureAnchor(findingAt(file, 1), dir);
		expect(f.anchor_tree).toBe("abc123");
	});
});

describe("captureAnchor guard branches", () => {
	// test-contract: boundary — kills mutantIds 7adc5c35b7767b06 (|| -> &&),
	// 42af90dcbc4da623 (line<1 -> false), ea56c8a8c541c94a (whole cond -> false)
	it("still anchors nothing when the file is present but the line is negative", () => {
		writeFileSync(file, "one\ntwo\nthree");
		expect(captureAnchor(findingAt(file, -1), dir).anchor_span_sha256).toBeUndefined();
	});

	// test-contract: boundary — kills mutantId e1319b680542fc34 (line>length -> line>=length)
	it("anchors the last valid line but not one past EOF", () => {
		writeFileSync(file, "one\ntwo\nthree");
		expect(captureAnchor(findingAt(file, 3), dir).anchor_span_sha256).toBeDefined();
		expect(captureAnchor(findingAt(file, 4), dir).anchor_span_sha256).toBeUndefined();
	});
});

describe("findContextMatches tail boundary", () => {
	// test-contract: boundary — kills mutantId 6dc4bdb0f45ff88d (i+len<=length -> i+len<length)
	it("relocates a match that starts at the very last valid window position", () => {
		writeFileSync(file, "A\nB\nC");
		const f = captureAnchor(findingAt(file, 2), dir);
		writeFileSync(file, "p0\np1\np2\nA\nB\nC");
		expect(classifyAnchor(f, dir)).toEqual({ state: "moved", newLine: 5 });
	});
});

describe("exactEq must be tried before the trimmed fallback", () => {
	// test-contract: boundary — kills mutantIds 48f4bb315fe0c985 (a===b -> false),
	// 255fe327e295026b (arrow body -> () => undefined)
	it("prefers the unique exact match over an ambiguous trimmed one", () => {
		writeFileSync(file, "one\n  TARGET\nthree");
		const f = captureAnchor(findingAt(file, 2), dir);
		writeFileSync(
			file,
			["pad1", "one", "  TARGET", "three", "pad2", "one", "    TARGET", "three", "pad3"].join(
				"\n",
			),
		);
		expect(classifyAnchor(f, dir)).toEqual({ state: "moved", newLine: 3 });
	});
});

describe("classifyAnchor unverified guard", () => {
	// test-contract: boundary — kills mutantId 6697cd8497dee23d (|| -> && on the first two operands)
	it("stays unverified when the hash is missing even though context+file are present", () => {
		writeFileSync(file, "one\ntwo\nthree");
		const base = findingAt(file, 2);
		const f: Finding = { ...base, anchor_context: ["one", "two", "three"], anchor_span_sha256: undefined };
		expect(classifyAnchor(f, dir)).toEqual({ state: "unverified" });
	});
});

describe("classifyAnchor low-boundary guard (finding.line >= 1)", () => {
	// test-contract: boundary — kills mutantIds 944d89a5559146cc (>=1 -> >1),
	// 8c29b59cc38ca64e (>=1 -> <1), dd30c848b4152bec (whole cond -> false)
	it("keeps the fast live-path authoritative at line 1 despite duplicate content elsewhere", () => {
		writeFileSync(file, "AA\nBB\nAA\nBB\ntail");
		const f = captureAnchor(findingAt(file, 1), dir);
		expect(classifyAnchor(f, dir)).toEqual({ state: "live" });
	});

	// test-contract: boundary — kills mutantIds 2bb6fb1b360de192 (>=1 -> true),
	// 9e17fca7b7941f40 (&& -> ||), 4d9ea4f609f74ecc (whole cond -> true)
	it("does not let the fast live-path fire for an out-of-range low line", () => {
		writeFileSync(file, "SOLO\nCTX_A\nCTX_B\nfiller");
		const base = findingAt(file, 0);
		const f: Finding = {
			...base,
			anchor_context: ["CTX_A", "CTX_B"],
			anchor_span_sha256: refHashSpan(["SOLO"]),
		};
		expect(classifyAnchor(f, dir)).toEqual({ state: "moved", newLine: 1 });
	});
});

describe("classifyAnchor high-boundary guard (finding.line <= lines.length)", () => {
	// test-contract: boundary — kills mutantId 07568ccc01060adf (<=length -> true)
	it("does not let the fast live-path fire for a line past EOF", () => {
		writeFileSync(file, "one\nCTX_A\nCTX_B\nfour");
		const base = findingAt(file, 5);
		const f: Finding = {
			...base,
			anchor_context: ["CTX_A", "CTX_B"],
			anchor_span_sha256: refHashSpan(["four"]),
		};
		expect(classifyAnchor(f, dir)).toEqual({ state: "moved", newLine: 3 });
	});

	// test-contract: boundary — kills mutantIds 20c77e6963287ed9 (<=length -> <length),
	// 07a1324550e2f9ef (<=length -> >length), b34f02bb8a60afcc (if-block body
	// emptied), 225e3a5b4dc8f1de (hash-equality check -> false)
	it("keeps the fast live-path authoritative at the last line despite duplicate content elsewhere", () => {
		writeFileSync(file, "AA\nBB\nAA\nBB");
		const f = captureAnchor(findingAt(file, 4), dir);
		expect(classifyAnchor(f, dir)).toEqual({ state: "live" });
	});
});

describe("classifyAnchor same-position relocation", () => {
	// test-contract: boundary — kills mutantId 4cd4f38679c2cd28 (relocated===line -> false)
	it("treats a same-position leading-whitespace reformat as live via trimmed relocation", () => {
		writeFileSync(file, "one\n  TARGET\nthree");
		const f = captureAnchor(findingAt(file, 2), dir);
		writeFileSync(file, "one\nTARGET\nthree");
		expect(classifyAnchor(f, dir)).toEqual({ state: "live" });
	});
});
