// Malformed corpus, part 2 — manifests, change sets, tool input, and the
// three binding records (memo §8.1 exit gate: unknown field, unknown version,
// out-of-range id/string/integer, empty-string brand).
//
// A parser proves SHAPE ONLY. Hash equality, freshness, and signatures are
// checked elsewhere — an accepted record here is still untrusted evidence.

import { describe, expect, it } from "vitest";
import { SHADOW_LIMITS_V1 } from "./limits.js";
import type { ShadowParseOutcome } from "./parse-core-entries.js";
import {
	parseDependencyRequest,
	parseExecutionManifest,
	parseExpectedExecutionPolicy,
	parseNormalizedToolInput,
	parseResolvedDependencyBinding,
	parseShadowChangeSet,
	parseShadowExecutionBinding,
	parseShadowExecutionClaim,
	parseShadowFreshnessBinding,
} from "./parse-core.js";

const HEX = "a".repeat(64);
const SHA = "b".repeat(40);

// UTF-8 orders these two paths fullwidth-then-astral (0xEF… before 0xF0…);
// UTF-16 orders them the other way round (0xD800… before 0xFF21). The
// grammar means UTF-8 bytes, so the astral path sorts LAST.
const FULLWIDTH_PATH = "docs/Ａ.md";
const ASTRAL_PATH = "docs/\u{10000}.md";

type Obj = Record<string, unknown>;

function accepted<T>(outcome: ShadowParseOutcome<T>): T {
	if (!outcome.ok) throw new Error(`expected acceptance, got rejection: ${outcome.reason}`);
	return outcome.value;
}

function reasonOf(outcome: ShadowParseOutcome<unknown>): string {
	return outcome.ok ? "<accepted>" : outcome.reason;
}

const mirrorKey = (): Obj => ({ repository_id: "repo_01", session_id: "sess_01", kind: "synthetic_full_tree" });

const mirror = (): Obj => ({ key: mirrorKey(), version: 7 });

const overlayManifest = (): Obj => ({
	schema_version: 1,
	include_rules: [{ kind: "gitwildmatch-v1", pattern: "scratch/**" }],
	deny_ruleset_id: "shadow-overlay-deny-v1",
});

const writeEntry = (): Obj => ({ tag: "W", path: "src/a.ts", mode: "100644", blob_digest: HEX, bytes: 4 });

const executionManifest = (): Obj => ({
	schema_version: 1,
	mirror: mirror(),
	overlay_manifest: overlayManifest(),
	overlay: [writeEntry()],
	post_images: [writeEntry(), { tag: "D", path: "src/gone.ts" }],
});

const changeSet = (): Obj => ({
	schema_version: 1,
	pre_tree_hash: HEX,
	post_image_set_hash: HEX,
	touched_paths: ["src/a.ts", "src/gone.ts"],
});

const writeInput = (): Obj => ({
	schema: "shadow-tool-input-v1",
	client: "claude-code",
	tool: "Write",
	semantics_version: 1,
	file_path: "src/a.ts",
	content: "hello",
});

const editInput = (): Obj => ({
	schema: "shadow-tool-input-v1",
	client: "claude-code",
	tool: "Edit",
	semantics_version: 1,
	file_path: "src/a.ts",
	old_string: "a",
	new_string: "b",
	replace_all: false,
});

const multiEditInput = (): Obj => ({
	schema: "shadow-tool-input-v1",
	client: "claude-code",
	tool: "MultiEdit",
	semantics_version: 1,
	file_path: "src/a.ts",
	edits: [{ old_string: "a", new_string: "b", replace_all: true }],
});

const applyPatchInput = (): Obj => ({
	schema: "shadow-tool-input-v1",
	client: "codex",
	tool: "apply_patch",
	semantics_version: 1,
	patch: "*** Begin Patch\n*** End Patch\n",
	raw_source_field: "_raw_patch",
});

const claim = (): Obj => ({
	mirror: mirror(),
	base_ref: SHA,
	tree_algo: "shadow-tree-v1",
	post_image_algo: "shadow-postimages-v1",
	overlay_algo: "shadow-overlay-v1",
	overlay_manifest_hash: HEX,
	overlay_bytes_hash: HEX,
	pre_tree_hash: HEX,
	post_image_set_hash: HEX,
	post_tree_hash: HEX,
	dependencies: { mode: "npm-v1", input_hash: HEX },
});

