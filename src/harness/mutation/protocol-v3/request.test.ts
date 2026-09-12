// ===========================================
// Protocol v3 — canonical job request + admission derivation (unit pins)
// ===========================================
// Eighth pass P0-2: admission derives ONLY from a request the
// CONSTRUCTING parser accepted — every reviewer repro (traversal paths,
// duplicate test files, over-bound change sets, missing/mismatched
// target) is a pinned rejection. Shared cross-runtime vectors exercise
// canonical sorting, not just an already-sorted list.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_SOURCE_ARTIFACT_BYTES } from "./field-checks.js";
import {
	canonicalChangesetHash,
	canonicalRequestHash,
	deriveAdmission,
	type MutationJobRequestV3,
	parseMutationJobRequestV3,
	type ValidMutationJobRequest,
} from "./request.js";
import { PROTOCOL_V3_VERSION, SOURCE_ARTIFACT_FORMAT } from "./types.js";

function baseRequest(): MutationJobRequestV3 {
	return {
		request_version: "1",
		protocol_version: PROTOCOL_V3_VERSION,
		job: {
			tenant: "t_dev",
			project: "p_cli",
			repository: "github.com/QuentinCody/interlinked-cli",
			commit: "0123456789abcdef0123456789abcdef01234567",
			target_file: "src/lib/example.ts",
			target_content_hash: "a".repeat(64),
			job_key: "job_0001",
		},
		source_artifact: {
			format: SOURCE_ARTIFACT_FORMAT,
			artifact_id: "src_fixture_bundle_0001",
			sha256: "9".repeat(64),
			bytes: 1024,
		},
		scope_mode: "import_graph",
		test_files: ["src/lib/example.test.ts"],
		changeset: [{ path: "src/lib/example.ts", content_hash: "a".repeat(64) }],
	};
}

function parsed(raw: unknown): ValidMutationJobRequest {
	const outcome = parseMutationJobRequestV3(raw);
	if (!outcome.ok) throw new Error(`fixture must parse: ${outcome.reason}`);
	return outcome.request;
}

function rejectionOf(raw: unknown): string {
	const outcome = parseMutationJobRequestV3(raw);
	return outcome.ok ? "ACCEPTED" : outcome.reason;
}

describe("request wire shape", () => {
	it.each([
		[{ job: null }, "request.job must be an object"],
		[{ changeset: [null] }, "request.changeset entries must be objects"],
		[{ request_version: "2" }, 'request.request_version must be "1"'],
		[{ protocol_version: "unsupported" }, `request.protocol_version must be exactly "${PROTOCOL_V3_VERSION}"`],
	])("rejects malformed request fields %j before admission", (fields, reason) => {
		expect(parseMutationJobRequestV3({ ...baseRequest(), ...fields })).toEqual({ ok: false, reason });
	});

	it("rejects a traversal in the selected test files", () => {
		expect(rejectionOf({ ...baseRequest(), test_files: ["../outside.test.ts"] })).toContain("request.test_files[]");
	});
});

describe("parseMutationJobRequestV3 + deriveAdmission — positive", () => {
	// test-contract: public-api — a canonical request parses; admission
	// derives both hashes consistently from the PARSED request only.
	it("P1: a canonical request parses and derives admission", () => {
		const request = parsed(baseRequest());
		const admission = deriveAdmission(request);
		expect(admission.request_hash).toBe(canonicalRequestHash(request));
		expect(admission.changeset_hash).toBe(canonicalChangesetHash(request.changeset));
	});

	// test-contract: invariant — the shared cross-runtime vectors reproduce
	// exactly, INCLUDING the deliberately unsorted variant whose hashes
	// must equal its sorted twin (a producer that never sorts fails here).
	it("P2: the shared request vectors reproduce (sorting exercised)", () => {
		const vectorPath = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../../../protocol/mutation-v3/fixtures/request-vectors.json",
		);
		// SAFETY: repo-committed fixture this suite exists to validate.
		const fixture = JSON.parse(readFileSync(vectorPath, "utf-8")) as {
			protocol_version: string;
			vectors: Array<{
				name: string;
				request: MutationJobRequestV3;
				expected_request_hash: string;
				expected_changeset_hash: string;
			}>;
		};
		expect(fixture.protocol_version).toBe(PROTOCOL_V3_VERSION);
		expect(fixture.vectors.length).toBeGreaterThanOrEqual(3);
		for (const v of fixture.vectors) {
			expect(canonicalRequestHash(v.request)).toBe(v.expected_request_hash);
			expect(canonicalChangesetHash(v.request.changeset)).toBe(v.expected_changeset_hash);
		}
		const unsorted = fixture.vectors.find((v) => v.name.includes("unsorted"));
		const sortedTwin = fixture.vectors.find((v) => v.name.includes("sorted-twin"));
		expect(unsorted).toBeDefined();
		expect(sortedTwin).toBeDefined();
		expect(unsorted?.expected_changeset_hash).toBe(sortedTwin?.expected_changeset_hash);
		// The unsorted variant's ENTRY ORDER genuinely differs from sorted.
		expect(JSON.stringify(unsorted?.request.changeset)).not.toBe(
			JSON.stringify(sortedTwin?.request.changeset),
		);
	});
});

