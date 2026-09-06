// ===========================================
// Plan 00 exit gates G1–G3 — the corpus, EXECUTED
// ===========================================
// `protocol/shadow-v1/fixtures/` is the cross-repository contract: the same
// rows must be run by `interlinked-cloud` when the protocol is vendored
// there. A fixture nobody executes is worse than no fixture, so every row in
// every file is driven through the reference implementation here.
//
//   G1  the reference implementation reproduces exact post trees for the
//       supported-client corpus            → projection-corpus.json
//   G2  it rejects the complete malformed corpus → malformed-corpus.json
//   G3  the content-identity equality table is a test → identity-table.json
//   I4  the three-view binding comparison reports exactly the adjudicated
//       mismatches (memo I4)              → binding-corpus.json
//   (hash-vectors.json pins the byte grammars the other three build on.)
//
// The expectations are NOT this package's own output: `scripts/gen-shadow-corpus.mts`
// computes every projection, hash and identity with
// `scripts/shadow-projection-oracle.mts`, a second implementation written from
// the memo, and refuses to write a fixture the two do not agree on. The binding
// rows carry expectations adjudicated in review and hashes from the oracle's
// canonical profile; the generator asserts the product agrees before writing.
//
// THE DISPUTE MECHANISM. A row the two implementations genuinely disagree on
// is recorded as `disputed`: the fixture carries BOTH answers plus a written
// adjudication, and the N3 case below pins the product's CURRENT behavior so
// that fixing the defect goes red here and forces the dispute to be closed
// rather than forgotten. P4 asserts the dispute list by name, so the standing
// count (zero, since the first three disputes were fixed) is a claim this
// suite makes, never a silence it tolerates.
//
// Regenerate with `npx tsx scripts/gen-shadow-corpus.mts` — and only when the
// contract deliberately changes.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type BindingComparisonInputV1, compareBindings } from "../binding-compare.js";
import { computeChangeSet, sameContentIdentity } from "../changeset.js";
import type { ShadowParseOutcome } from "../parse-core-entries.js";
import {
	parseDependencyRequest,
	parseExecutionManifest,
	parseNormalizedToolInput,
	parseOverlayManifest,
	parseShadowChangeSet,
	parseShadowExecutionClaim,
	parseShadowFreshnessBinding,
} from "../parse-core.js";
import { manifestDigestOf } from "../manifest-digest.js";
import { computeMissingSetDigestV1 } from "../missing-set.js";
import { parseShadowOutcome } from "../parse-outcome.js";
import { parseDependencyTreeCacheRecord } from "../parse-records-store.js";
import { applyPostImages, blobDigestOf, byteLengthOf } from "../post-image-apply.js";
import { projectPostImages } from "../post-image-projector.js";
import { computeOverlayBytesHash, computePostImageSetHash, type TaggedEntryInput } from "../tagged-set.js";
import { computePostTreeHash, computePreTreeHash, type TreeEntryInput } from "../tree-hash.js";
import type { GitMode, NormalizedToolInputV1, PostImageEntryV1, PreTreeHash, ShadowChangeSetV1 } from "../types-core.js";
import type { BindingFieldMismatchV1 } from "../types-outcome.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../../../protocol/shadow-v1/fixtures");

function load<T>(name: string): T {
	// SAFETY: repo-committed fixtures; a shape drift fails the assertions below.
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as T;
}

interface Reviewable {
	id: string;
	reviewed: string;
}
/** The record grammars: a list of tree / tagged entries. */
interface RecordHashVector extends Reviewable {
	algo: "shadow-tree-v1" | "shadow-postimages-v1" | "shadow-overlay-v1";
	entries: readonly (TreeEntryInput & TaggedEntryInput)[];
	hash: string;
}
/** `shadow-missing-set-v1`: an envelope over blob digests, not over records. */
interface MissingSetHashVector extends Reviewable {
	algo: "shadow-missing-set-v1";
	digests: readonly string[];
	hash: string;
}
/** The manifest digest: sha-256 over the exact uploaded bytes, carried as hex
 *  so the fixture can hold a byte string JSON could not otherwise express. */
interface ManifestHashVector extends Reviewable {
	algo: "shadow-manifest-digest-v1";
	bytes_hex: string;
	hash: string;
}
type HashVector = RecordHashVector | MissingSetHashVector | ManifestHashVector;
/** What one implementation produced for a disputed row. */
interface DisputedSide {
	accepted: boolean;
	reason: string;
	post_images: readonly PostImageEntryV1[];
	post_tree_hash: string;
}
type ProjectionExpectation =
	| { kind: "projected"; post_images: readonly PostImageEntryV1[]; pre_tree_hash: string; post_tree_hash: string; changeset: ShadowChangeSetV1 }
	| { kind: "rejected"; oracle_reason: string; product_reason: string }
	| { kind: "disputed"; adjudication: string; oracle: DisputedSide; product: DisputedSide };