const policy = (): Obj => ({
	tree_algo: "shadow-tree-v1",
	post_image_algo: "shadow-postimages-v1",
	overlay_algo: "shadow-overlay-v1",
	overlay_manifest_hash: HEX,
	env_digest: HEX,
	exec_config_hash: HEX,
	broker_scanner_policy_digest: HEX,
	deadline_at: "2026-09-03T12:00:00Z",
});

const resolvedFresh = (): Obj => ({
	mode: "npm-v1",
	source: "fresh",
	input_hash: HEX,
	tree_algo: "shadow-dependency-tree-v1",
	tree_hash: HEX,
});

const binding = (): Obj => ({
	...claim(),
	dependencies: resolvedFresh(),
	env_digest: HEX,
	exec_config_hash: HEX,
});

const freshness = (): Obj => ({
	base_local_head: SHA,
	local_head: SHA,
	input_hash: HEX,
	local_pre_tree_hash: HEX,
	local_overlay_manifest_hash: HEX,
	local_post_image_set_hash: HEX,
});

describe("parse-core — positive (must accept)", () => {
	it("P1: accepts an execution manifest and returns a frozen own-data copy", () => {
		const raw = executionManifest();
		const value = accepted(parseExecutionManifest(raw));
		expect(value.mirror.version).toBe(7);
		expect(value.post_images).toHaveLength(2);
		expect(Object.isFrozen(value)).toBe(true);
		raw.schema_version = 99;
		expect(value.schema_version).toBe(1);
	});

	it("P2: accepts a change set, including the create-then-delete no-op (no touched paths)", () => {
		expect(accepted(parseShadowChangeSet(changeSet())).touched_paths).toHaveLength(2);
		expect(parseShadowChangeSet({ ...changeSet(), touched_paths: [] }).ok).toBe(true);
	});

	it("P3: accepts all four normalized tool-input shapes", () => {
		expect(accepted(parseNormalizedToolInput(writeInput())).tool).toBe("Write");
		expect(accepted(parseNormalizedToolInput(editInput())).tool).toBe("Edit");
		expect(accepted(parseNormalizedToolInput(multiEditInput())).tool).toBe("MultiEdit");
		expect(accepted(parseNormalizedToolInput(applyPatchInput())).tool).toBe("apply_patch");
	});

	it("P4: accepts empty tool-input text — an empty Write and a deleting Edit", () => {
		expect(parseNormalizedToolInput({ ...writeInput(), content: "" }).ok).toBe(true);
		expect(parseNormalizedToolInput({ ...editInput(), new_string: "" }).ok).toBe(true);
	});

	it("P5: accepts every Codex apply-patch source field the daemon may record", () => {
		for (const field of ["command", "patch", "_raw_patch", "content"]) {
			expect(parseNormalizedToolInput({ ...applyPatchInput(), raw_source_field: field }).ok).toBe(true);
		}
	});

	it("P6: accepts the claim, the policy (with and without the cache hash), the binding and freshness", () => {
		expect(accepted(parseShadowExecutionClaim(claim())).base_ref).toBe(SHA);
		expect(parseExpectedExecutionPolicy(policy()).ok).toBe(true);
		expect(parseExpectedExecutionPolicy({ ...policy(), dependency_cache_record_hash: HEX }).ok).toBe(true);
		expect(accepted(parseShadowExecutionBinding(binding())).env_digest).toBe(HEX);
		expect(accepted(parseShadowFreshnessBinding(freshness())).local_head).toBe(SHA);
	});

	it("P8: accepts touched_paths in canonical UTF-8 order — one path, many paths, and an astral path last", () => {
		expect(parseShadowChangeSet({ ...changeSet(), touched_paths: ["src/a.ts"] }).ok).toBe(true);
		const ordered = ["Z.ts", "src/a.ts", "src/gone.ts", "src/z.ts"];
		expect(accepted(parseShadowChangeSet({ ...changeSet(), touched_paths: ordered })).touched_paths).toEqual(ordered);
		// UTF-8 puts the astral path LAST (0xF0…) and UTF-16 would put it first
		// (0xD800…), so this row pins which ordering the grammar means.
		const byUtf8 = [FULLWIDTH_PATH, ASTRAL_PATH];
		expect(parseShadowChangeSet({ ...changeSet(), touched_paths: byUtf8 }).ok).toBe(true);
	});

	it("P9: accepts a MultiEdit carrying exactly one edit", () => {
		expect(accepted(parseNormalizedToolInput(multiEditInput())).tool).toBe("MultiEdit");
	});

	it("P7: accepts both dependency REQUEST modes and all three RESOLVED shapes", () => {
		expect(parseDependencyRequest({ mode: "none" }).ok).toBe(true);
		expect(parseDependencyRequest({ mode: "npm-v1", input_hash: HEX }).ok).toBe(true);
		expect(parseResolvedDependencyBinding({ mode: "none" }).ok).toBe(true);
		expect(parseResolvedDependencyBinding(resolvedFresh()).ok).toBe(true);
		expect(
			parseResolvedDependencyBinding({ ...resolvedFresh(), source: "cache", cache_record_hash: HEX }).ok,
		).toBe(true);
	});
});

