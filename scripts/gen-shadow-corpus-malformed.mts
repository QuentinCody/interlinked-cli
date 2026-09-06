// The malformed corpus (`malformed-corpus.json`), one half of
// `gen-shadow-corpus.mts`. The rows are hand-authored — they are not derived
// from any implementation, which is the point of them. This module owns:
//   - the `reviewed` note every legacy row must carry (a row with none is a
//     hard failure, so a hand-added row cannot land without one);
//   - VALUE FIXES for legacy rows whose value stopped rejecting on the rule
//     they NAME once the parsers tightened (an empty `include_rules` now
//     refuses before the deny-ruleset literal or the symlink mode is read);
//   - the rows the projection expansion and the second review added.
// The corpus test asserts only that every row REJECTS; which rule fired is
// what the `reviewed` note tells a human to check.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedToolInputV1 } from "../src/harness/shadow/protocol/types-core.js";

export interface MalformedRow {
	id: string;
	parser: string;
	class: string;
	note: string;
	reviewed: string;
	value: unknown;
}

const SCHEMA = "shadow-tool-input-v1" as const;
const CC = "claude-code" as const;
const DENY = "shadow-overlay-deny-v1" as const;
const HEX64 = "a".repeat(64);
const MIRROR = { key: { repository_id: "repo_01", session_id: "sess_01", kind: "synthetic_full_tree" }, version: 7 };
const ONE_RULE = [{ kind: "exact", path: ".interlinked/metric-caps.json" }];
/** The canonicalizer's `MAX_OVERLAY_INCLUDE_RULES` plus one; the parser must
 *  share that cap, not the 100000-entry content cap. */
const OVER_RULE_CAP = 1025;

const REVIEWED: Record<string, string> = {
	"change-set-unknown-field-top": "the parser REJECTS rather than stripping `extra` — silently dropping an unknown field would let a newer sender lose data and still be signed for",
	"change-set-unknown-version": "schema_version 2 is refused outright; there is no forward-compatible fallback to v1",
	"change-set-empty-brand": "the refusal is on EMPTINESS, not on length alone — no empty-string sentinel is ever a valid brand",
	"change-set-traversal-path": "a `..` segment is refused, never normalized away",
	"execution-manifest-nested-unknown-field": "the unknown field is NESTED — the parser must recurse, not just check the top level",
	"execution-manifest-negative-version": "the bound is integer AND non-negative, not merely `typeof value === number`",
	"execution-manifest-symlink-mode": "mode 120000 is refused everywhere in v0 (memo §5.1), and the reason names the mode — the overlay manifest carries one valid rule so THIS is the rule that fires",
	"overlay-manifest-foreign-deny-ruleset": "the deny ruleset id is broker-owned; a daemon-supplied id must never be honored — the manifest carries one valid rule so the literal check, not the empty-list check, is what refuses",
	"tool-input-unknown-tool": "an unsupported tool is refused, not degraded into a generic write",
	"tool-input-cross-shape-field": "a field that is valid on ANOTHER variant of the union is still unknown on this one",
	"tool-input-unknown-semantics-version": "semantics_version is a literal, not a minimum",
	"claim-carries-env-digest": "the daemon cannot know an env digest, so a claim carrying one is refused (memo §8.0, facts belong to the party that can know them)",
	"dependency-request-carries-tree-hash": "the REQUEST side can never carry a tree hash — nobody holds one before the install runs",
	"freshness-empty-head": "an empty string is not a head; the freshness check would otherwise compare disk against nothing",
	"outcome-reason-phase-mismatch": "the reason is legal and the phase is legal, but not TOGETHER — check REASON_PHASES is consulted, not just the two enums",
	"outcome-binding-mismatch-empty-list": "a binding-mismatch outcome with an empty mismatch list is unrepresentable — it would report a failure naming no field",
	"outcome-attestation-without-verifier": "an attestation with no verifier result is unrepresentable — the signature would attest to nothing",
};

/** Legacy rows whose recorded value must change so the NAMED rule is the one
 *  that fires. Applied by id; the row's other fields are kept. */
