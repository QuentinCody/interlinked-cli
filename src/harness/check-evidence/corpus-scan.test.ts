// Tests for the corpus dogfood scanner.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CheckRegistration, InlineMatch } from "../check-registry/types.js";
import { EMPTY_CORPUS } from "./corpus.js";
import { loadCorpusStore, recordCorpusScan, saveCorpusStore, scanCorpus } from "./corpus-scan.js";

let root: string;

function write(rel: string, content: string): void {
	const full = join(root, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content, "utf8");
}

/** Detector that flags any line containing `eval(`. */
function detectEval(content: string): InlineMatch[] {
	return content
		.split("\n")
		.map((text, i) => ({ text: text.trim(), line: i + 1 }))
		.filter((l) => l.text.includes("eval("));
}

function check(fn: (c: string, p: string) => InlineMatch[] = detectEval): CheckRegistration {
	return {
		id: "eval_usage",
		name: "Eval",
		description: "d",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		phase: "pre_block",
		fix_instruction: "no eval",
		fn,
		resultsPropName: "evalUsage",
	} as CheckRegistration;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cec-scan-"));
	mkdirSync(join(root, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("scanCorpus — positive (must produce hits)", () => {
	it("P1: finds a hit in a plain source file", () => {
		write("src/a.ts", "const x = 1;\neval(danger);\n");
		const r = scanCorpus(check(), join(root, "src"), root);
		expect(r.hits).toHaveLength(1);
		expect(r.hits[0]?.file).toBe(join("src", "a.ts"));
		expect(r.hits[0]?.line).toBe(2);
	});

	it("P2: scans every scannable extension", () => {
		write("src/a.ts", "eval(1)");
		write("src/b.jsx", "eval(2)");
		write("src/c.mjs", "eval(3)");
		expect(scanCorpus(check(), join(root, "src"), root).hits).toHaveLength(3);
	});

	it("P3: records a detector crash instead of swallowing it", () => {
		write("src/a.ts", "anything");
		const boom = check(() => {
			throw new Error("detector exploded");
		});
		const r = scanCorpus(boom, join(root, "src"), root);
		expect(r.failures).toHaveLength(1);
		expect(r.failures[0]?.message).toMatch(/exploded/);
		expect(r.hits).toEqual([]);
	});

	it("P4: one crashing file does not stop the scan", () => {
		write("src/good.ts", "eval(1)");
		write("src/bad.ts", "BOOM");
		const flaky = check((content) => {
			if (content === "BOOM") throw new Error("nope");
			return detectEval(content);
		});
		const r = scanCorpus(flaky, join(root, "src"), root);
		expect(r.hits).toHaveLength(1);
		expect(r.failures).toHaveLength(1);
	});
});

describe("scanCorpus — negative (must NOT count)", () => {
	it("N1: skips test files, which deliberately contain the pattern", () => {
		write("src/a.test.ts", "eval(1)");
		write("src/a.spec.tsx", "eval(2)");
		const r = scanCorpus(check(), join(root, "src"), root);
		expect(r.hits).toEqual([]);
		expect(r.files_scanned).toBe(0);
	});

	it("N2: skips __fixtures__ trees", () => {
		write("src/__fixtures__/bad.ts", "eval(1)");
		expect(scanCorpus(check(), join(root, "src"), root).hits).toEqual([]);
	});

	it("N3: skips declaration files and non-code extensions", () => {
		write("src/a.d.ts", "eval(1)");
		write("src/notes.md", "eval(1)");
		expect(scanCorpus(check(), join(root, "src"), root).files_scanned).toBe(0);
	});

	it("N4: a clean tree yields zero hits but a non-zero scan count", () => {
		write("src/a.ts", "const safe = 1;");
		const r = scanCorpus(check(), join(root, "src"), root);
		expect(r.hits).toEqual([]);
		expect(r.files_scanned).toBe(1);
	});

	it("N5: a file the scanner cannot read is skipped, not crashed on or counted", () => {
		write("src/good.ts", "eval(1)");
		write("src/denied.ts", "eval(2)");
		chmodSync(join(root, "src/denied.ts"), 0o000);
		const r = scanCorpus(check(), join(root, "src"), root);
		// If the read failure were left uncaught, this call would throw
		// instead of returning; if it were miscounted as scanned, this
		// would read 2 instead of 1. afterEach's rmSync({force:true}) removes
		// the unreadable file without needing its permissions restored.
		expect(r.hits).toHaveLength(1);
		expect(r.hits[0]?.file).toBe(join("src", "good.ts"));
		expect(r.files_scanned).toBe(1);
	});
});

describe("corpus store round-trip", () => {
	it("returns an empty store when none is committed", () => {
		expect(loadCorpusStore(root)).toEqual(EMPTY_CORPUS);
	});

	it("saves and reloads a store", () => {
		saveCorpusStore(root, {
			version: 1,
			checks: { c: { files_scanned: 2, hits: ["a"], adjudications: { a: { verdict: "true_positive" } } } },
		});
		expect(loadCorpusStore(root).checks.c?.hits).toEqual(["a"]);
	});

	it("fails closed on a malformed store", () => {
		write(".interlinked/check-corpus.json", "{ broken");
		expect(loadCorpusStore(root)).toEqual(EMPTY_CORPUS);
	});
});

describe("recordCorpusScan", () => {
	it("folds a fresh scan into the store", () => {
		write("src/a.ts", "eval(1)");
		const { store, record } = recordCorpusScan(EMPTY_CORPUS, check(), join(root, "src"), root);
		expect(record.hits).toHaveLength(1);
		expect(store.checks.eval_usage).toBe(record);
	});

	it("preserves a prior adjudication across a re-scan", () => {
		write("src/a.ts", "eval(1)");
		const first = recordCorpusScan(EMPTY_CORPUS, check(), join(root, "src"), root);
		const sig = first.record.hits[0] as string;
		first.store.checks.eval_usage = {
			...first.record,
			adjudications: { [sig]: { verdict: "false_positive", note: "in a comment" } },
		};
		const second = recordCorpusScan(first.store, check(), join(root, "src"), root);
		expect(second.record.adjudications[sig]?.verdict).toBe("false_positive");
	});

	it("leaves other checks' records untouched", () => {
		write("src/a.ts", "eval(1)");
		const seed = { version: 1 as const, checks: { other: { files_scanned: 1, hits: [], adjudications: {} } } };
		const { store } = recordCorpusScan(seed, check(), join(root, "src"), root);
		expect(store.checks.other).toBeDefined();
	});
});