describe("parseMutationJobRequestV3 — snapshot isolation (ninth pass P0)", () => {
	// test-contract: security — the reviewer's repro: mutating the ORIGINAL
	// object after parsing must not reach the branded request or change the
	// derived admission; the snapshot is frozen.
	it("P3: post-parse mutation of the input cannot alter the parsed request", () => {
		const raw = baseRequest();
		const request = parsed(raw);
		const before = deriveAdmission(request);
		// Attack: invalidate the original AFTER validation.
		raw.job.target_content_hash = "f".repeat(64);
		raw.changeset[0] = { path: "src/lib/example.ts", content_hash: "0".repeat(64) };
		raw.test_files.push("src/zzz.test.ts");
		expect(request.job.target_content_hash).toBe("a".repeat(64));
		expect(request.changeset[0]?.content_hash).toBe("a".repeat(64));
		expect(request.test_files).toEqual(["src/lib/example.test.ts"]);
		expect(request.changeset[0]?.content_hash).toBe(request.job.target_content_hash);
		expect(deriveAdmission(request)).toEqual(before);
		// The snapshot itself is deep-frozen: writes throw in strict mode.
		expect(() => {
			// SAFETY: deliberate illegal write under test.
			(request.job as { target_content_hash: string }).target_content_hash = "b".repeat(64);
		}).toThrow(TypeError);
		expect(() => {
			// SAFETY: deliberate illegal write under test.
			(request.test_files as string[]).push("src/evil.test.ts");
		}).toThrow(TypeError);
	});

	// test-contract: security — validation and construction must observe
	// the same value. The old validate-then-copy shape could accept the
	// first (valid) getter value and retain the second (invalid) one.
	it("P4: reads an accessor-backed field once before validation", () => {
		const raw = baseRequest();
		let reads = 0;
		Object.defineProperty(raw.job, "target_content_hash", {
			configurable: true,
			enumerable: true,
			get: () => {
				reads++;
				return reads === 1 ? "a".repeat(64) : "not-a-sha256";
			},
		});
		const outcome = parseMutationJobRequestV3(raw);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(reads).toBe(1);
		expect(outcome.request.job.target_content_hash).toBe("a".repeat(64));
		expect(outcome.request.changeset[0]?.content_hash).toBe(
			outcome.request.job.target_content_hash,
		);
	});

	// test-contract: security — Proxy objects are not structured-clone
	// data, so the parser refuses them instead of validating through traps.
	it("N0: rejects a proxy-backed request before validation", () => {
		const outcome = parseMutationJobRequestV3(new Proxy(baseRequest(), {}));
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("proxy request unexpectedly parsed");
		expect(outcome.reason).toContain("plain JSON object");
	});
});

