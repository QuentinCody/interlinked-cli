import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dispositionStore from "../harness/mutation/disposition-store.js";
import { loadLedger } from "../harness/mutation/disposition-store.js";
import { clearManifestCache, loadManifest } from "../harness/mutation/manifest.js";
import { buildDisposition, mutationDispositionCommand } from "./mutation-disposition.js";

const NOW = () => "2026-08-09T00:00:00.000Z";

describe("buildDisposition — pure CLI-string → typed-disposition parsing", () => {
	describe("kind: dead_code", () => {
		it("P1: --resolution delete builds a dead_code disposition", () => {
			const result = buildDisposition({ kind: "dead_code", resolution: "delete" }, NOW);
			expect(result).toEqual({ disposition: { kind: "dead_code", resolution: "delete" } });
		});

		it("P2: --resolution implement is accepted too", () => {
			const result = buildDisposition({ kind: "dead_code", resolution: "implement" }, NOW);
			expect(result).toEqual({ disposition: { kind: "dead_code", resolution: "implement" } });
		});

		it("P3: a trimmed --issue is carried through as issueRef", () => {
			const result = buildDisposition({ kind: "dead_code", resolution: "delete", issue: "  #123  " }, NOW);
			expect(result).toEqual({ disposition: { kind: "dead_code", resolution: "delete", issueRef: "#123" } });
		});

		it("N1: a missing --resolution is refused with a message naming both valid values", () => {
			const result = buildDisposition({ kind: "dead_code" }, NOW);
			expect("error" in result).toBe(true);
			expect((result as { error: string }).error).toMatch(/--resolution delete\|implement/);
		});

		it("N2: an unrecognized --resolution is refused, not silently coerced", () => {
			const result = buildDisposition({ kind: "dead_code", resolution: "rewrite" }, NOW);
			expect("error" in result).toBe(true);
		});

		it("N3: a whitespace-only --issue is dropped rather than recorded as an empty ref", () => {
			const result = buildDisposition({ kind: "dead_code", resolution: "delete", issue: "   " }, NOW);
			expect(result).toEqual({ disposition: { kind: "dead_code", resolution: "delete" } });
		});
	});

	describe("kind: unresolved", () => {
		it("P1: bare --kind unresolved (no --strategy) is legal — the honest 'I looked and found nothing'", () => {
			const result = buildDisposition({ kind: "unresolved" }, NOW);
			expect(result).toEqual({ disposition: { kind: "unresolved" } });
		});

		it("P2: --strategy with --runs builds full evidence, stamped with the injected clock", () => {
			const result = buildDisposition(
				{ kind: "unresolved", strategy: "fuzz", runs: "8000000", seed: "abc", budgetMs: "60000" },
				NOW,
			);
			expect(result).toEqual({
				disposition: {
					kind: "unresolved",
					evidence: { strategy: "fuzz", runs: 8_000_000, seed: "abc", budgetMs: 60_000, searchedAt: NOW() },
				},
			});
		});

		it("P3: a missing --seed defaults to an empty string rather than throwing", () => {
			const result = buildDisposition({ kind: "unresolved", strategy: "property", runs: "10" }, NOW);
			expect(result).toEqual({
				disposition: {
					kind: "unresolved",
					evidence: { strategy: "property", runs: 10, seed: "", budgetMs: 0, searchedAt: NOW() },
				},
			});
		});

		it("N1: --strategy without --runs is refused — a search claim needs a case count", () => {
			const result = buildDisposition({ kind: "unresolved", strategy: "fuzz" }, NOW);
			expect("error" in result).toBe(true);
			expect((result as { error: string }).error).toMatch(/--runs/);
		});

		it("N2: an unrecognized --strategy is refused and lists the valid ones", () => {
			const result = buildDisposition({ kind: "unresolved", strategy: "vibes", runs: "5" }, NOW);
			expect("error" in result).toBe(true);
			expect((result as { error: string }).error).toContain("property, fuzz, differential, bounded_exhaustive, test_suite");
		});

		it("N3: --runs 0 is refused — zero cases is not a search that ran", () => {
			const result = buildDisposition({ kind: "unresolved", strategy: "fuzz", runs: "0" }, NOW);
			expect("error" in result).toBe(true);
		});
	});

	describe("kind: missing or unrecognized", () => {
		it("N1: an unrecognized --kind steers toward `mutation accept` for equivalence claims", () => {
			const result = buildDisposition({ kind: "proved_equivalent" }, NOW);
			expect("error" in result).toBe(true);
			expect((result as { error: string }).error).toMatch(/mutation accept/);
		});

		it("N2: no --kind at all is refused the same way", () => {
			const result = buildDisposition({}, NOW);
			expect("error" in result).toBe(true);
		});
	});
});

