// Kill proof — adversarial review round 5: breaking the round-4 fixes and the new mechanisms
// (docs/reviews/kill-proof-review-round5.md). Every case was REPRODUCED against `mutation-proof`
// at 8cde4ff with the real `tests prove-kill` path (fixtures under /tmp/kp5) and is expected to
// FAIL until the product code is fixed: a red test is the deliverable. N<n> = the proof must not
// report this verdict / freshness / exit. Receipt cases use a scripted runner (no vitest, fast);
// the two runner cases and the CLI case run real vitest in a throwaway git repo whose
// node_modules links to this checkout's. No product code was changed.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { VitestRun } from "../fail-before-fix/index.js";
import { computeSymbolHashes, deriveIdentities } from "../mutation/identity.js";
import { applyMeasuredRun, emptyManifest, saveManifest } from "../mutation/manifest.js";
import type { RawMutant } from "../mutation/types.js";
import { MAX_BOUND_IMPORTS } from "./bound-imports.js";
import { receiptCertifies, verifyKillProof } from "./receipt-freshness.js";
import { resolveMutant } from "./resolve.js";
import { proveKill } from "./run.js";

const CHECKOUT = fileURLToPath(new URL("../../..", import.meta.url));
const NODE_MODULES = join(CHECKOUT, "node_modules");
const REAL_RUN_MS = 120_000;
const roots: string[] = [];
const strays: string[] = [];
const uniq = (): string => `${process.pid}${Date.now()}${Math.floor(Math.random() * 1e6)}`;

const SOURCE = "// helper: add two numbers\nexport function add(a: number, b: number): number {\n\treturn a + b;\n}\n";
const MINUS_FAULT = { kind: "explicit", file: "src/math.ts", find: "return a + b;", replace: "return a - b;" } as const;
const COMMENT_FAULT = { kind: "explicit", file: "src/math.ts", find: "// helper: add two numbers", replace: "// helper: add 2 numbers" } as const;
const DEFAULT_CONFIG = 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"] } });\n';

function makeRepo(files: Record<string, string>, config = DEFAULT_CONFIG): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-r5-")));
	roots.push(root);
	execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
	const all: Record<string, string> = { ".gitignore": "node_modules\n.interlinked\n", "package.json": '{"name":"fx","type":"module"}\n', "vitest.config.ts": config, "src/math.ts": SOURCE, ...files };
	for (const [path, text] of Object.entries(all)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text.replaceAll("<ROOT>", root));
	}
	symlinkSync(NODE_MODULES, join(root, "node_modules"));
	execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	for (const path of strays.splice(0)) rmSync(path, { force: true });
});

// ---- Receipt freshness: helpers the receipt does not bind (review R5-3 … R5-7) ------------------------------
// A scripted runner that answers by the copy's source bytes: unmutated → the case passes, anything else → the
// case fails by its own assertion. Four runs (baseline, mutant, two repeats) then give a KILLED receipt.
const TEST = "test/k.test.ts";
const scriptedKill = async (dir: string): Promise<VitestRun> => {
	const unmutated = readFileSync(join(dir, "src/math.ts"), "utf8") === SOURCE;
	return { cases: [{ file: TEST, name: "adds", title: "adds", status: unmutated ? "passed" : "failed", ...(unmutated ? {} : { message: "AssertionError: expected -1 to be 3" }) }], timedOut: false, exitCode: unmutated ? 0 : 1, durationMs: 1 };
};
async function killedReceipt(root: string) {
	const result = await proveKill({ root, spec: MINUS_FAULT, tests: [TEST], budgetMs: 1_000, runner: scriptedKill });
	if (!result.ok || result.receipt.verdict !== "killed") throw new Error(`precondition: expected a killed receipt, got ${JSON.stringify(result)}`);
	return result.receipt;
}
/** Both freshness readers must agree the proof no longer describes the test: `--verify` and the Stop check's certification. */
function freshAfterEdit(root: string, receipt: Awaited<ReturnType<typeof killedReceipt>>, path: string, text: string): { verify: boolean; certifies: boolean } {
	writeFileSync(join(root, path), text);
	return { verify: verifyKillProof(root, receipt).fresh, certifies: receiptCertifies(root, receipt.id, TEST).certified };
}

