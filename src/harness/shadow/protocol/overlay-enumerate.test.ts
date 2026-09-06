import { describe, expect, it } from "vitest";
import {
	collectLocalTreeInputs,
	enumerateOverlay,
	MAX_IGNORED_CANDIDATES,
	overlayScanRoots,
	parseNulSeparated,
	validateOverlayEntries,
	type BaseTreeEntryV1,
	type EnumerateOverlayInput,
	type LocalTreeEntryV1,
} from "./overlay-enumerate.js";
import { DEFAULT_OVERLAY_INCLUDE_RULES, SHADOW_OVERLAY_DENY_V1 } from "./overlay-manifest.js";
import { asCanonicalPath } from "./path-rules.js";
import type { BlobDigest, GitMode, OverlayEntryV1, OverlayIncludeRuleV1, OverlayManifestV1 } from "./types-core.js";

// ── fixtures ───────────────────────────────────────────────────────────────

function digest(seed: string): string {
	return seed.repeat(64).slice(0, 64);
}

const D_A = digest("a");
const D_B = digest("b");
const D_C = digest("c");

function local(path: string, blob: string, mode = "100644"): LocalTreeEntryV1 {
	return { path, mode, blob_digest: blob, bytes: 10 };
}

function base(entries: readonly (readonly [string, string, string?])[]): Map<string, BaseTreeEntryV1> {
	const map = new Map<string, BaseTreeEntryV1>();
	for (const [path, blob, mode] of entries) map.set(path, { mode: mode ?? "100644", blob_digest: blob });
	return map;
}

function manifest(rules: readonly OverlayIncludeRuleV1[] = DEFAULT_OVERLAY_INCLUDE_RULES): OverlayManifestV1 {
	return { schema_version: 1, include_rules: rules, deny_ruleset_id: SHADOW_OVERLAY_DENY_V1.id };
}

function exact(path: string): OverlayIncludeRuleV1 {
	return { kind: "exact", path: asCanonicalPath(path) };
}

function input(over: Partial<EnumerateOverlayInput>): EnumerateOverlayInput {
	return {
		baseTree: over.baseTree ?? new Map(),
		manifest: over.manifest ?? manifest(),
		localTracked: over.localTracked ?? [],
		localUntracked: over.localUntracked ?? [],
		ignoredCandidates: over.ignoredCandidates ?? [],
	};
}