interface ProjectionCase extends Reviewable {
	note: string;
	tool_input: NormalizedToolInputV1;
	pre_images: Record<string, { mode: GitMode; content: string } | null>;
	/** Paths the input names that the map deliberately does NOT carry — not
	 *  even as an explicit null. Only an explicit null proves absence, so a
	 *  row with an omitted path must be rejected naming that path. */
	omitted_pre_images: readonly string[];
	base_tree: Record<string, { mode: GitMode; content: string }>;
	expect: ProjectionExpectation;
}
interface BindingCase extends Reviewable {
	note: string;
	input: BindingComparisonInputV1;
	expect: { mismatches: readonly BindingFieldMismatchV1[] };
}
interface IdentityPair extends Reviewable {
	same: boolean;
	note: string;
	a: ShadowChangeSetV1;
	b: ShadowChangeSetV1;
}
interface MalformedRow extends Reviewable {
	parser: string;
	class: string;
	note: string;
	value: unknown;
}

const hashVectors = load<HashVector[]>("hash-vectors.json");
const projections = load<ProjectionCase[]>("projection-corpus.json");
const identities = load<IdentityPair[]>("identity-table.json");
const malformed = load<MalformedRow[]>("malformed-corpus.json");
const bindings = load<BindingCase[]>("binding-corpus.json");

function fileEntry(path: string, mode: GitMode, content: string): TreeEntryInput {
	return { path, mode, blob_digest: blobDigestOf(content), bytes: byteLengthOf(content) };
}
function entriesOf(tree: Record<string, { mode: GitMode; content: string }>): TreeEntryInput[] {
	return Object.entries(tree).map(([path, file]) => fileEntry(path, file.mode, file.content));
}
function byPathBytes(entries: readonly PostImageEntryV1[]): PostImageEntryV1[] {
	return [...entries].sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
}
function hashOf(vector: HashVector): string {
	if (vector.algo === "shadow-manifest-digest-v1") return manifestDigestOf(Buffer.from(vector.bytes_hex, "hex"));
	if (vector.algo === "shadow-missing-set-v1") {
		const missing = computeMissingSetDigestV1(vector.digests);
		return missing.ok ? missing.hash : `rejected(${missing.reason})`;
	}
	if (vector.algo === "shadow-tree-v1") {
		const result = computePreTreeHash(vector.entries);
		return result.ok ? result.hash : `rejected(${result.reason})`;
	}
	const compute = vector.algo === "shadow-postimages-v1" ? computePostImageSetHash : computeOverlayBytesHash;
	const result = compute(vector.entries);
	return result.ok ? result.hash : `rejected(${result.reason})`;
}
function project(testCase: ProjectionCase) {
	return projectPostImages(testCase.tool_input, new Map(Object.entries(testCase.pre_images)));
}
/** The post tree the row's images produce over its base tree, or the reason the
 *  apply refused — the same string shape the generator recorded. */
function postTreeHashOf(testCase: ProjectionCase, images: Parameters<typeof applyPostImages>[1]): string {
	const applied = applyPostImages(new Map(Object.entries(testCase.base_tree)), images);
	if (!applied.ok) throw new Error(`apply rejected: ${applied.reason} — ${applied.detail}`);
	const post = [...applied.tree.entries()].map(([path, file]) => fileEntry(path, file.mode, file.content));
	const hash = computePostTreeHash(post);
	return hash.ok ? hash.hash : `rejected(${hash.reason})`;
}

// Every fixture file is a list of rows carrying an id and a `reviewed` note.
const ALL_FILES: readonly { name: string; rows: readonly Reviewable[] }[] = [
	{ name: "hash-vectors.json", rows: hashVectors },
	{ name: "projection-corpus.json", rows: projections },
	{ name: "identity-table.json", rows: identities },
	{ name: "malformed-corpus.json", rows: malformed },
	{ name: "binding-corpus.json", rows: bindings },
];

describe("shadow-v1 corpus — every row is executed and every row is reviewable", () => {
	it("P0: no fixture file is empty — a silently empty corpus proves nothing", () => {
		for (const file of ALL_FILES) expect(file.rows.length, file.name).toBeGreaterThan(0);
	});

	for (const file of ALL_FILES) {
		it(`N0 [${file.name}]: no row is missing its \`reviewed\` note`, () => {
			const missing = file.rows.filter((row) => typeof row.reviewed !== "string" || row.reviewed.trim().length === 0);
			expect(missing.map((row) => row.id), `${file.name} rows with no reviewed note`).toEqual([]);
		});
		it(`N1 [${file.name}]: no row id is duplicated`, () => {
			const ids = file.rows.map((row) => row.id);
			expect(ids.length).toBe(new Set(ids).size);
		});
	}
});