describe("kill proof round 5 — receipts stay FRESH after an edit that changes the test's behaviour (must not)", () => {
	it("N1: a helper beyond the 200-file bound cap is silently unbound: editing the file the test's value comes from keeps the receipt fresh", async () => {
		// review R5-3 — `boundImportClosure` drops every file past MAX_BOUND_IMPORTS without a trace in the receipt
		const depth = MAX_BOUND_IMPORTS + 5;
		const files: Record<string, string> = { [TEST]: 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nimport { DEEP } from "../chain/c0";\nit("adds", () => { expect(add(1, 2)).toBe(DEEP); });\n' };
		for (let i = 0; i < depth - 1; i++) files[`chain/c${i}.ts`] = `export * from "./c${i + 1}";\n`;
		files[`chain/c${depth - 1}.ts`] = "export const DEEP = 3;\n";
		const root = makeRepo(files);
		const receipt = await killedReceipt(root);
		expect(receipt.boundImports.length).toBe(MAX_BOUND_IMPORTS); // precondition: the closure was cut
		const after = freshAfterEdit(root, receipt, `chain/c${depth - 1}.ts`, "export const DEEP = 4;\n"); // the test now FAILS live
		expect(after).toEqual({ verify: false, certifies: false });
	});

	it("N2: the `__mocks__` twin vitest substitutes for a vi.mock'ed helper is not bound; editing it keeps the receipt fresh", async () => {
		// review R5-4 — `vi.mock("./helpers/check")` loads `test/helpers/__mocks__/check.ts`, which no static import names
		const root = makeRepo({
			[TEST]: 'import { expect, it, vi } from "vitest";\nimport { add } from "../src/math";\nimport { check } from "./helpers/check";\nvi.mock("./helpers/check");\nit("adds", () => { expect(check(add(1, 2))).toBe(true); });\n',
			"test/helpers/check.ts": "export function check(v: number): boolean { return v === 3; }\n",
			"test/helpers/__mocks__/check.ts": "export function check(v: number): boolean { return v === 3; }\n",
		});
		const receipt = await killedReceipt(root);
		const after = freshAfterEdit(root, receipt, "test/helpers/__mocks__/check.ts", "export function check(_v: number): boolean { return true; }\n");
		expect(after).toEqual({ verify: false, certifies: false });
	});

	it("N3: a setup file's own imports are not bound: editing the matcher module the setup file installs keeps the receipt fresh", async () => {
		// review R5-5 — `setupFiles` bytes are bound, their static import closure is not (the tests' closure is)
		const config = 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] } });\n';
		const root = makeRepo({
			[TEST]: 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\ndeclare module "vitest" { interface Assertion<T> { toBeThree(): T } }\nit("adds", () => { expect(add(1, 2)).toBeThree(); });\n',
			"test/setup.ts": 'import "./helpers/matchers";\n',
			"test/helpers/matchers.ts": 'import { expect } from "vitest";\nexpect.extend({ toBeThree(v: number) { return { pass: v === 3, message: () => "not three" }; } });\n',
		}, config);
		const receipt = await killedReceipt(root);
		expect(receipt.environment.setupFiles.map(file => file.path)).toEqual(["test/setup.ts"]); // precondition
		const after = freshAfterEdit(root, receipt, "test/helpers/matchers.ts", 'import { expect } from "vitest";\nexpect.extend({ toBeThree() { return { pass: true, message: () => "" }; } });\n');
		expect(after).toEqual({ verify: false, certifies: false });
	});

	it("N4: a globalSetup file's own imports are not bound: editing its helper keeps the receipt fresh", async () => {
		// review R5-5 — same gap through `globalSetup`
		const config = 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"], globalSetup: ["./test/global-setup.ts"] } });\n';
		const root = makeRepo({
			[TEST]: 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("adds", () => { expect(add(1, 2)).toBe(Number(process.env.KP_EXPECTED)); });\n',
			"test/global-setup.ts": 'import { EXPECTED } from "./global-setup-helper";\nexport default function () { process.env.KP_EXPECTED = String(EXPECTED); }\n',
			"test/global-setup-helper.ts": "export const EXPECTED = 3;\n",
		}, config);
		const receipt = await killedReceipt(root);
		expect(receipt.environment.setupFiles.map(file => file.path)).toEqual(["test/global-setup.ts"]); // precondition
		const after = freshAfterEdit(root, receipt, "test/global-setup-helper.ts", "export const EXPECTED = 4;\n");
		expect(after).toEqual({ verify: false, certifies: false });
	});

	// POLICY (round-5 resolution R5-6): aliases need the vite/vitest config evaluated — not a static rule; documented in the guide's
	// Limits as a false-FRESH class. Kept as a todo, body intact, so turning it green is a deliberate product change.
	it.todo("N5: a helper reached only through a vitest `resolve.alias` is not bound; editing it keeps the receipt fresh (documented limit, still a false FRESH) — POLICY: aliases are a documented Limit (resolve.alias needs the config evaluated; binding follows static relative specifiers only)", async () => {
		// review R5-6 — the guide's Limits say aliased specifiers are not followed; the receipt still reads FRESH while the test's helper changed
		const config = 'import { defineConfig } from "vitest/config";\nimport { fileURLToPath } from "node:url";\nexport default defineConfig({ resolve: { alias: { "@helpers": fileURLToPath(new URL("./test/helpers", import.meta.url)) } }, test: { include: ["test/**/*.test.ts"] } });\n';
		const root = makeRepo({
			[TEST]: 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nimport { aliased } from "@helpers/aliased";\nit("adds", () => { expect(aliased(add(1, 2))).toBe(true); });\n',
			"test/helpers/aliased.ts": "export function aliased(v: number): boolean { return v === 3; }\n",
		}, config);
		const receipt = await killedReceipt(root);
		const after = freshAfterEdit(root, receipt, "test/helpers/aliased.ts", "export function aliased(_v: number): boolean { return true; }\n");
		expect(after).toEqual({ verify: false, certifies: false });
	});
});

