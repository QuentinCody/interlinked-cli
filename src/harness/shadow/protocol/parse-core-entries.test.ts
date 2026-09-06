// Malformed corpus, part 1 — entry and overlay-manifest records (memo §8.1
// exit gate: "rejects the complete malformed corpus"). A parser proves SHAPE
// only: hashes, freshness, and signatures are checked elsewhere, so an
// accepted record here is still untrusted evidence.

import { describe, expect, it } from "vitest";
import { SHADOW_LIMITS_V1 } from "./limits.js";
import { canonicalizeOverlayManifest, MAX_OVERLAY_INCLUDE_RULES } from "./overlay-manifest.js";
import {
	type ShadowParseOutcome,
	parseManifestEntry,
	parseOverlayEntry,
	parseOverlayManifest,
	parsePostImageEntry,
} from "./parse-core-entries.js";

const HEX = "a".repeat(64);

/** `count` exact rules already in canonical (bytewise) order. */
function exactRules(count: number): { kind: "exact"; path: string }[] {
	return Array.from({ length: count }, (_, i) => ({ kind: "exact" as const, path: `f${String(i).padStart(4, "0")}.json` }));
}

function writeEntry(): Record<string, unknown> {
	return { tag: "W", path: "src/a.ts", mode: "100644", blob_digest: HEX, bytes: 12 };
}

function overlayManifest(): Record<string, unknown> {
	return {
		schema_version: 1,
		include_rules: [
			{ kind: "exact", path: "src/a.ts" },
			{ kind: "gitwildmatch-v1", pattern: "scratch/**" },
		],
		deny_ruleset_id: "shadow-overlay-deny-v1",
	};
}

function reasonOf(outcome: { ok: true } | { ok: false; reason: string }): string {
	return outcome.ok ? "<accepted>" : outcome.reason;
}

/** Unwrap an accepted outcome — the branch lives HERE so no test body has to
 *  carry a conditional. */
function accepted<T>(outcome: ShadowParseOutcome<T>): T {
	if (!outcome.ok) throw new Error(`expected acceptance, got rejection: ${outcome.reason}`);
	return outcome.value;
}

describe("parse-core-entries — positive (must accept)", () => {
	it("P1: accepts a manifest entry and returns a frozen own-data copy", () => {
		const raw = { path: "src/a.ts", mode: "100755", blob_digest: HEX, bytes: 0 };
		const value = accepted(parseManifestEntry(raw));
		expect(value.path).toBe("src/a.ts");
		expect(Object.isFrozen(value)).toBe(true);
		raw.bytes = 999;
		expect(value.bytes).toBe(0);
	});

	it("P2: accepts both overlay tags — W with content fields, D with a path only", () => {
		expect(parseOverlayEntry(writeEntry()).ok).toBe(true);
		expect(parseOverlayEntry({ tag: "D", path: "src/gone.ts" }).ok).toBe(true);
	});

	it("P3: accepts both post-image tags", () => {
		expect(parsePostImageEntry(writeEntry()).ok).toBe(true);
		expect(parsePostImageEntry({ tag: "D", path: "a/b/c.txt" }).ok).toBe(true);
	});

	it("P4: accepts an overlay manifest carrying both include-rule kinds", () => {
		const value = accepted(parseOverlayManifest(overlayManifest()));
		expect(value.include_rules).toHaveLength(2);
		expect(value.include_rules[0]).toEqual({ kind: "exact", path: "src/a.ts" });
		expect(value.deny_ruleset_id).toBe("shadow-overlay-deny-v1");
	});

	it("P5: accepts exactly the canonicalizer's rule cap and a maximum-size entry", () => {
		const atCap = { ...overlayManifest(), include_rules: exactRules(MAX_OVERLAY_INCLUDE_RULES) };
		expect(parseOverlayManifest(atCap).ok).toBe(true);
		expect(parseOverlayEntry({ ...writeEntry(), bytes: SHADOW_LIMITS_V1.single_entry_bytes }).ok).toBe(true);
	});

	it("P6: a parsed manifest is already canonical — canonicalizing it keeps the rules and the hash", () => {
		const parsed = accepted(parseOverlayManifest(overlayManifest()));
		const fromParsed = canonicalized(parsed);
		expect(fromParsed.manifest).toEqual(parsed);
		// SAFETY: the same wire object feeds the canonicalizer directly; the
		// runtime validator, not the compiler, is the subject under test.
		const direct = canonicalized(overlayManifest() as unknown as typeof parsed);
		expect(fromParsed.hash).toBe(direct.hash);
	});
});