describe("shadow-v1 corpus — byte grammars (must reproduce the pinned digests)", () => {
	for (const vector of hashVectors) {
		it(`P1 [${vector.id}]: ${vector.algo} reproduces the pinned digest`, () => {
			expect(hashOf(vector)).toBe(vector.hash);
			if (!vector.hash.startsWith("rejected(")) expect(vector.hash).toMatch(/^[0-9a-f]{64}$/);
		});
	}
});

const accepted = projections.filter((row) => row.expect.kind === "projected");
const refused = projections.filter((row) => row.expect.kind === "rejected");
const disputed = projections.filter((row) => row.expect.kind === "disputed");

describe("shadow-v1 corpus — G1 projection (must reproduce exact post trees)", () => {
	for (const testCase of accepted) {
		it(`P2 [${testCase.id}]: ${testCase.note}`, () => {
			if (testCase.expect.kind !== "projected") throw new Error("filtered above");
			const projected = project(testCase);
			if (!projected.ok) throw new Error(`projection rejected: ${projected.reason} — ${projected.detail}`);
			expect(byPathBytes(projected.images.map((image) => image.entry))).toEqual(byPathBytes(testCase.expect.post_images));
			expect(postTreeHashOf(testCase, projected.images)).toBe(testCase.expect.post_tree_hash);

			const preHash = computePreTreeHash(entriesOf(testCase.base_tree));
			expect(preHash.ok && preHash.hash).toBe(testCase.expect.pre_tree_hash);

			// SAFETY: the fixture's pre-tree hash was produced by this same
			// grammar and re-derived one line above.
			const changeset = computeChangeSet({ pre_tree_hash: testCase.expect.pre_tree_hash as PreTreeHash, postImages: projected.images.map((image) => image.entry) });
			expect(changeset.ok && changeset.changeset).toEqual(testCase.expect.changeset);
		});
	}

	for (const testCase of refused) {
		it(`N2 [${testCase.id}]: ${testCase.note} — REJECTED`, () => {
			if (testCase.expect.kind !== "rejected") throw new Error("filtered above");
			const projected = project(testCase);
			expect(projected.ok, `${testCase.id} was ACCEPTED`).toBe(false);
			if (!projected.ok) expect(`${projected.reason}: ${projected.detail}`).toBe(testCase.expect.product_reason);
			expect(testCase.expect.oracle_reason.length).toBeGreaterThan(0);
		});
	}

	for (const testCase of projections.filter((row) => row.omitted_pre_images.length > 0)) {
		it(`N2b [${testCase.id}]: an omitted pre-image is rejected NAMING the omitted path — never read as absent`, () => {
			const [omitted, ...rest] = testCase.omitted_pre_images;
			expect(rest, "one omitted path per row, so the named path is unambiguous").toEqual([]);
			expect(Object.keys(testCase.pre_images)).not.toContain(omitted);
			expect(testCase.expect.kind).toBe("rejected");
			if (testCase.expect.kind === "rejected") expect(testCase.expect.product_reason).toBe(`projection: missing_pre_image: ${omitted}`);
			const projected = project(testCase);
			expect(projected.ok).toBe(false);
			if (!projected.ok) expect(projected.detail).toBe(`missing_pre_image: ${omitted}`);
		});
	}

	it("N2c: every pre-image map is explicit — no accepted row names a path outside its map", () => {
		for (const testCase of projections) {
			for (const omitted of testCase.omitted_pre_images) expect(testCase.pre_images, testCase.id).not.toHaveProperty(omitted);
		}
	});

	it("P3: the corpus covers every supported tool variant and both admitted modes", () => {
		const tools = new Set(projections.map((row) => `${row.tool_input.tool}`));
		expect([...tools].sort()).toEqual(["Edit", "MultiEdit", "Write", "apply_patch"]);
		const modes = new Set(accepted.flatMap((row) => (row.expect.kind === "projected" ? row.expect.post_images : [])).flatMap((image) => (image.tag === "W" ? [image.mode] : [])));
		expect([...modes].sort()).toEqual(["100644", "100755"]);
		const tags = new Set(accepted.flatMap((row) => (row.expect.kind === "projected" ? row.expect.post_images : [])).map((image) => image.tag));
		expect([...tags].sort()).toEqual(["D", "W"]);
	});
});

