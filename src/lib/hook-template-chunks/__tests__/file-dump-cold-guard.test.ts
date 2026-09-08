// Corpus + codegen test for the shared cold-fallback file-dump guard
// (`src/lib/hook-template-chunks/file-dump-cold-guard.ts`).
//
// The guard used to live only as JS inside the generated-hook template string,
// with five helpers nested inside one 250-line function — untestable except
// through `new Function(GUARDS_INLINE_CHUNK)`. It is now free-standing TS whose
// serialized source the .mjs embeds, so this file pins both the behavior and
// the `Function.prototype.toString()` round-trip invariant.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkFileDumpCold,
	type ColdDumpDeps,
	FILE_DUMP_COLD_GUARD_SOURCE,
} from "../file-dump-cold-guard.js";
import type { ColdWriteVerdict } from "../cold-write-guards.js";

const DEPS: ColdDumpDeps = { existsSync, statSync, readFileSync, join };

type DumpFn = (
	toolName: string,
	toolInput: Record<string, unknown>,
	cwd: string,
	deps: ColdDumpDeps,
) => ColdWriteVerdict | null;

let dir: string;

function writeBytes(name: string, bytes: number): string {
	const p = join(dir, name);
	writeFileSync(p, "x".repeat(bytes));
	return p;
}

function writeLines(name: string, lineCount: number): string {
	const p = join(dir, name);
	writeFileSync(p, "x\n".repeat(lineCount));
	return p;
}

function run(command: string): ColdWriteVerdict | null {
	return checkFileDumpCold("Bash", { command }, dir, DEPS);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cold-file-dump-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("checkFileDumpCold — positive (must fire)", () => {
	it("P1: blocks foreground `tail -f`", () => {
		const p = writeBytes("foo.log", 100);
		const v = run(`tail -f ${p}`);
		expect(v?.decision).toBe("block");
		expect(v?.rule_id).toBe("inline-tail-follow-foreground");
	});

	it("P2: blocks an unfiltered dump of a file over 100KB", () => {
		const p = writeBytes("big.log", 200 * 1024);
		const v = run(`cat ${p}`);
		expect(v?.rule_id).toBe("inline-file-dump-large-file");
		expect(v?.reason).toContain("200KB");
	});

	it("P3: blocks a requested line count over the 200-line cap", () => {
		const p = writeBytes("foo", 1024);
		expect(run(`head -n 300 ${p}`)?.rule_id).toBe("inline-file-dump-too-many-lines");
	});

	it("P4: blocks bare `cat` of a file with more than 200 lines", () => {
		const p = writeLines("foo", 300);
		expect(run(`cat ${p}`)?.rule_id).toBe("inline-file-dump-too-many-lines");
	});

	it("P5: resolves a RELATIVE path against cwd", () => {
		writeBytes("rel.log", 200 * 1024);
		expect(run("cat rel.log")?.rule_id).toBe("inline-file-dump-large-file");
	});
});

describe("checkFileDumpCold — negative (must not fire)", () => {
	it("N1: allows a backgrounded `tail -f`", () => {
		const p = writeBytes("foo.log", 100);
		expect(run(`tail -f ${p} &`)).toBeNull();
	});

	it("N2: allows a large dump piped through a filter", () => {
		const p = writeBytes("big.log", 200 * 1024);
		expect(run(`cat ${p} | jq '.x'`)).toBeNull();
	});

	it("N3: allows a redirected dump", () => {
		const p = writeBytes("big.log", 200 * 1024);
		expect(run(`cat ${p} > out.txt`)).toBeNull();
	});

	it("N4: allows a byte slice (`head -c`) of a large file", () => {
		const p = writeBytes("big.log", 200 * 1024);
		expect(run(`head -c 5000 ${p}`)).toBeNull();
	});

	it("N5: allows globs and variable substitution (unresolvable targets)", () => {
		expect(run("cat *.log")).toBeNull();
		expect(run("cat $FILE")).toBeNull();
	});

	it("N6: allows non-dump commands and non-Bash tools", () => {
		expect(run("ls -la")).toBeNull();
		expect(checkFileDumpCold("Read", {}, dir, DEPS)).toBeNull();
	});

	it("N7: allows a bounded `tail -n 10` when the host supplied no filesystem functions", () => {
		// Pre-convergence parity: with no way to size the file, a bare `cat`
		// falls back to the conservative unknown (Infinity lines) and BLOCKS,
		// while a command whose own flags bound the output still passes.
		writeBytes("big.log", 200 * 1024);
		const empty: ColdDumpDeps = { existsSync: null, statSync: null, readFileSync: null, join: null };
		expect(checkFileDumpCold("Bash", { command: "tail -n 10 big.log" }, dir, empty)).toBeNull();
		expect(checkFileDumpCold("Bash", { command: "cat big.log" }, dir, empty)?.rule_id).toBe(
			"inline-file-dump-too-many-lines",
		);
	});
});

describe("FILE_DUMP_COLD_GUARD_SOURCE — embeddable into the .mjs", () => {
	it("reconstructs and agrees with the imported function", () => {
		// SAFETY: FILE_DUMP_COLD_GUARD_SOURCE serializes checkFileDumpCold; the returned named export is checked against the imported guard over the corpus below.
		const rebuilt = new Function(
			`"use strict"; ${FILE_DUMP_COLD_GUARD_SOURCE}; return checkFileDumpCold;`,
		)() as DumpFn;
		const big = writeBytes("big.log", 200 * 1024);
		const small = writeLines("small.log", 10);
		const corpus = [
			`tail -f ${big}`,
			`cat ${big}`,
			`cat ${big} | grep x`,
			`head -n 300 ${small}`,
			`cat ${small}`,
			"ls -la",
			"cat *.log",
		];
		for (const cmd of corpus) {
			expect(rebuilt("Bash", { command: cmd }, dir, DEPS), cmd).toEqual(
				checkFileDumpCold("Bash", { command: cmd }, dir, DEPS),
			);
		}
	});

	it("contains no backtick or `${` so it splices into any string context", () => {
		expect(FILE_DUMP_COLD_GUARD_SOURCE).not.toContain("`");
		expect(FILE_DUMP_COLD_GUARD_SOURCE).not.toContain("${");
	});
});