/** Unwrap an accepted canonicalization — the branch lives HERE, not in a test body. */
function canonicalized(manifest: Parameters<typeof canonicalizeOverlayManifest>[0]) {
	const result = canonicalizeOverlayManifest(manifest);
	if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.detail}`);
	return result;
}

describe("parse-core-entries — negative (must reject)", () => {
	it("N1: rejects a non-object and a non-cloneable wire value", () => {
		expect(parseManifestEntry(null).ok).toBe(false);
		expect(parseManifestEntry([1, 2]).ok).toBe(false);
		expect(parseManifestEntry("entry").ok).toBe(false);
		expect(parseManifestEntry({ fn: () => 1 }).ok).toBe(false);
	});

	it("N2: rejects an unknown field at the TOP level", () => {
		expect(reasonOf(parseManifestEntry({ ...writeEntryFields(), extra: 1 }))).toContain("unknown field");
		expect(reasonOf(parseOverlayEntry({ ...writeEntry(), extra: 1 }))).toContain("unknown field");
		expect(reasonOf(parseOverlayManifest({ ...overlayManifest(), extra: 1 }))).toContain("unknown field");
	});

	it("N3: rejects an unknown field at a NESTED level (an include rule)", () => {
		const manifest = { ...overlayManifest(), include_rules: [{ kind: "exact", path: "a.ts", extra: 1 }] };
		expect(reasonOf(parseOverlayManifest(manifest))).toContain("unknown field");
	});

	it("N4: rejects an unknown schema_version and a wrong deny-ruleset literal", () => {
		expect(parseOverlayManifest({ ...overlayManifest(), schema_version: 2 }).ok).toBe(false);
		expect(parseOverlayManifest({ ...overlayManifest(), schema_version: "1" }).ok).toBe(false);
		expect(parseOverlayManifest({ ...overlayManifest(), deny_ruleset_id: "shadow-overlay-deny-v2" }).ok).toBe(false);
	});

	it("N5: rejects a D entry that carries mode, digest, or bytes", () => {
		expect(parseOverlayEntry({ tag: "D", path: "a.ts", mode: "100644" }).ok).toBe(false);
		expect(parseOverlayEntry({ tag: "D", path: "a.ts", blob_digest: HEX }).ok).toBe(false);
		expect(parsePostImageEntry({ tag: "D", path: "a.ts", bytes: 0 }).ok).toBe(false);
	});

	it("N6: rejects an unknown or missing tag", () => {
		expect(reasonOf(parseOverlayEntry({ tag: "X", path: "a.ts" }))).toContain("tag");
		expect(parseOverlayEntry({ path: "a.ts" }).ok).toBe(false);
		expect(parsePostImageEntry({ tag: 1, path: "a.ts" }).ok).toBe(false);
	});

	it("N7: rejects out-of-range byte counts — negative, fractional, over cap, non-numeric", () => {
		expect(parseOverlayEntry({ ...writeEntry(), bytes: -1 }).ok).toBe(false);
		expect(parseOverlayEntry({ ...writeEntry(), bytes: 1.5 }).ok).toBe(false);
		expect(parseOverlayEntry({ ...writeEntry(), bytes: SHADOW_LIMITS_V1.single_entry_bytes + 1 }).ok).toBe(false);
		expect(parseOverlayEntry({ ...writeEntry(), bytes: Number.NaN }).ok).toBe(false);
		expect(parseOverlayEntry({ ...writeEntry(), bytes: "12" }).ok).toBe(false);
	});

	it("N8: rejects a bad blob digest — wrong length, uppercase, empty-string brand", () => {
		expect(parseOverlayEntry({ ...writeEntry(), blob_digest: "abc" }).ok).toBe(false);
		expect(parseOverlayEntry({ ...writeEntry(), blob_digest: HEX.toUpperCase() }).ok).toBe(false);
		expect(parseOverlayEntry({ ...writeEntry(), blob_digest: "" }).ok).toBe(false);
	});

	it("N9: rejects a traversal, absolute, empty, or backslash path", () => {
		expect(parseOverlayEntry({ ...writeEntry(), path: "../etc/passwd" }).ok).toBe(false);
		expect(parseOverlayEntry({ ...writeEntry(), path: "/etc/passwd" }).ok).toBe(false);
		expect(parseOverlayEntry({ ...writeEntry(), path: "" }).ok).toBe(false);
		expect(parseOverlayEntry({ ...writeEntry(), path: "src\\a.ts" }).ok).toBe(false);
		expect(parseOverlayEntry({ ...writeEntry(), path: "src//a.ts" }).ok).toBe(false);
	});

	it("N10: rejects a symlink mode, a submodule mode, and a directory mode", () => {
		expect(reasonOf(parseOverlayEntry({ ...writeEntry(), mode: "120000" }))).toContain("mode");
		expect(parseOverlayEntry({ ...writeEntry(), mode: "160000" }).ok).toBe(false);
		expect(parseOverlayEntry({ ...writeEntry(), mode: "40000" }).ok).toBe(false);
	});

	it("N11: rejects an include rule of unknown kind, wrong shape, or empty pattern", () => {
		const withRules = (rules: unknown): Record<string, unknown> => ({ ...overlayManifest(), include_rules: rules });
		expect(reasonOf(parseOverlayManifest(withRules([{ kind: "regex", pattern: ".*" }])))).toContain("kind");
		expect(parseOverlayManifest(withRules([{ kind: "exact", pattern: "a" }])).ok).toBe(false);
		expect(parseOverlayManifest(withRules([{ kind: "gitwildmatch-v1", pattern: "" }])).ok).toBe(false);
		expect(parseOverlayManifest(withRules(["src/a.ts"])).ok).toBe(false);
		expect(parseOverlayManifest(withRules({})).ok).toBe(false);
	});

	it("N12: rejects an EMPTY include-rule list — the canonicalizer refuses it, so the parser must too", () => {
		expect(reasonOf(parseOverlayManifest({ ...overlayManifest(), include_rules: [] }))).toContain("at least one rule");
	});

	it("N13: rejects a pattern the glob validator refuses ([z-a], '..' segment) — not merely a bounded string", () => {
		const withRules = (rules: unknown): Record<string, unknown> => ({ ...overlayManifest(), include_rules: rules });
		expect(reasonOf(parseOverlayManifest(withRules([{ kind: "gitwildmatch-v1", pattern: "[z-a]" }])))).toContain(
			"character class",
		);
		expect(parseOverlayManifest(withRules([{ kind: "gitwildmatch-v1", pattern: "../escape/**" }])).ok).toBe(false);
	});

	it("N14: rejects duplicate rules — an exact path twice, and a pattern twice after normalization", () => {
		const withRules = (rules: unknown): Record<string, unknown> => ({ ...overlayManifest(), include_rules: rules });
		const exactTwice = [
			{ kind: "exact", path: "src/a.ts" },
			{ kind: "exact", path: "src/a.ts" },
		];
		expect(reasonOf(parseOverlayManifest(withRules(exactTwice)))).toContain("duplicate");
		const patternTwice = [
			{ kind: "gitwildmatch-v1", pattern: "scratch/**" },
			{ kind: "gitwildmatch-v1", pattern: "/scratch/**" },
		];
		expect(parseOverlayManifest(withRules(patternTwice)).ok).toBe(false);
	});

	it("N15: rejects NON-CANONICAL input — a pattern before an exact rule, exact rules out of byte order, an un-normalized pattern", () => {
		const withRules = (rules: unknown): Record<string, unknown> => ({ ...overlayManifest(), include_rules: rules });
		const patternFirst = [
			{ kind: "gitwildmatch-v1", pattern: "scratch/**" },
			{ kind: "exact", path: "src/a.ts" },
		];
		expect(reasonOf(parseOverlayManifest(withRules(patternFirst)))).toContain("canonical");
		const outOfOrder = [
			{ kind: "exact", path: "src/b.ts" },
			{ kind: "exact", path: "src/a.ts" },
		];
		expect(parseOverlayManifest(withRules(outOfOrder)).ok).toBe(false);
		expect(parseOverlayManifest(withRules([{ kind: "gitwildmatch-v1", pattern: "/scratch/**" }])).ok).toBe(false);
	});

	it("N16: rejects one rule more than the canonicalizer's cap", () => {
		const overCap = { ...overlayManifest(), include_rules: exactRules(MAX_OVERLAY_INCLUDE_RULES + 1) };
		expect(reasonOf(parseOverlayManifest(overCap))).toContain(String(MAX_OVERLAY_INCLUDE_RULES));
	});
});

function writeEntryFields(): Record<string, unknown> {
	return { path: "src/a.ts", mode: "100644", blob_digest: HEX, bytes: 12 };
}