const VALUE_FIXES: Record<string, (value: unknown) => unknown> = {
	"execution-manifest-symlink-mode": (value) => withOneRule(value, "overlay_manifest"),
	"overlay-manifest-foreign-deny-ruleset": (value) => ({ ...asRecord(value), include_rules: ONE_RULE }),
};
function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("malformed row value is not an object");
	// SAFETY: guarded one line above.
	return value as Record<string, unknown>;
}
function withOneRule(value: unknown, key: string): Record<string, unknown> {
	const record = asRecord(value);
	return { ...record, [key]: { ...asRecord(record[key]), include_rules: ONE_RULE } };
}

function overlayManifest(includeRules: readonly unknown[]) {
	return { schema_version: 1, include_rules: includeRules, deny_ruleset_id: DENY };
}
function exact(path: string) {
	return { kind: "exact", path };
}
function pattern(text: string) {
	return { kind: "gitwildmatch-v1", pattern: text };
}
function executionManifest(overrides: Record<string, unknown>) {
	return { schema_version: 1, mirror: MIRROR, overlay_manifest: overlayManifest(ONE_RULE), overlay: [], post_images: [], ...overrides };
}
function cacheRecord(createdAt: string) {
	return {
		schema_version: 1,
		input_hash: HEX64,
		image_manifest_digest: "sha256:image",
		npm_version: "10.9.0",
		registry_policy_digest: HEX64,
		broker_scanner_policy_digest: HEX64,
		tree_algo: "shadow-dependency-tree-v1",
		tree_hash: HEX64,
		backup_handle: "handle-1",
		expires_at: "2026-10-01T00:00:00Z",
		created_at: createdAt,
	};
}
function claimWithRepositoryId(repositoryId: string) {
	return {
		mirror: { key: { repository_id: repositoryId, session_id: "sess_01", kind: "synthetic_full_tree" }, version: 7 },
		base_ref: "b".repeat(40),
		tree_algo: "shadow-tree-v1",
		post_image_algo: "shadow-postimages-v1",
		overlay_algo: "shadow-overlay-v1",
		overlay_manifest_hash: HEX64,
		overlay_bytes_hash: HEX64,
		pre_tree_hash: HEX64,
		post_image_set_hash: HEX64,
		post_tree_hash: HEX64,
		dependencies: { mode: "npm-v1", input_hash: HEX64 },
	};
}
function changeSetWithPreTreeHash(preTreeHash: string, touchedPaths: readonly string[]) {
	return { schema_version: 1, pre_tree_hash: preTreeHash, post_image_set_hash: "b".repeat(64), touched_paths: touchedPaths };
}
function overRuleCapRules(): unknown[] {
	return Array.from({ length: OVER_RULE_CAP }, (_, index) => exact(`f${String(index).padStart(4, "0")}.json`));
}

function malformed(id: string, parser: string, cls: string, note: string, reviewed: string, value: unknown): MalformedRow {
	return { id, parser, class: cls, note, reviewed, value };
}

// ── the projection expansion's rows ────────────────────────────────────────
/** `write` / `edit` are the projection generator's tool-input builders, so
 *  the two path rows are built by the same code the projection rows use. */