describe("shadow-v1 corpus — G1 disputed rows (the product does NOT match the spec oracle)", () => {
	// An empty dispute list is the GOOD state and must still be asserted: the
	// three disputes this mechanism opened (apply_patch anchor, ambiguous hunk,
	// truncated envelope) were all real projector defects and are now fixed, so
	// the standing claim is "the two implementations agree everywhere". Stating
	// it as a case keeps the count visible instead of silently empty.
	it(`P4: ${disputed.length} row(s) are disputed — every other row is an agreement between two implementations`, () => {
		expect(disputed.map((row) => row.id)).toEqual([]);
	});

	for (const testCase of disputed) {
		it(`N3 [${testCase.id}]: ${testCase.note}`, () => {
			if (testCase.expect.kind !== "disputed") throw new Error("filtered above");
			const { oracle, product, adjudication } = testCase.expect;
			expect(adjudication.length, "a disputed row must carry its adjudication").toBeGreaterThan(0);
			expect(JSON.stringify(oracle), "a disputed row whose two sides agree is not a dispute").not.toBe(JSON.stringify(product));

			const projected = project(testCase);
			expect(projected.ok, `${testCase.id}: recorded product behavior`).toBe(product.accepted);
			if (!projected.ok) {
				expect(`${projected.reason}: ${projected.detail}`).toBe(product.reason);
				return;
			}
			expect(byPathBytes(projected.images.map((image) => image.entry))).toEqual(byPathBytes(product.post_images));
			expect(postTreeHashOf(testCase, projected.images)).toBe(product.post_tree_hash);
		});
	}
});

describe("shadow-v1 corpus — G3 content-identity equality table", () => {
	for (const pair of identities) {
		it(`${pair.same ? "P4" : "N4"} [${pair.id}]: ${pair.note}`, () => {
			expect(sameContentIdentity(pair.a, pair.b)).toBe(pair.same);
			expect(sameContentIdentity(pair.b, pair.a)).toBe(pair.same);
		});
	}
});

/** The mismatch list as a set: the contract is WHICH records, not the order
 *  the product happens to walk its leaves in. */
function byFieldThenComparison(mismatches: readonly BindingFieldMismatchV1[]): BindingFieldMismatchV1[] {
	return [...mismatches].sort((left, right) => `${left.field}|${left.comparison}`.localeCompare(`${right.field}|${right.comparison}`));
}

describe("shadow-v1 corpus — I4 binding comparison (exactly the adjudicated mismatches)", () => {
	for (const testCase of bindings) {
		const direction = testCase.expect.mismatches.length === 0 ? "P5" : "N5";
		it(`${direction} [${testCase.id}]: ${testCase.note}`, () => {
			expect(byFieldThenComparison(compareBindings(testCase.input))).toEqual(byFieldThenComparison(testCase.expect.mismatches));
		});
	}

	it("P6: the binding corpus covers both outcomes — agreement and every cache-arm mismatch field", () => {
		expect(bindings.some((row) => row.expect.mismatches.length === 0)).toBe(true);
		const fields = new Set(bindings.flatMap((row) => row.expect.mismatches.map((mismatch) => mismatch.field)));
		expect([...fields].sort()).toEqual(["dependencies.cache_record_hash", "dependencies.source", "dependencies.tree_hash"]);
	});
});

const PARSERS: Record<string, (value: unknown) => ShadowParseOutcome<unknown>> = {
	change_set: parseShadowChangeSet,
	dependency_cache_record: parseDependencyTreeCacheRecord,
	execution_manifest: parseExecutionManifest,
	overlay_manifest: parseOverlayManifest,
	tool_input: parseNormalizedToolInput,
	claim: parseShadowExecutionClaim,
	dependency_request: parseDependencyRequest,
	freshness: parseShadowFreshnessBinding,
	outcome: parseShadowOutcome,
};

describe("shadow-v1 corpus — G2 malformed corpus (every row must REJECT)", () => {
	it("N8: every row names a parser this package actually has", () => {
		for (const row of malformed) {
			expect(Object.keys(PARSERS), row.id).toContain(row.parser);
		}
	});

	for (const row of malformed) {
		it(`N6 [${row.id}] ${row.class}: ${row.note}`, () => {
			const parse = PARSERS[row.parser];
			if (parse === undefined) throw new Error(`unknown parser ${row.parser}`);
			const outcome = parse(row.value);
			expect(outcome.ok, `${row.id} was ACCEPTED`).toBe(false);
			if (!outcome.ok) expect(outcome.reason.length).toBeGreaterThan(0);
		});
	}

	it("N7: the corpus covers every rejection class Plan 00's exit gate names", () => {
		const classes = new Set(malformed.map((row) => row.class));
		const REQUIRED_CLASSES = ["unknown_field", "unknown_field_nested", "unknown_version", "out_of_range", "empty_brand", "reason_phase_mismatch", "invalid_path", "empty_non_empty_list", "non_canonical_order", "invalid_timestamp", "invalid_id"];
		for (const required of REQUIRED_CLASSES) {
			expect([...classes], required).toContain(required);
		}
	});
});