function ok(result: ReturnType<typeof enumerateOverlay>): readonly OverlayEntryV1[] {
	if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.detail}`);
	return result.entries;
}

function w(path: string, blob: string, mode = "100644"): OverlayEntryV1 {
	return {
		tag: "W",
		path: asCanonicalPath(path),
		// SAFETY: fixture modes are only ever the admitted "100644"/"100755".
		mode: mode as GitMode,
		// SAFETY: fixture digests are 64 hex chars, the BlobDigest shape.
		blob_digest: blob as BlobDigest,
		bytes: 10,
	};
}

function d(path: string): OverlayEntryV1 {
	return { tag: "D", path: asCanonicalPath(path) };
}

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/** Paths that must NEVER travel, however a caller offers them. */
const SECRET_PATHS = [
	"config.local.json",
	".interlinked/config.local.json",
	"mutation-cloud-v3.local.json",
	"guard-rules.local.json",
	"deep/nested/anything.local.yaml",
];

// ── enumeration — positive ─────────────────────────────────────────────────

describe("enumerateOverlay — positive (must accept)", () => {
	it("P1: clean-working-tree deletion of a tracked file (mirror still has it) -> D", () => {
		const result = enumerateOverlay(input({ baseTree: base([["src/gone.ts", D_A]]) }));
		expect(ok(result)).toEqual([d("src/gone.ts")]);
	});

	it("P2: a base-file rename is D old + W new", () => {
		const result = enumerateOverlay(
			input({
				baseTree: base([["src/old.ts", D_A]]),
				localTracked: [local("src/new.ts", D_A)],
			}),
		);
		// Byte order, not tag order: "src/new.ts" sorts before "src/old.ts".
		expect(ok(result)).toEqual([w("src/new.ts", D_A), d("src/old.ts")]);
	});

	it("P3: a file created locally and then renamed is just W new", () => {
		const result = enumerateOverlay(input({ localUntracked: [local("src/renamed.ts", D_B)] }));
		expect(ok(result)).toEqual([w("src/renamed.ts", D_B)]);
	});

	it("P4: create-then-delete produces no record", () => {
		const result = enumerateOverlay(
			input({ baseTree: base([["src/kept.ts", D_A]]), localTracked: [local("src/kept.ts", D_A)] }),
		);
		expect(ok(result)).toEqual([]);
	});

	it("P5: an imported untracked source file travels (the remote compile is otherwise fiction)", () => {
		const result = enumerateOverlay(
			input({
				baseTree: base([["src/index.ts", D_A]]),
				localTracked: [local("src/index.ts", D_A)],
				localUntracked: [local("src/new.ts", D_B)],
			}),
		);
		expect(ok(result)).toEqual([w("src/new.ts", D_B)]);
	});

	it("P6: delete + re-add with a different mode -> W carrying the new mode", () => {
		const result = enumerateOverlay(
			input({
				baseTree: base([["bin/run.sh", D_A, "100644"]]),
				localTracked: [local("bin/run.sh", D_A, "100755")],
			}),
		);
		expect(ok(result)).toEqual([w("bin/run.sh", D_A, "100755")]);
	});

	it("P7: an ignored path the manifest DOES name travels as W", () => {
		const result = enumerateOverlay(
			input({ ignoredCandidates: [local(".interlinked/coverage-baseline.json", D_C)] }),
		);
		expect(ok(result)).toEqual([w(".interlinked/coverage-baseline.json", D_C)]);
	});

	it("P8: unchanged files produce nothing (they are already in the mirror)", () => {
		const result = enumerateOverlay(
			input({
				baseTree: base([
					["a.ts", D_A],
					["b.ts", D_B, "100755"],
				]),
				localTracked: [local("a.ts", D_A), local("b.ts", D_B, "100755")],
			}),
		);
		expect(ok(result)).toEqual([]);
	});

	it("P9: entries come back sorted by path BYTES across all three local sources", () => {
		// scratch/** is opt-in, not in the default (see overlay-manifest.test.ts
		// P1) — add it explicitly here since this test's point is cross-source
		// sort order, not the default manifest's own contents.
		const optedIn = [...DEFAULT_OVERLAY_INCLUDE_RULES, { kind: "gitwildmatch-v1", pattern: "scratch/**" } as const];
		const result = enumerateOverlay(
			input({
				manifest: manifest(optedIn),
				baseTree: base([["z/removed.ts", D_A]]),
				localTracked: [local("src/b.ts", D_B)],
				localUntracked: [local("src/a.ts", D_B)],
				ignoredCandidates: [local("scratch/x.ts", D_C)],
			}),
		);
		expect(ok(result).map((e) => e.path)).toEqual(["scratch/x.ts", "src/a.ts", "src/b.ts", "z/removed.ts"]);
	});

	it("P10: a same-digest file whose mode changed is a W (mode is part of tree identity)", () => {
		const result = enumerateOverlay(
			input({ baseTree: base([["s.sh", D_A, "100755"]]), localTracked: [local("s.sh", D_A, "100644")] }),
		);
		expect(ok(result)).toEqual([w("s.sh", D_A, "100644")]);
	});

	it("P11: a path containing a space and a newline round-trips through the diff", () => {
		const result = enumerateOverlay(input({ localUntracked: [local("src/a b.ts", D_A), local("src/we\nird.ts", D_B)] }));
		expect(ok(result).map((e) => e.path)).toEqual(["src/a b.ts", "src/we\nird.ts"]);
	});
});

// ── enumeration — the deny ruleset is BROKER-OWNED, never caller-supplied ──

describe("enumerateOverlay — negative (secret paths can never travel)", () => {
	it("N1: a secret path offered as TRACKED never travels", () => {
		for (const path of SECRET_PATHS) {
			const result = enumerateOverlay(input({ localTracked: [local(path, D_A)] }));
			expect(ok(result)).toEqual([]);
		}
	});

	it("N2: a secret path offered as UNTRACKED never travels", () => {
		for (const path of SECRET_PATHS) {
			const result = enumerateOverlay(input({ localUntracked: [local(path, D_A)] }));
			expect(ok(result)).toEqual([]);
		}
	});

	it("N3: a secret path offered as an IGNORED candidate never travels", () => {
		for (const path of SECRET_PATHS) {
			const result = enumerateOverlay(input({ ignoredCandidates: [local(path, D_A)] }));
			expect(ok(result)).toEqual([]);
		}
	});

	it("N4: a manifest that NAMES a secret path explicitly still does not carry it", () => {
		for (const path of SECRET_PATHS) {
			const result = enumerateOverlay(
				input({
					manifest: manifest([exact(path), { kind: "gitwildmatch-v1", pattern: "**/*.local.*" }]),
					ignoredCandidates: [local(path, D_A)],
					localUntracked: [local(path, D_B)],
				}),
			);
			expect(ok(result)).toEqual([]);
		}
	});

	it("N5: a secret path in the base tree produces no D record either", () => {
		const result = enumerateOverlay(input({ baseTree: base([["secrets.local.json", D_A]]) }));
		expect(ok(result)).toEqual([]);
	});

	it("N6: an ignored path OUTSIDE the manifest allowlist cannot travel", () => {
		const result = enumerateOverlay(
			input({ ignoredCandidates: [local("reference-repos/huge/a.ts", D_A), local("node_modules/x.js", D_B)] }),
		);
		expect(ok(result)).toEqual([]);
	});

	it("N7: a manifest the canonicalizer refuses rejects as invalid_tree — never a partial overlay", () => {
		const result = enumerateOverlay(input({ manifest: manifest([]), ignoredCandidates: [local("scratch/x.ts", D_A)] }));
		expect(result).toMatchObject({ ok: false, reason: "invalid_tree" });
	});
});

// ── enumeration — tree-diff rejections ─────────────────────────────────────

describe("enumerateOverlay — negative (must reject)", () => {
	it("N1: a symlink mode rejects as symlink_escape", () => {
		const result = enumerateOverlay(input({ localTracked: [local("link", D_A, "120000")] }));
		expect(result).toMatchObject({ ok: false, reason: "symlink_escape" });
	});

	it("N2: a submodule mode rejects as invalid_tree", () => {
		const result = enumerateOverlay(input({ localTracked: [local("vendor", D_A, "160000")] }));
		expect(result).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N3: a base-tree symlink rejects as symlink_escape", () => {
		const result = enumerateOverlay(input({ baseTree: base([["link", D_A, "120000"]]) }));
		expect(result).toMatchObject({ ok: false, reason: "symlink_escape" });
	});

	it("N4: a duplicate path across the local sources rejects as invalid_tree", () => {
		const result = enumerateOverlay(
			input({ localTracked: [local("a.ts", D_A)], localUntracked: [local("a.ts", D_B)] }),
		);
		expect(result).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N5: a non-canonical path rejects as invalid_tree", () => {
		expect(enumerateOverlay(input({ localTracked: [local("../escape.ts", D_A)] }))).toMatchObject({
			ok: false,
			reason: "invalid_tree",
		});
		expect(enumerateOverlay(input({ localTracked: [local("/abs.ts", D_A)] }))).toMatchObject({
			ok: false,
			reason: "invalid_tree",
		});
		expect(enumerateOverlay(input({ baseTree: base([["a/../b.ts", D_A]]) }))).toMatchObject({
			ok: false,
			reason: "invalid_tree",
		});
	});

	it("N6: a malformed blob digest or byte count rejects as invalid_tree", () => {
		expect(enumerateOverlay(input({ localTracked: [local("a.ts", "not-a-digest")] }))).toMatchObject({
			ok: false,
			reason: "invalid_tree",
		});
		expect(
			enumerateOverlay(input({ localTracked: [{ path: "a.ts", mode: "100644", blob_digest: D_A, bytes: -1 }] })),
		).toMatchObject({ ok: false, reason: "invalid_tree" });
	});
});

// ── validateOverlayEntries — the shipped-set invariants ────────────────────

describe("validateOverlayEntries — positive (must accept)", () => {
	it("P1: a sorted, deduplicated set whose D records all name base paths is accepted", () => {
		const entries = [d("a/gone.ts"), w("b/new.ts", D_A)];
		expect(validateOverlayEntries(entries, base([["a/gone.ts", D_B]]))).toBeNull();
	});
});

describe("validateOverlayEntries — negative (must reject)", () => {
	it("N1: a D for a path NOT in the base tree is invalid_tree", () => {
		const result = validateOverlayEntries([d("never/existed.ts")], new Map());
		expect(result).toMatchObject({ reason: "invalid_tree" });
		expect(result?.detail).toContain("never/existed.ts");
	});

	it("N2: a duplicate path in the shipped set is invalid_tree", () => {
		const entries = [w("a.ts", D_A), w("a.ts", D_B)];
		expect(validateOverlayEntries(entries, new Map())).toMatchObject({ reason: "invalid_tree" });
	});

	it("N3: an out-of-order set is invalid_tree — record order must be unambiguous", () => {
		const entries = [w("b.ts", D_A), w("a.ts", D_B)];
		expect(validateOverlayEntries(entries, new Map())).toMatchObject({ reason: "invalid_tree" });
	});

	it("N4: a denied path in the shipped set is invalid_tree, with NO caller-supplied deny list", () => {
		expect(validateOverlayEntries([w("x.local.json", D_A)], new Map())).toMatchObject({
			reason: "invalid_tree",
		});
		expect(validateOverlayEntries([w("config.local.json", D_A)], new Map())).toMatchObject({
			reason: "invalid_tree",
		});
	});
});

// ── scan roots — bounded discovery is driven by the manifest's own rules ───

describe("overlayScanRoots — positive (must accept)", () => {
	it("P1: exact rules become their own pathspecs; a pattern becomes its literal prefix", () => {
		expect(overlayScanRoots(manifest([exact("a/b.json"), { kind: "gitwildmatch-v1", pattern: "scratch/**" }]))).toEqual([
			"a/b.json",
			"scratch",
		]);
	});

	it("P2: the default manifest's scan roots are exactly its seven exact paths — no 'scratch', no gitignored-tree walk (review finding 5 / UNIT D)", () => {
		expect(overlayScanRoots(manifest())).toEqual([
			".interlinked/coverage-baseline.json",
			".interlinked/coverage-edit-baseline.json",
			".interlinked/guard-rules.json",
			".interlinked/large-files-baseline.json",
			".interlinked/metric-caps.json",
			".interlinked/mutation-baseline.json",
			".interlinked/untested-files-baseline.json",
		]);
	});
});

describe("overlayScanRoots — negative (must not narrow wrongly)", () => {
	it("N1: a basename rule matches at any depth, so the root collapses to the repo root", () => {
		expect(overlayScanRoots(manifest([{ kind: "gitwildmatch-v1", pattern: "*.json" }, exact("a/b.json")]))).toEqual(["."]);
	});

	it("N2: a leading wildcard segment also collapses to the repo root", () => {
		expect(overlayScanRoots(manifest([{ kind: "gitwildmatch-v1", pattern: "**/keep/*.json" }]))).toEqual(["."]);
	});
});

// ── the git adapter — RAW BYTES, fatal UTF-8, bounded ignored discovery ────

describe("collectLocalTreeInputs — positive (must accept)", () => {
	it("P1: it runs the two enumeration forms plus a manifest-scoped ignored scan", () => {
		const calls: string[][] = [];
		collectLocalTreeInputs((args: readonly string[]) => {
			calls.push([...args]);
			return bytes("");
		}, manifest([{ kind: "gitwildmatch-v1", pattern: "scratch/**" }]));
		expect(calls).toEqual([
			["ls-files", "-z"],
			["ls-files", "--others", "--exclude-standard", "-z"],
			["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "scratch"],
		]);
	});

	it("P2: -z parsing handles a path containing a space and a newline", () => {
		const result = collectLocalTreeInputs(
			(args: readonly string[]) =>
				bytes(args.includes("--ignored") ? "" : args.includes("--others") ? "un tracked.ts\0" : "src/a b.ts\0src/we\nird.ts\0plain.ts\0"),
			manifest(),
		);
		if (!result.ok) throw new Error(result.detail);
		expect(result.sets.tracked).toEqual(["src/a b.ts", "src/we\nird.ts", "plain.ts"]);
		expect(result.sets.untracked).toEqual(["un tracked.ts"]);
	});

	it("P3: an empty working tree yields empty sets, not a phantom empty path", () => {
		const result = collectLocalTreeInputs(() => bytes(""), manifest());
		expect(result).toEqual({ ok: true, sets: { tracked: [], untracked: [], ignoredCandidates: [] } });
	});

	it("P4: parseNulSeparated drops only the terminators, never a path", () => {
		expect(parseNulSeparated(bytes("a\0b\0"))).toEqual({ ok: true, paths: ["a", "b"] });
		expect(parseNulSeparated(bytes("a\0b"))).toEqual({ ok: true, paths: ["a", "b"] });
		expect(parseNulSeparated(bytes("\0"))).toEqual({ ok: true, paths: [] });
	});

	it("P5: valid multi-byte UTF-8 decodes intact", () => {
		expect(parseNulSeparated(bytes("src/é\0src/日本.ts\0"))).toEqual({ ok: true, paths: ["src/é", "src/日本.ts"] });
	});

	it("P6: ignored candidates come back from the scoped scan", () => {
		const result = collectLocalTreeInputs(
			(args: readonly string[]) => bytes(args.includes("--ignored") ? "scratch/a.ts\0" : ""),
			manifest(),
		);
		if (!result.ok) throw new Error(result.detail);
		expect(result.sets.ignoredCandidates).toEqual(["scratch/a.ts"]);
	});

	it("P7: the default manifest's ignored-scan pathspec is its seven exact paths — 'scratch' is never a root a real git would walk (review finding 5 / UNIT D)", () => {
		const calls: string[][] = [];
		const result = collectLocalTreeInputs((args: readonly string[]) => {
			calls.push([...args]);
			// If the default still walked scratch/, a repo with real bulk under
			// it would return thousands of candidates here; this fake ignores
			// its own args and always returns a handful, so the assertion below
			// on `calls` — not on the result — is what actually proves the root
			// scoping: the pathspec never names "scratch".
			return bytes(args.includes("--ignored") ? "unrelated/x.ts\0" : "");
		}, manifest());
		if (!result.ok) throw new Error(result.detail);
		const ignoredCall = calls.find((call) => call.includes("--ignored"));
		expect(ignoredCall).toEqual([
			"ls-files",
			"--others",
			"--ignored",
			"--exclude-standard",
			"-z",
			"--",
			".interlinked/coverage-baseline.json",
			".interlinked/coverage-edit-baseline.json",
			".interlinked/guard-rules.json",
			".interlinked/large-files-baseline.json",
			".interlinked/metric-caps.json",
			".interlinked/mutation-baseline.json",
			".interlinked/untested-files-baseline.json",
		]);
		expect(ignoredCall).not.toContain("scratch");
	});
});

describe("collectLocalTreeInputs — negative (must reject)", () => {
	it("N1: it never splits on newlines — a newline path is ONE entry, not two", () => {
		expect(parseNulSeparated(bytes("we\nird.ts\0"))).toEqual({ ok: true, paths: ["we\nird.ts"] });
	});

	it("N2: a non-UTF-8 path byte rejects — never a U+FFFD substitution", () => {
		const raw = new Uint8Array([0x73, 0x72, 0x63, 0x2f, 0xff, 0xfe, 0x00]);
		expect(parseNulSeparated(raw)).toMatchObject({ ok: false });
		const result = collectLocalTreeInputs(() => raw, manifest());
		expect(result).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N3: a WTF-8 lone surrogate rejects too (fatal decoding, not replacement)", () => {
		const raw = new Uint8Array([0xed, 0xa0, 0x80, 0x00]);
		expect(parseNulSeparated(raw)).toMatchObject({ ok: false });
	});

	it("N4: an ignored scan over the candidate cap rejects rather than truncating", () => {
		const many = `${Array.from({ length: MAX_IGNORED_CANDIDATES + 1 }, (_, i) => `scratch/f${i}.ts`).join("\0")}\0`;
		const result = collectLocalTreeInputs(
			(args: readonly string[]) => bytes(args.includes("--ignored") ? many : ""),
			manifest(),
		);
		expect(result).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N6: the over-cap detail names the cap and the walked root, bounded — never the exact overflow count (review finding 5 / UNIT D)", () => {
		// Default no longer walks scratch (see overlayScanRoots P2), so this
		// exercises the opt-in path a caller would actually hit the cap on:
		// an explicit gitwildmatch-v1 rule over a gitignored directory.
		const optedIn = manifest([{ kind: "gitwildmatch-v1", pattern: "scratch/**" }]);
		const overflowCount = MAX_IGNORED_CANDIDATES + 1;
		const many = `${Array.from({ length: overflowCount }, (_, i) => `scratch/f${i}.ts`).join("\0")}\0`;
		const result = collectLocalTreeInputs((args: readonly string[]) => bytes(args.includes("--ignored") ? many : ""), optedIn);
		expect(result).toMatchObject({ ok: false, reason: "invalid_tree" });
		if (result.ok) throw new Error("expected rejection");
		expect(result.detail).toContain(String(MAX_IGNORED_CANDIDATES));
		expect(result.detail).toContain("scratch");
		expect(result.detail).not.toContain(String(overflowCount));
	});

	it("N7: the over-cap detail names at most eight roots and counts the rest — a 1024-rule manifest cannot ship a ~4 MB reason (verifier finding)", () => {
		const rules = Array.from({ length: 12 }, (_, i) => exact(`dir${String(i).padStart(2, "0")}/x.json`));
		const many = `${Array.from({ length: MAX_IGNORED_CANDIDATES + 1 }, (_, i) => `dir00/f${i}.ts`).join("\0")}\0`;
		const result = collectLocalTreeInputs((args: readonly string[]) => bytes(args.includes("--ignored") ? many : ""), manifest(rules));
		if (result.ok) throw new Error("expected rejection");
		expect(result.detail).toContain("dir07/x.json");
		expect(result.detail).not.toContain("dir08/x.json");
		expect(result.detail).toContain("… and 4 more");
		expect(result.detail.length).toBeLessThan(600);
	});

	it("N5: a manifest the canonicalizer refuses rejects before any git call", () => {
		const calls: string[][] = [];
		const result = collectLocalTreeInputs((args: readonly string[]) => {
			calls.push([...args]);
			return bytes("");
		}, manifest([]));
		expect(result).toMatchObject({ ok: false, reason: "invalid_tree" });
		expect(calls).toEqual([]);
	});
});