// ---- Ambiguity refusal: a verbatim duplicate with the same qualified name (review R5-2) --------------------------
function manifestFor(root: string, file: string, source: string, lexeme: string, replacement: string): string {
	const raw: RawMutant = { file, mutator: "ArithmeticOperator", originalLexeme: lexeme, replacement, startOffset: source.indexOf(lexeme) };
	const identities = deriveIdentities(file, source, [raw]);
	const hashes = computeSymbolHashes(file, source);
	const identity = identities?.[0];
	if (identity === undefined || hashes === null) throw new Error("typescript is required for this suite");
	const manifest = applyMeasuredRun({
		base: emptyManifest({ engine: "stryker", engineVersion: "9", dependencyGraphVersion: "0", environmentHash: "t", authoritativeAt: "2026-11-05T00:00:00.000Z" }),
		file, overlayHashes: hashes, measured: [{ identity, status: "killed" }], at: "2026-11-05T00:00:00.000Z", cwd: root,
	});
	saveManifest(join(root, ".interlinked"), manifest);
	return identity.mutantId;
}

describe("kill proof round 5 — a verbatim duplicate earlier in the file is ranked, not refused (must not)", () => {
	it("N6: a duplicate method with the same qualified name, arity and body inserted BEFORE the live one takes its ordinal — the proof would mutate the dead copy", () => {
		// review R5-2 — `computeSymbolHashes` keeps one entry per symbolId, so the hash reads unchanged and the
		// ambiguity check is skipped although the lexeme now occurs twice in `Calc.add`; at runtime the LATER
		// definition wins, so ordinal 0 is dead code and the real `tests prove-kill` wrote SURVIVED under a killed id.
		const live = "export class Calc {\n\tadd(a: number, b: number): number {\n\t\treturn a + b;\n\t}\n}\n";
		const root = makeRepo({ "src/calc.ts": live });
		const mutantId = manifestFor(root, "src/calc.ts", live, "a + b", "a - b");
		const duplicated = "export class Calc {\n\tadd(a: number, b: number): number {\n\t\treturn a + b;\n\t}\n\tadd(a: number, b: number): number {\n\t\treturn a + b;\n\t}\n}\n";
		writeFileSync(join(root, "src/calc.ts"), duplicated);
		const resolved = resolveMutant(root, { kind: "manifest", mutantId });
		// Either refuse (ambiguous: 2 sites, was 1) or pin the live site (line 6); never the dead copy on line 3.
		expect(resolved.ok && resolved.mutant.line).not.toBe(3);
	});

	it("N7: the same hole for a nested function duplicated earlier in its enclosing function body", () => {
		// review R5-2 — duplicate function declarations in a function body are legal JavaScript; the last one wins
		const live = "export function calc(a: number, b: number): number {\n\tfunction add(x: number, y: number): number {\n\t\treturn x + y;\n\t}\n\treturn add(a, b);\n}\n";
		const root = makeRepo({ "src/calc.ts": live });
		const mutantId = manifestFor(root, "src/calc.ts", live, "x + y", "x - y");
		const duplicated = live.replace("\treturn add(a, b);", "\tfunction add(x: number, y: number): number {\n\t\treturn x + y;\n\t}\n\treturn add(a, b);");
		writeFileSync(join(root, "src/calc.ts"), duplicated);
		const resolved = resolveMutant(root, { kind: "manifest", mutantId });
		expect(resolved.ok && resolved.mutant.line).not.toBe(3);
	});
});