// ===========================================
// mutationDispositionCommand — I/O: manifest lookup, recordDisposition, output.
// A real tmp manifest is used throughout so `saveManifest`/`loadManifest`
// round-trip through the real disk, not a mock of the persistence layer.
// ===========================================
describe("mutationDispositionCommand", () => {
	let cwd: string;
	let configDir: string;
	let logs: string[];

	function baseManifest() {
		return {
			version: 1,
			generation: 1,
			authoritativeAt: "2026-08-09T00:00:00.000Z",
			engine: "stryker",
			engineVersion: "8",
			dependencyGraphVersion: "1",
			environmentHash: "env",
			files: {
				"src/a.ts": {
					s1: {
						symbolId: "s1",
						qualifiedName: "fn",
						symbolHash: "h",
						instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
						mutants: {
							m1: {
								mutantId: "m1",
								siteId: "site1",
								mutator: "BooleanLiteral",
								originalLexeme: "true",
								replacement: "false",
								ordinalWithinSymbol: 0,
								status: "survived",
								firstSeen: "2026-08-01T00:00:00.000Z",
							},
						},
					},
				},
			},
		};
	}

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "mutation-disposition-"));
		configDir = join(cwd, ".interlinked");
		mkdirSync(configDir, { recursive: true });
		logs = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		clearManifestCache();
		vi.restoreAllMocks();
		process.exitCode = 0;
	});

	function writeManifest(manifest: unknown = baseManifest()) {
		writeFileSync(join(configDir, "mutation-manifest.json"), JSON.stringify(manifest));
		clearManifestCache();
	}

	it("P1: usage error when --file is missing", async () => {
		await mutationDispositionCommand({ id: "m1", kind: "dead_code", resolution: "delete", cwd, json: true });
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/Usage: interlinked mutation disposition/);
	});

	it("P2: usage error when --id is missing", async () => {
		await mutationDispositionCommand({ file: "src/a.ts", kind: "dead_code", resolution: "delete", cwd, json: true });
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/Usage: interlinked mutation disposition/);
	});

	it("P3: a build error (bad --kind) is reported and exits nonzero before any manifest is touched", async () => {
		await mutationDispositionCommand({ file: "src/a.ts", id: "m1", cwd, json: true });
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/--kind must be dead_code or unresolved/);
	});

	it("P4: no manifest on disk is a clear error naming the fix", async () => {
		await mutationDispositionCommand({
			file: "src/a.ts",
			id: "m1",
			kind: "dead_code",
			resolution: "delete",
			cwd,
			json: true,
		});
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/No mutation manifest/);
	});

	it("P5: an unknown mutant id is refused with both the id and the file named", async () => {
		writeManifest();
		await mutationDispositionCommand({
			file: "src/a.ts",
			id: "does-not-exist",
			kind: "dead_code",
			resolution: "delete",
			cwd,
			json: true,
		});
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toContain("does-not-exist");
		expect(logs.join("\n")).toContain("src/a.ts");
	});

	it("P6: records a dead_code disposition into the durable LEDGER, not the manifest", async () => {
		writeManifest();
		await mutationDispositionCommand({
			file: "src/a.ts",
			id: "m1",
			kind: "dead_code",
			resolution: "delete",
			issue: "#42",
			cwd,
			json: true,
		});
		expect(process.exitCode).toBe(0);
		const payload = JSON.parse(logs.join("\n")) as { recorded: boolean; disposition: unknown; store: string };
		expect(payload.recorded).toBe(true);
		expect(payload.store).toBe("ledger");
		expect(payload.disposition).toEqual({ kind: "dead_code", resolution: "delete", issueRef: "#42" });
		// The judgment lives in the sidecar ledger, keyed by (file, symbolId, mutantId)
		// with the enclosing symbol's hash as the invalidation key; complexity_delta is
		// null in M0.
		const ledger = loadLedger(configDir);
		expect(ledger.records).toHaveLength(1);
		expect(ledger.records[0]?.mutantId).toBe("m1");
		expect(ledger.records[0]?.symbolId).toBe("s1");
		expect(ledger.records[0]?.symbolHash).toBe("h");
		expect(ledger.records[0]?.complexity_delta).toBeNull();
		expect(ledger.records[0]?.disposition).toEqual({ kind: "dead_code", resolution: "delete", issueRef: "#42" });
		// The manifest is UNTOUCHED — no disposition written (a re-measure would have
		// wiped it, plan 18 §1.3), and the status stays exactly as measured.
		const onDisk = loadManifest(configDir);
		expect(onDisk?.files["src/a.ts"]?.s1?.mutants.m1?.disposition).toBeUndefined();
		expect(onDisk?.files["src/a.ts"]?.s1?.mutants.m1?.status).toBe("survived");
	});

	it("P7: a bare unresolved (no evidence) is REFUSED — the absence of a judgment is not a record", async () => {
		writeManifest();
		await mutationDispositionCommand({ file: "src/a.ts", id: "m1", kind: "unresolved", cwd, json: true });
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/Refused|bare `unresolved`/);
		expect(loadLedger(configDir).records).toHaveLength(0);
	});

	it("P8: records an unresolved disposition with counterexample-search evidence into the ledger", async () => {
		writeManifest();
		await mutationDispositionCommand({
			file: "src/a.ts",
			id: "m1",
			kind: "unresolved",
			strategy: "fuzz",
			runs: "5000",
			seed: "seed-1",
			budgetMs: "30000",
			cwd,
			json: true,
		});
		expect(process.exitCode).toBe(0);
		const disposition = loadLedger(configDir).records[0]?.disposition as {
			kind: string;
			evidence?: { runs: number; strategy: string };
		};
		expect(disposition.kind).toBe("unresolved");
		expect(disposition.evidence?.runs).toBe(5000);
		expect(disposition.evidence?.strategy).toBe("fuzz");
	});

	it("P9: --list renders the honest empty state when no dispositions exist", async () => {
		writeManifest();
		await mutationDispositionCommand({ list: true, cwd });
		expect(process.exitCode).toBe(0);
		expect(logs.join("\n")).toMatch(/No recorded dispositions/);
	});

	it("P10: --show round-trips a recorded disposition by id", async () => {
		writeManifest();
		await mutationDispositionCommand({ file: "src/a.ts", id: "m1", kind: "dead_code", resolution: "delete", cwd });
		logs.length = 0;
		await mutationDispositionCommand({ show: true, id: "m1", cwd, json: true });
		const record = JSON.parse(logs.join("\n")) as { mutantId: string; disposition: { kind: string } };
		expect(record.mutantId).toBe("m1");
		expect(record.disposition.kind).toBe("dead_code");
	});

	it("N1: normal (non-json) output states the disposition, its durability, and that the survivor is unresolved", async () => {
		writeManifest();
		await mutationDispositionCommand({ file: "src/a.ts", id: "m1", kind: "dead_code", resolution: "implement", cwd });
		const text = logs.join("\n");
		expect(text).toContain("Recorded: m1 (src/a.ts)");
		expect(text).toMatch(/dead code \(implement\)/);
		expect(text).toMatch(/durable/);
		expect(text).toMatch(/Status is unchanged/);
	});

	it("N2: an invalid --strategy build-error path never reaches the manifest lookup", async () => {
		// No manifest written at all — if the command tried to load one before
		// validating the disposition, this would fail with the WRONG message.
		await mutationDispositionCommand({
			file: "src/a.ts",
			id: "m1",
			kind: "unresolved",
			strategy: "nonsense",
			runs: "5",
			cwd,
			json: true,
		});
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/--strategy must be one of/);
	});

	it("N3: a CORRUPT on-disk manifest is reported as corrupt, not as missing", async () => {
		// Malformed JSON, not absent — `loadManifestState` must land in the
		// "corrupt" branch rather than the "no manifest" one, and the reader
		// steers toward repair/removal instead of "measure the file first".
		writeFileSync(join(configDir, "mutation-manifest.json"), "{not valid json");
		clearManifestCache();
		await mutationDispositionCommand({
			file: "src/a.ts",
			id: "m1",
			kind: "dead_code",
			resolution: "delete",
			cwd,
			json: true,
		});
		expect(process.exitCode).toBe(1);
		const payload = JSON.parse(logs.join("\n")) as { error: string };
		expect(payload.error).toContain("is CORRUPT");
		expect(payload.error).toContain('not "missing"');
		expect(payload.error).toContain("mutation-manifest.json");
	});

	it("N4: a --file spelling the manifest's OWN normalizer resolves but the store's lighter matcher misses it — reported as an unfound mutant", async () => {
		// `findMutantRecord` resolves through the full path-resolution normalizer
		// (which collapses "src/./a.ts" to "src/a.ts"), so the pre-check passes.
		// `disposition-store.ts`'s `locateMutant` uses a lighter string-only
		// normalizer that does NOT collapse a mid-path "./" segment, so it fails
		// to find the same mutant and `makeRecord` returns null.
		writeManifest();
		await mutationDispositionCommand({
			file: "src/./a.ts",
			id: "m1",
			kind: "dead_code",
			resolution: "delete",
			cwd,
			json: true,
		});
		expect(process.exitCode).toBe(1);
		const payload = JSON.parse(logs.join("\n")) as { error: string };
		expect(payload.error).toBe('Mutant "m1" not found under "src/./a.ts".');
		// Nothing was written — the store-level failure must not partially record.
		expect(loadLedger(configDir).records).toHaveLength(0);
	});

	it("N5: a store-level refusal surfacing AFTER record construction is reported, and the ledger stays untouched", async () => {
		// The command already checks `refuseRecord` once before calling
		// `upsertRecord`, so under real conditions `upsertRecord` never refuses a
		// record that already passed. Force the store's own internal refusal path
		// (a defensive double-check) by spying on the real dependency — not the
		// module under test — so the branch is exercised without weakening any
		// other test's use of the real store.
		writeManifest();
		const spy = vi.spyOn(dispositionStore, "upsertRecord").mockReturnValueOnce(null);
		try {
			await mutationDispositionCommand({
				file: "src/a.ts",
				id: "m1",
				kind: "dead_code",
				resolution: "delete",
				cwd,
				json: true,
			});
		} finally {
			spy.mockRestore();
		}
		expect(process.exitCode).toBe(1);
		const payload = JSON.parse(logs.join("\n")) as { error: string };
		expect(payload.error).toBe('Refused: "dead_code" cannot be recorded against "m1".');
		expect(loadLedger(configDir).records).toHaveLength(0);
	});

	it("N6: --list --json emits the machine payload (count + full records), not the human summary", async () => {
		writeManifest();
		await mutationDispositionCommand({ file: "src/a.ts", id: "m1", kind: "dead_code", resolution: "delete", cwd });
		logs.length = 0;
		await mutationDispositionCommand({ list: true, json: true, cwd });
		expect(process.exitCode).toBe(0);
		const payload = JSON.parse(logs.join("\n")) as { count: number; records: Array<{ mutantId: string }> };
		expect(payload.count).toBe(1);
		expect(payload.records[0]?.mutantId).toBe("m1");
	});

	it("N7: --list human summary names each recorded mutant when the ledger is non-empty", async () => {
		writeManifest();
		await mutationDispositionCommand({ file: "src/a.ts", id: "m1", kind: "dead_code", resolution: "delete", cwd });
		logs.length = 0;
		await mutationDispositionCommand({ list: true, cwd });
		expect(process.exitCode).toBe(0);
		const text = logs.join("\n");
		expect(text).toContain("1 recorded disposition(s):");
		expect(text).toContain("  m1  dead_code  fn  src/a.ts");
	});

	it("N8: --show with no --id is a usage error naming the required flag", async () => {
		await mutationDispositionCommand({ show: true, cwd, json: true });
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/Usage: interlinked mutation disposition --show --id/);
	});

	it("N9: --show for an id with no recorded disposition names the id and the --file scope in the error", async () => {
		writeManifest();
		await mutationDispositionCommand({ show: true, id: "does-not-exist", file: "src/a.ts", cwd, json: true });
		expect(process.exitCode).toBe(1);
		const payload = JSON.parse(logs.join("\n")) as { error: string };
		expect(payload.error).toBe('No disposition recorded for "does-not-exist" under "src/a.ts".');
	});

	it("N10: --show human summary (no --json) pretty-prints the same record the JSON path returns", async () => {
		writeManifest();
		await mutationDispositionCommand({ file: "src/a.ts", id: "m1", kind: "dead_code", resolution: "delete", cwd });
		logs.length = 0;
		await mutationDispositionCommand({ show: true, id: "m1", cwd });
		expect(process.exitCode).toBe(0);
		const record = JSON.parse(logs.join("\n")) as { mutantId: string; disposition: { kind: string } };
		expect(record.mutantId).toBe("m1");
		expect(record.disposition.kind).toBe("dead_code");
	});
});