export function projectionExpansionRows(write: NormalizedToolInputV1, edit: NormalizedToolInputV1): readonly MalformedRow[] {
	return [
		malformed("tool-input-absolute-file-path", "tool_input", "invalid_path", "an absolute file_path escapes the workspace the post-image set is defined over", "refused before projection, not confined after it — a path this shape must never reach the materializer", write),
		malformed("tool-input-traversal-file-path", "tool_input", "invalid_path", "a `..` segment in a tool input escapes the workspace", "the rule the tree grammar applies to entries applies to tool inputs too — separate code paths, check both", edit),
	];
}
const SHAPE_ROWS: readonly MalformedRow[] = [
	malformed("tool-input-apply-patch-unknown-source-field", "tool_input", "wrong_literal", "raw_source_field is a closed set of runner payload keys", "the four accepted keys are the ones apply-patch-content.ts knows; a fifth would be an unaudited precedence rule", { schema: SCHEMA, client: "codex", tool: "apply_patch", semantics_version: 1, patch: "*** Begin Patch\n*** End Patch", raw_source_field: "stdin" }),
	malformed("tool-input-multiedit-edit-unknown-field", "tool_input", "unknown_field_nested", "an unknown field inside a MultiEdit entry, two levels down", "the recursion reaches ARRAY ELEMENTS, not only nested objects", { schema: SCHEMA, client: CC, tool: "MultiEdit", semantics_version: 1, file_path: "src/a.ts", edits: [{ old_string: "a", new_string: "b", replace_all: false, note: "x" }] }),
	malformed("change-set-duplicate-touched-path", "change_set", "out_of_range", "one path may appear at most once in touched_paths", "identity is byte-equality over the three fields, so a duplicate would make two encodings of one change compare unequal", changeSetWithPreTreeHash(HEX64, ["src/a.ts", "src/a.ts"])),
	malformed("change-set-short-digest", "change_set", "out_of_range", "a digest that is not 64 lowercase hex characters", "63 characters is refused — check the bound is an exact width, not a minimum", changeSetWithPreTreeHash("a".repeat(63), ["src/a.ts"])),
	// Canonical-ORDER rules: change-set identity is POSITIONAL, so an encoding
	// differing only in the order of `touched_paths` would carry identical
	// hashes and still compare as a different change (memo §8.0).
	malformed("change-set-unsorted-touched-paths", "change_set", "non_canonical_order", "touched_paths must be strictly ascending by UTF-8 bytes", "the refusal is on ORDER, not on content — the same two paths ascending are accepted, which is what makes the encoding canonical", changeSetWithPreTreeHash(HEX64, ["src/b.ts", "src/a.ts"])),
	malformed("change-set-touched-paths-utf16-order", "change_set", "non_canonical_order", "sorted by UTF-16 code units, which a naive .sort() produces; UTF-8 orders the astral path LAST", "THE row that separates the two orderings — an implementation comparing with String#< instead of bytes accepts it", changeSetWithPreTreeHash(HEX64, ["docs/\u{10000}.md", "docs/Ａ.md"])),
	malformed("tool-input-multiedit-empty-edits", "tool_input", "empty_non_empty_list", "a MultiEdit with no edits changes nothing (no_edits) and must not reach admission", "the refusal is on the EMPTY list, not on the shape — the same record with one edit is accepted", { schema: SCHEMA, client: CC, tool: "MultiEdit", semantics_version: 1, file_path: "src/a.ts", edits: [] }),
];

// ── second review: the overlay manifest on the WIRE ────────────────────────
// The wire parser reads in `canonical` mode: the sender must have
// canonicalized, or its hash could never match. `canonicalizeOverlayManifest`
// ACCEPTS the order/spelling rows below (sorting is its job); every row here
// is adjudicated against the PARSER, which is what the corpus names.
const OVERLAY_MANIFEST_ROWS: readonly MalformedRow[] = [
	malformed("overlay-manifest-empty-include-rules", "overlay_manifest", "empty_non_empty_list", "an overlay manifest must name at least one include rule", "the canonicalizer and the wire parser now agree — an empty allowlist is a manifest that ships nothing and hashes as if it were meant", overlayManifest([])),
	malformed("overlay-manifest-impossible-class", "overlay_manifest", "invalid_path", "a gitwildmatch-v1 pattern with an out-of-order character class ([z-a])", "refused by the glob validator, not accepted as a bounded string — a pattern the matcher cannot compile must never reach selection", overlayManifest([pattern("[z-a]")])),
	malformed("overlay-manifest-duplicate-exact-rule", "overlay_manifest", "non_canonical_order", "the same exact path twice is a duplicate rule", "the duplicate is measured on the exact path bytewise; the second copy is refused, not deduplicated", overlayManifest([exact("src/a.ts"), exact("src/a.ts")])),
	malformed("overlay-manifest-duplicate-pattern-after-normalization", "overlay_manifest", "non_canonical_order", "scratch/** and /scratch/** normalize to one rule, so listing both is a duplicate", "the duplicate is measured AFTER normalization — two spellings of one pattern are one rule", overlayManifest([pattern("scratch/**"), pattern("/scratch/**")])),
	malformed("overlay-manifest-pattern-before-exact", "overlay_manifest", "non_canonical_order", "a wire manifest must arrive canonical: exact rules precede pattern rules", "the canonicalizer sorts this; the PARSER refuses it — the sender must canonicalize or its hash cannot match", overlayManifest([pattern("scratch/**"), exact("src/a.ts")])),
	malformed("overlay-manifest-exact-rules-unsorted", "overlay_manifest", "non_canonical_order", "exact rules must be in bytewise path order on the wire", "same canonicalizer caveat: accepted by the sorter, refused by the wire parser", overlayManifest([exact("src/b.ts"), exact("src/a.ts")])),
	malformed("overlay-manifest-unnormalized-pattern", "overlay_manifest", "non_canonical_order", "a redundant leading '/' on a multi-segment pattern is not canonical spelling", "the sender must send scratch/**; the canonicalizer would normalize, the wire parser refuses", overlayManifest([pattern("/scratch/**")])),
	malformed("overlay-manifest-over-rule-cap", "overlay_manifest", "out_of_range", `${OVER_RULE_CAP} include rules exceed the canonicalizer's MAX_OVERLAY_INCLUDE_RULES (${OVER_RULE_CAP - 1})`, "the parser uses the same cap as the canonicalizer, not the 100000-entry content cap — the rules are canonical (sorted, unique), so the COUNT is the only thing that refuses", overlayManifest(overRuleCapRules())),
];