describe("parse-core — negative (must reject)", () => {
	it("N1: rejects a non-object, an array, and a non-cloneable wire value", () => {
		expect(parseExecutionManifest(null).ok).toBe(false);
		expect(parseShadowChangeSet([]).ok).toBe(false);
		expect(parseNormalizedToolInput("Write").ok).toBe(false);
		expect(parseShadowExecutionClaim({ fn: () => 1 }).ok).toBe(false);
	});

	it("N2: rejects an unknown field at the TOP level of every record", () => {
		expect(reasonOf(parseExecutionManifest({ ...executionManifest(), extra: 1 }))).toContain("unknown field");
		expect(reasonOf(parseShadowChangeSet({ ...changeSet(), extra: 1 }))).toContain("unknown field");
		expect(reasonOf(parseNormalizedToolInput({ ...writeInput(), extra: 1 }))).toContain("unknown field");
		expect(reasonOf(parseShadowExecutionClaim({ ...claim(), extra: 1 }))).toContain("unknown field");
		expect(reasonOf(parseExpectedExecutionPolicy({ ...policy(), extra: 1 }))).toContain("unknown field");
		expect(reasonOf(parseShadowExecutionBinding({ ...binding(), extra: 1 }))).toContain("unknown field");
		expect(reasonOf(parseShadowFreshnessBinding({ ...freshness(), extra: 1 }))).toContain("unknown field");
	});

	it("N3: rejects an unknown field at a NESTED level", () => {
		const badMirror = { key: { ...mirrorKey(), extra: 1 }, version: 1 };
		expect(reasonOf(parseExecutionManifest({ ...executionManifest(), mirror: badMirror }))).toContain("unknown field");
		expect(reasonOf(parseShadowExecutionClaim({ ...claim(), mirror: badMirror }))).toContain("unknown field");
		const badOverlay = [{ ...writeEntry(), extra: 1 }];
		expect(reasonOf(parseExecutionManifest({ ...executionManifest(), overlay: badOverlay }))).toContain("unknown field");
		const badEdits = [{ old_string: "a", new_string: "b", replace_all: true, extra: 1 }];
		expect(reasonOf(parseNormalizedToolInput({ ...multiEditInput(), edits: badEdits }))).toContain("unknown field");
		const badDeps = { mode: "npm-v1", input_hash: HEX, extra: 1 };
		expect(reasonOf(parseShadowExecutionClaim({ ...claim(), dependencies: badDeps }))).toContain("unknown field");
	});

	it("N4: rejects an unknown schema_version and an unknown semantics_version", () => {
		expect(parseExecutionManifest({ ...executionManifest(), schema_version: 2 }).ok).toBe(false);
		expect(parseShadowChangeSet({ ...changeSet(), schema_version: 0 }).ok).toBe(false);
		expect(parseNormalizedToolInput({ ...writeInput(), semantics_version: 2 }).ok).toBe(false);
		const staleOverlay = { ...overlayManifest(), schema_version: 2 };
		expect(parseExecutionManifest({ ...executionManifest(), overlay_manifest: staleOverlay }).ok).toBe(false);
	});

	it("N5: rejects a wrong literal discriminator — algo, schema, deny ruleset, mirror kind", () => {
		expect(reasonOf(parseShadowExecutionClaim({ ...claim(), tree_algo: "shadow-tree-v2" }))).toContain("tree_algo");
		expect(parseShadowExecutionClaim({ ...claim(), post_image_algo: "shadow-tree-v1" }).ok).toBe(false);
		expect(parseExpectedExecutionPolicy({ ...policy(), overlay_algo: "" }).ok).toBe(false);
		expect(parseNormalizedToolInput({ ...writeInput(), schema: "shadow-tool-input-v2" }).ok).toBe(false);
		const badKind = { key: { ...mirrorKey(), kind: "partial_tree" }, version: 1 };
		expect(parseExecutionManifest({ ...executionManifest(), mirror: badKind }).ok).toBe(false);
		expect(parseShadowExecutionBinding({ ...binding(), dependencies: { ...resolvedFresh(), tree_algo: "npm" } }).ok).toBe(
			false,
		);
	});

	it("N6: rejects an out-of-range integer — negative, fractional, and over the entry cap", () => {
		expect(parseExecutionManifest({ ...executionManifest(), mirror: { ...mirror(), version: -1 } }).ok).toBe(false);
		expect(parseExecutionManifest({ ...executionManifest(), mirror: { ...mirror(), version: 1.5 } }).ok).toBe(false);
		const huge = [{ ...writeEntry(), bytes: SHADOW_LIMITS_V1.single_entry_bytes + 1 }];
		expect(parseExecutionManifest({ ...executionManifest(), post_images: huge }).ok).toBe(false);
		expect(
			parseExecutionManifest({ ...executionManifest(), mirror: { ...mirror(), version: Number.MAX_VALUE } }).ok,
		).toBe(false);
	});

	it("N7: rejects an empty, over-long, or non-URL-safe id — no empty-string brand is ever valid", () => {
		const withId = (id: unknown): Obj => ({ key: { ...mirrorKey(), session_id: id }, version: 1 });
		expect(parseExecutionManifest({ ...executionManifest(), mirror: withId("") }).ok).toBe(false);
		expect(parseExecutionManifest({ ...executionManifest(), mirror: withId("a".repeat(129)) }).ok).toBe(false);
		expect(parseExecutionManifest({ ...executionManifest(), mirror: withId("sess/01") }).ok).toBe(false);
		expect(parseExecutionManifest({ ...executionManifest(), mirror: withId(7) }).ok).toBe(false);
	});

	it("N8: rejects a bad digest and a bad git sha — including the empty string", () => {
		expect(parseShadowChangeSet({ ...changeSet(), pre_tree_hash: "" }).ok).toBe(false);
		expect(parseShadowChangeSet({ ...changeSet(), post_image_set_hash: "zz" }).ok).toBe(false);
		expect(parseShadowExecutionClaim({ ...claim(), base_ref: HEX }).ok).toBe(false);
		expect(parseShadowFreshnessBinding({ ...freshness(), local_head: SHA.toUpperCase() }).ok).toBe(false);
		expect(parseShadowFreshnessBinding({ ...freshness(), input_hash: "" }).ok).toBe(false);
	});

	it("N9: rejects a traversal path and a symlink mode inside a manifest", () => {
		const traversal = [{ ...writeEntry(), path: "../../etc/passwd" }];
		expect(parseExecutionManifest({ ...executionManifest(), overlay: traversal }).ok).toBe(false);
		expect(parseShadowChangeSet({ ...changeSet(), touched_paths: ["../secret"] }).ok).toBe(false);
		expect(parseNormalizedToolInput({ ...writeInput(), file_path: "/etc/passwd" }).ok).toBe(false);
		const symlink = [{ ...writeEntry(), mode: "120000" }];
		expect(reasonOf(parseExecutionManifest({ ...executionManifest(), post_images: symlink }))).toContain("mode");
	});

	it("N10: rejects duplicate paths in an entry array and in touched_paths", () => {
		const twice = [writeEntry(), writeEntry()];
		expect(reasonOf(parseExecutionManifest({ ...executionManifest(), overlay: twice }))).toContain("duplicate");
		expect(reasonOf(parseShadowChangeSet({ ...changeSet(), touched_paths: ["a.ts", "a.ts"] }))).toContain("duplicate");
	});

	it("N11: rejects an unknown client/tool pair and a field from the WRONG tool shape", () => {
		expect(parseNormalizedToolInput({ ...writeInput(), tool: "NotebookEdit" }).ok).toBe(false);
		expect(parseNormalizedToolInput({ ...writeInput(), client: "cursor" }).ok).toBe(false);
		expect(parseNormalizedToolInput({ ...editInput(), content: "x" }).ok).toBe(false);
		expect(parseNormalizedToolInput({ ...applyPatchInput(), file_path: "src/a.ts" }).ok).toBe(false);
		expect(parseNormalizedToolInput({ ...applyPatchInput(), raw_source_field: "stdin" }).ok).toBe(false);
		expect(parseNormalizedToolInput({ ...editInput(), replace_all: "true" }).ok).toBe(false);
	});

	it("N12: rejects a dependency REQUEST that carries a resolved tree hash", () => {
		const withTree = { mode: "npm-v1", input_hash: HEX, tree_hash: HEX, tree_algo: "shadow-dependency-tree-v1" };
		expect(reasonOf(parseDependencyRequest(withTree))).toContain("unknown field");
		expect(reasonOf(parseShadowExecutionClaim({ ...claim(), dependencies: withTree }))).toContain("unknown field");
		expect(parseDependencyRequest({ mode: "none", input_hash: HEX }).ok).toBe(false);
	});

	it("N13: rejects a resolved binding with an unknown mode or source, or a missing cache hash", () => {
		expect(reasonOf(parseResolvedDependencyBinding({ mode: "pnpm-v1" }))).toContain("mode");
		expect(reasonOf(parseResolvedDependencyBinding({ ...resolvedFresh(), source: "warm" }))).toContain("source");
		expect(parseResolvedDependencyBinding({ ...resolvedFresh(), source: "cache" }).ok).toBe(false);
		expect(parseResolvedDependencyBinding({ ...resolvedFresh(), cache_record_hash: HEX }).ok).toBe(false);
		expect(parseShadowExecutionBinding({ ...binding(), dependencies: { mode: "npm-v1", input_hash: HEX } }).ok).toBe(
			false,
		);
	});

	it("N14: rejects a missing required field and a malformed deadline", () => {
		const { env_digest: _dropped, ...withoutEnv } = policy();
		expect(parseExpectedExecutionPolicy(withoutEnv).ok).toBe(false);
		expect(parseExpectedExecutionPolicy({ ...policy(), deadline_at: "tomorrow" }).ok).toBe(false);
		expect(parseExpectedExecutionPolicy({ ...policy(), deadline_at: "2026-13-45T99:00:00Z" }).ok).toBe(false);
		const { content: _noContent, ...writeWithoutContent } = writeInput();
		expect(parseNormalizedToolInput(writeWithoutContent).ok).toBe(false);
	});

	it("N16: rejects touched_paths that are not strictly ascending by UTF-8 bytes", () => {
		const descending = { ...changeSet(), touched_paths: ["src/b.ts", "src/a.ts"] };
		expect(reasonOf(parseShadowChangeSet(descending))).toContain("canonical");
		expect(parseShadowChangeSet(descending).ok).toBe(false);
		// Sorted by UTF-16 code units, which puts the astral path first — the
		// wrong ordering, and the one a naive `.sort()` produces.
		const byUtf16 = { ...changeSet(), touched_paths: [ASTRAL_PATH, FULLWIDTH_PATH] };
		expect(parseShadowChangeSet(byUtf16).ok).toBe(false);
		const unsortedTriple = { ...changeSet(), touched_paths: ["src/a.ts", "src/z.ts", "src/b.ts"] };
		expect(parseShadowChangeSet(unsortedTriple).ok).toBe(false);
	});

	it("N17: rejects a MultiEdit with an empty edit list — no_edits", () => {
		const outcome = parseNormalizedToolInput({ ...multiEditInput(), edits: [] });
		expect(outcome.ok).toBe(false);
		expect(reasonOf(outcome)).toContain("no_edits");
	});

	it("N15: rejects an over-long string and an oversized array", () => {
		const bigPattern = { ...overlayManifest(), include_rules: [{ kind: "gitwildmatch-v1", pattern: "x".repeat(4097) }] };
		expect(parseExecutionManifest({ ...executionManifest(), overlay_manifest: bigPattern }).ok).toBe(false);
		const overCap = Array.from({ length: SHADOW_LIMITS_V1.entries + 1 }, (_unused, index) => `f${index}.ts`);
		expect(reasonOf(parseShadowChangeSet({ ...changeSet(), touched_paths: overCap }))).toContain("exceeds");
		expect(parseNormalizedToolInput({ ...writeInput(), content: "x".repeat(1_048_577) }).ok).toBe(false);
	});
});