// ---- Timed-out runs: the CLI dies with exit 13 and leaks the copy (review R5-1) ----------------------------------
describe("kill proof round 5 — a timed-out vitest run must end in a verdict, not an unsettled process (must not)", () => {
	it("N8: `--run-timeout` below the baseline exits 2 with a JSON verdict and removes its copy — not exit 13 'unsettled top-level await'", () => {
		// review R5-1 — once the direct vitest child closes, `terminateGroup` polls the group with unref'd timers only,
		// the event loop drains, Node exits 13 before `proveKill` resolves: no verdict, no JSON, the copy and the private
		// TMPDIR (with whatever the test wrote there) are never removed.
		const root = makeRepo({ "test/slow.test.ts": 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("slow", async () => { await new Promise(r => setTimeout(r, 6000)); expect(add(1, 2)).toBe(3); }, 30000);\n' });
		const copiesBefore = readdirSync(tmpdir()).filter(name => name.startsWith("interlinked-fail-before-fix-")).length;
		const run = spawnSync(process.execPath, [join(NODE_MODULES, "tsx", "dist", "cli.mjs"), join(CHECKOUT, "src", "index.ts"), "tests", "prove-kill", "--cwd", root, "--test", "test/slow.test.ts", "--file", "src/math.ts", "--find", "return a + b;", "--replace", "return a - b;", "--run-timeout", "2000", "--json"], { encoding: "utf8", timeout: 90_000 });
		const copiesAfter = readdirSync(tmpdir()).filter(name => name.startsWith("interlinked-fail-before-fix-")).length;
		expect(run.stderr).not.toContain("unsettled top-level await");
		expect(run.status).toBe(2);
		expect(run.stdout).toMatch(/"verdict": "(unavailable|inconclusive)"/);
		expect(copiesAfter).toBe(copiesBefore);
	}, REAL_RUN_MS);
});

// ---- Double repeat: state the copies cannot see (review R5-8, R5-9; documented residuals) --------------------------
const stateBeside = (root: string, name: string): string => {
	const path = join(root, "..", `${name}-${uniq()}`);
	strays.push(path);
	return path;
};

describe("kill proof round 5 — state beside the project turns a comment-only mutant into a kill (must not; documented residual)", () => {
	// POLICY (round-5 resolution R5-8): adaptive state is the documented limit of the repeat design — a repeat only catches
	// state that misbehaves on an UNMUTATED run. The test did read the mutated file, so "failed by its own check" holds.
	it.todo("N9: state keyed on the MUTANT's bytes (a store of seen source hashes) fails exactly the mutant run and no repeat can see it — POLICY: adaptive state is a documented Limit (the repeats cannot see state that only fails under the mutant's bytes)", async () => {
		// review R5-8 — the repeat sequence pass, FAIL, pass, pass is exactly what adaptive state produces, whatever the repeat count
		const store = stateBeside("/tmp", "kp-r5-hashes");
		const test = [
			'import { createHash } from "node:crypto";',
			'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
			'import { expect, it } from "vitest";',
			'import { add } from "../src/math";',
			`const STORE = ${JSON.stringify(store)};`,
			'it("adds", () => {',
			'\tconst h = createHash("sha256").update(readFileSync(new URL("../src/math.ts", import.meta.url))).digest("hex");',
			'\tconst seen = existsSync(STORE) ? readFileSync(STORE, "utf8").split("\\n").filter(Boolean) : [];',
			"\tconst fresh = seen.length > 0 && !seen.includes(h);",
			'\tif (!seen.includes(h)) writeFileSync(STORE, [...seen, h].join("\\n"));',
			"\texpect(add(1, 2)).toBe(3);",
			"\texpect(fresh).toBe(false);",
			"});",
			"",
		].join("\n");
		const root = makeRepo({ "test/hk.test.ts": test });
		const result = await proveKill({ root, spec: COMMENT_FAULT, tests: ["test/hk.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("killed");
	}, REAL_RUN_MS);

	// POLICY (round-5 resolution R5-9): period ≥ 3 state is the residual the guide's Limits state for pass, FAIL, pass, pass.
	it.todo("N10: a period-3 counter (forbids every third reading) lines up with run 2 of 4 and passes both repeats — POLICY: period-3 state is a documented Limit of the two-repeat sequence (and so is a custom sequencer that reads it)", async () => {
		// review R5-9 — the guide's Limits name this residual; the sequence pass, FAIL, pass, pass accepts period 3
		const counter = stateBeside("/tmp", "kp-r5-p3");
		const test = [
			'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
			'import { expect, it } from "vitest";',
			'import { add } from "../src/math";',
			`const STATE = ${JSON.stringify(counter)};`,
			'it("adds", () => {',
			'\tconst n = existsSync(STATE) ? Number(readFileSync(STATE, "utf8")) : 0;',
			"\twriteFileSync(STATE, String(n + 1));",
			"\texpect(add(1, 2)).toBe(3);",
			"\texpect(n % 3).not.toBe(1);",
			"});",
			"",
		].join("\n");
		const root = makeRepo({ "test/p3.test.ts": test });
		const result = await proveKill({ root, spec: COMMENT_FAULT, tests: ["test/p3.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("killed");
	}, REAL_RUN_MS);
});

/** Guard against a fixture mistake: the control for N1 (an in-cap helper) must stale as the receipt promises. */
describe("kill proof round 5 — controls (must hold on this branch)", () => {
	it("C1: an in-cap helper edit stales the receipt through both readers", async () => {
		const root = makeRepo({ [TEST]: 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nimport { THREE } from "./helpers/three";\nit("adds", () => { expect(add(1, 2)).toBe(THREE); });\n', "test/helpers/three.ts": "export const THREE = 3;\n" });
		const receipt = await killedReceipt(root);
		expect(receipt.boundImports.map(file => file.path)).toEqual(["test/helpers/three.ts"]);
		expect(freshAfterEdit(root, receipt, "test/helpers/three.ts", "export const THREE = 4;\n")).toEqual({ verify: false, certifies: false });
		expect(existsSync(join(root, ".interlinked/test-runs/kill-proofs", `${receipt.id}.json`))).toBe(true);
	});
});