describe("parseMutationJobRequestV3 — negative (reviewer repros)", () => {
	// test-contract: security — traversal paths, duplicate test files, and
	// over-bound change sets are pinned rejections (they previously hashed).
	it("N1: traversal paths, duplicate test files, over-bound change sets reject", () => {
		const traversal = {
			...baseRequest(),
			changeset: [
				{ path: "src/lib/example.ts", content_hash: "a".repeat(64) },
				{ path: "../secrets.txt", content_hash: "b".repeat(64) },
			],
		};
		expect(rejectionOf(traversal)).toContain("repo-relative");
		const dupTests = { ...baseRequest(), test_files: ["src/a.test.ts", "src/a.test.ts"] };
		expect(rejectionOf(dupTests)).toContain("duplicates");
		const oversized = {
			...baseRequest(),
			changeset: [
				{ path: "src/lib/example.ts", content_hash: "a".repeat(64) },
				...Array.from({ length: 4096 }, (_v, i) => ({ path: `src/f${i}.ts`, content_hash: "c".repeat(64) })),
			],
		};
		expect(rejectionOf(oversized)).toContain("4096");
	});

	// test-contract: security — target binding: the target must appear
	// exactly once, with a content hash matching the job binding.
	it("N2: missing or mismatched targets reject", () => {
		const missingTarget = {
			...baseRequest(),
			changeset: [{ path: "src/other.ts", content_hash: "b".repeat(64) }],
		};
		expect(rejectionOf(missingTarget)).toContain("exactly once");
		const mismatched = {
			...baseRequest(),
			changeset: [{ path: "src/lib/example.ts", content_hash: "b".repeat(64) }],
		};
		expect(rejectionOf(mismatched)).toContain("disagrees with job.target_content_hash");
	});

	// test-contract: invariant — canonical requests have ONE byte form:
	// unsorted test_files and unknown keys reject.
	it("N3: unsorted test files and unknown keys reject", () => {
		const unsorted = { ...baseRequest(), test_files: ["src/b.test.ts", "src/a.test.ts"] };
		expect(rejectionOf(unsorted)).toContain("sorted ascending");
		expect(rejectionOf({ ...baseRequest(), extra: 1 })).toContain("unknown key");
	});

	// test-contract: security — duplicate change-set paths are ambiguous
	// identity: refused by the parser AND by the raw hash helper.
	it("N4: duplicate changeset paths are refused everywhere", () => {
		const dupes = [
			{ path: "src/a.ts", content_hash: "a".repeat(64) },
			{ path: "src/a.ts", content_hash: "b".repeat(64) },
		];
		expect(rejectionOf({ ...baseRequest(), changeset: dupes })).toContain("duplicate path");
		expect(() => canonicalChangesetHash(dupes)).toThrow(/duplicate/);
	});

	// test-contract: security — source artifact length is a signed resource
	// limit, not an invitation to materialize an unbounded upload.
	it("N5: rejects source artifacts above the fixed streaming ceiling", () => {
		expect(
			rejectionOf({
				...baseRequest(),
				source_artifact: {
					...baseRequest().source_artifact,
					bytes: MAX_SOURCE_ARTIFACT_BYTES + 1,
				},
			}),
		).toContain(`1 through ${MAX_SOURCE_ARTIFACT_BYTES}`);
	});

	// test-contract: security — authenticated bytes have one explicit
	// decoding contract. Missing or invented formats can never be accepted
	// and left for an executor to guess.
	it("N6: requires the exact source artifact format discriminator", () => {
		const { format: _omitted, ...missing } = baseRequest().source_artifact;
		expect(rejectionOf({ ...baseRequest(), source_artifact: missing })).toContain("source_artifact.format");
		expect(
			rejectionOf({
				...baseRequest(),
				source_artifact: { ...baseRequest().source_artifact, format: "zip-v1" },
			}),
		).toContain(`exactly "${SOURCE_ARTIFACT_FORMAT}"`);
	});

	// test-contract: security — test_files shares the changeset's 4096-entry
	// ceiling but is checked independently (checkPathList, not
	// checkChangeset) and by its OWN message, distinct from N1's over-bound
	// changeset rejection.
	it("N7: rejects a test_files list past the 4096-entry ceiling", () => {
		const oversizedTestFiles = {
			...baseRequest(),
			test_files: Array.from({ length: 4097 }, (_v, i) => `src/f${i}.test.ts`),
		};
		expect(rejectionOf(oversizedTestFiles)).toBe("request.test_files must be an array of at most 4096 paths");
	});
});
