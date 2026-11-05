// Mutation-directed companion for authenticated-zero-census.ts (kill-proof
// census 2026-11-05). Fault: the `binding.targetFile === expected.targetFile`
// conjunct dropped from isAuthenticatedZeroMutantCensus, so a zero-census
// proof minted for one target authenticates against another target whose
// result hash and content hash happen to coincide.
import { describe, expect, it } from "vitest";
import { isAuthenticatedZeroMutantCensus, mintAuthenticatedZeroMutantCensus } from "./authenticated-zero-census.js";
import { authenticateFixture } from "./protocol-v3/test-authentication.js";
import { validNotMutatable } from "./protocol-v3/test-envelopes.js";
import { parseAndVerify, type VerifiedEvidenceBundle } from "./protocol-v3/verify.js";

function authenticZeroCensusBundle(): VerifiedEvidenceBundle {
	const fixture = authenticateFixture({ ...validNotMutatable(), census: { generated: 0, executable: 0, approved_excluded: 0 } });
	const outcome = parseAndVerify(fixture.raw, fixture.inputs);
	if (!outcome.ok) throw new Error(outcome.reason);
	return outcome.bundle;
}

describe("isAuthenticatedZeroMutantCensus — the proof is bound to its target file", () => {
	// test-contract: invariant - a proof minted for src/lib/constants.ts must not authenticate for a different target file with the same result and content hashes
	it("refuses the minted proof for a different target file", () => {
		const bundle = authenticZeroCensusBundle();
		const proof = mintAuthenticatedZeroMutantCensus(bundle) ?? undefined;
		expect(proof).toBeDefined();
		expect(
			isAuthenticatedZeroMutantCensus(proof, {
				resultHash: bundle.envelope.result_hash,
				targetFile: "src/lib/other-target.ts",
				targetContentHash: bundle.envelope.job.target_content_hash,
			}),
		).toBe(false);
	});

	// test-contract: invariant - the sibling conjunct: a different target content hash is refused too
	it("refuses the minted proof for a different target content hash", () => {
		const bundle = authenticZeroCensusBundle();
		const proof = mintAuthenticatedZeroMutantCensus(bundle) ?? undefined;
		expect(
			isAuthenticatedZeroMutantCensus(proof, {
				resultHash: bundle.envelope.result_hash,
				targetFile: "src/lib/constants.ts",
				targetContentHash: `${bundle.envelope.job.target_content_hash.slice(0, -1)}0`,
			}),
		).toBe(false);
	});
});