// ── second review: brand shapes the schema DOES carry ──────────────────────
const BRAND_SHAPE_ROWS: readonly MalformedRow[] = [
	malformed("change-set-uppercase-digest", "change_set", "out_of_range", "an uppercase-hex digest is not a lowercase 64-hex sha-256", "schema pattern AND parser both reject — this pins the digest pattern in the shared corpus", changeSetWithPreTreeHash(HEX64.toUpperCase(), ["src/a.ts"])),
	malformed("execution-manifest-fractional-entry-bytes", "execution_manifest", "out_of_range", "an overlay entry whose byte count is not an integer", "schema `type: integer` and the parser's safe-non-negative-integer check both reject 1.5", executionManifest({ overlay: [{ tag: "W", path: "src/a.ts", mode: "100644", blob_digest: HEX64, bytes: 1.5 }] })),
	malformed("execution-manifest-fractional-version", "execution_manifest", "out_of_range", "a fractional mirror version", "the integer half of the bound the negative-version row pins — 1.5 is refused by schema and parser alike", executionManifest({ mirror: { ...MIRROR, version: 1.5 } })),
	malformed("dependency-cache-record-rfc3339-shape", "dependency_cache_record", "invalid_timestamp", "a persisted record whose created_at is not RFC3339-shaped (space instead of T)", "the shape rule — schema pattern and parser both reject; a stored record is decoded as strictly as a wire one", cacheRecord("2026-09-04 00:00:00Z")),
	malformed("dependency-cache-record-impossible-instant", "dependency_cache_record", "invalid_timestamp", "an RFC3339-shaped instant that does not exist on the calendar (February 30)", "schema ACCEPTS (the pattern is shape-only); the parser's calendar rule rejects — this row belongs to the pinned schema gap", cacheRecord("2026-02-30T12:00:00Z")),
	malformed("claim-opaque-id-leading-dash", "claim", "invalid_id", "an OpaqueId starting with '-'", "schema pattern and parser both reject — a leading dash would read as a flag anywhere the id reaches a command line", claimWithRepositoryId("-lead")),
	malformed("claim-opaque-id-space", "claim", "invalid_id", "an OpaqueId containing a space", "schema pattern and parser both reject — the id grammar is URL-safe, and a space is never a byte of it", claimWithRepositoryId("has space")),
];

export const ADDED_MALFORMED_ROWS: readonly MalformedRow[] = [...SHAPE_ROWS, ...OVERLAY_MANIFEST_ROWS, ...BRAND_SHAPE_ROWS];

/** Read the committed rows, attach every `reviewed` note, apply the value
 *  fixes, then append (or refresh) the generator-owned rows. */
export function malformedCorpus(outDir: string, added: readonly MalformedRow[]): MalformedRow[] {
	// SAFETY: a repo-committed fixture this generator both reads and rewrites;
	// a shape drift fails the `reviewed` lookup below rather than passing.
	const existing = JSON.parse(readFileSync(join(outDir, "malformed-corpus.json"), "utf-8")) as MalformedRow[];
	const rows = existing.map((item) => {
		const reviewed = REVIEWED[item.id] ?? item.reviewed;
		if (reviewed === undefined) throw new Error(`malformed row ${item.id} has no reviewed note — add one to REVIEWED`);
		const fix = VALUE_FIXES[item.id];
		return { id: item.id, parser: item.parser, class: item.class, note: item.note, reviewed, value: fix === undefined ? item.value : fix(item.value) };
	});
	for (const item of added) {
		const index = rows.findIndex((row) => row.id === item.id);
		if (index < 0) rows.push(item);
		else rows[index] = item;
	}
	return rows;
}
