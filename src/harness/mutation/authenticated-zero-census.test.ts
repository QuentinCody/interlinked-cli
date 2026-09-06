// test-contract: invariant — the census guard inside
// `mintAuthenticatedZeroMutantCensus` (the `return null` after the three
// `envelope.census.* !== 0` disjuncts) is LOAD-BEARING, and this suite pins
// both of the entry points that decide that.
//
// Through `parseAndVerify` the guard is redundant: for kind `not_mutatable`
// the parser runs `checkCensusBlock` (generated === executable +
// approved_excluded) AND the proof contract (generated === 0 and executable
// === 0), so approved_excluded === 0 follows by arithmetic. N1/N2 prove that
// redundancy EMPIRICALLY rather than by argument — every non-zero census is
// poison-injected into an otherwise valid, signed envelope and must be
// refused before any bundle exists. If the parse-side contract is ever
// relaxed, those cases go red first.
//
// Through `verifyEnvelope` — the module's OTHER public entry point — the
// guard is the ONLY layer. `ParsedEnvelope` is a compile-time brand that
// `verifyEnvelope` never re-checks (verify.ts has no runtime parse check;
// its `preReceiptFailure` covers hashes, keys, clock, signature, authority
// and job echo only), so a caller that skips `parseUntrustedEnvelope`
// authenticates a genuinely WeakSet-branded bundle carrying any census.
// N3 drives exactly that path: without the guard those bundles would mint a
// zero-mutant capability for a target that has live mutants. This is the
// same shape as the hole recorded at parse.ts:39-42 ("a signed envelope the
// parser REJECTED still verified"), which the brand closed for TS callers
// only — protocol/mutation-v3/README.md requires vendoring consumers to
// reimplement against the bytes, where no brand exists at all.

import { describe, expect, it } from "vitest";
import {
	isAuthenticatedZeroMutantCensus,
	mintAuthenticatedZeroMutantCensus,
} from "./authenticated-zero-census.js";
import { authenticateFixture } from "./protocol-v3/test-authentication.js";
import { validNotMutatable } from "./protocol-v3/test-envelopes.js";
import {
	isVerifiedEvidenceBundle,
	parseAndVerify,
	type VerifiedEvidenceBundle,
	verifyEnvelope,
} from "./protocol-v3/verify.js";

interface Census {
	readonly generated: number;
	readonly executable: number;
	readonly approved_excluded: number;
}

/** Sign and authenticate one `not_mutatable` envelope carrying `census`. */
function verifyWithCensus(census: Census): ReturnType<typeof parseAndVerify> {
	const raw: Record<string, unknown> = { ...validNotMutatable(), census };
	const fixture = authenticateFixture(raw);
	return parseAndVerify(fixture.raw, fixture.inputs);
}

function authenticZeroCensusBundle(): VerifiedEvidenceBundle {
	const outcome = verifyWithCensus({ generated: 0, executable: 0, approved_excluded: 0 });
	if (!outcome.ok) throw new Error(outcome.reason);
	return outcome.bundle;
}

/** Authenticate the SAME signed envelope while skipping the parser, through
 *  the module's other exported entry point. */
function verifyWithoutParsing(census: Census): ReturnType<typeof verifyEnvelope> {
	const fixture = authenticateFixture({ ...validNotMutatable(), census });
	// Reaching the mint without a parse is precisely the caller shape these
	// cases exist to pin.
	// SAFETY: `ParsedEnvelope` is a compile-time brand that `verifyEnvelope`
	// never re-checks at runtime.
	return verifyEnvelope(fixture.raw as never, fixture.inputs);
}

/** Every census a `not_mutatable` envelope could carry with a non-zero field:
 *  the complete truth table over the mint's three disjuncts. */
const POISON_CENSUS: ReadonlyArray<Census> = [
	{ generated: 0, executable: 0, approved_excluded: 1 },
	{ generated: 0, executable: 1, approved_excluded: 0 },
	{ generated: 0, executable: 1, approved_excluded: 1 },
	{ generated: 1, executable: 0, approved_excluded: 0 },
	{ generated: 1, executable: 0, approved_excluded: 1 },
	{ generated: 1, executable: 1, approved_excluded: 0 },
	{ generated: 1, executable: 1, approved_excluded: 1 },
];

describe("authenticated zero-mutant census — positive (must mint)", () => {
	it("P1: an exact zero census on a signed not_mutatable envelope mints the capability", () => {
		const bundle = authenticZeroCensusBundle();
		const proof = mintAuthenticatedZeroMutantCensus(bundle);
		expect(proof).not.toBeNull();
		expect(proof?.targetFile).toBe("src/lib/constants.ts");
		expect(proof?.resultHash).toBe(bundle.envelope.result_hash);
		expect(proof?.targetContentHash).toBe(bundle.envelope.job.target_content_hash);
	});

	it("P2: the minted proof passes its own runtime binding check", () => {
		const bundle = authenticZeroCensusBundle();
		const proof = mintAuthenticatedZeroMutantCensus(bundle) ?? undefined;
		expect(
			isAuthenticatedZeroMutantCensus(proof, {
				resultHash: bundle.envelope.result_hash,
				targetFile: "src/lib/constants.ts",
				targetContentHash: bundle.envelope.job.target_content_hash,
			}),
		).toBe(true);
	});
});

describe("authenticated zero-mutant census — negative (must not authenticate)", () => {
	for (const census of POISON_CENSUS) {
		const label = `${census.generated}/${census.executable}/${census.approved_excluded}`;
		it(`N1: not_mutatable census ${label} is refused at the parse boundary`, () => {
			const outcome = verifyWithCensus(census);
			const reason = outcome.ok ? "AUTHENTICATED — the census contract did not hold" : outcome.reason;
			// Exactly the two parse-side census contracts, so a refusal for an
			// unrelated fixture reason cannot make this case vacuous.
			expect(reason).toMatch(
				/census arithmetic: generated must equal executable \+ approved_excluded exactly|not_mutatable proof contract requires census\.generated === 0 and census\.executable === 0/,
			);
		});
	}

	it("N2: no non-zero census shape reaches the capability mint through parseAndVerify", () => {
		const minted = POISON_CENSUS.map((census) => {
			const outcome = verifyWithCensus(census);
			return outcome.ok ? mintAuthenticatedZeroMutantCensus(outcome.bundle) : "refused-before-bundle";
		});
		expect(minted).toEqual(POISON_CENSUS.map(() => "refused-before-bundle"));
	});
});

/** One census per disjunct of the mint's census guard, each the FIRST
 *  non-zero field so every condition decides the outcome on its own. */
const BYPASS_CENSUS: ReadonlyArray<readonly [Census, string]> = [
	[{ generated: 1, executable: 1, approved_excluded: 0 }, "generated"],
	[{ generated: 0, executable: 1, approved_excluded: 0 }, "executable"],
	[{ generated: 0, executable: 0, approved_excluded: 1 }, "approved_excluded"],
];

describe("authenticated zero-mutant census — negative (must not mint from an unparsed bundle)", () => {
	for (const [census, field] of BYPASS_CENSUS) {
		it(`N3: a bundle authenticated without the parser whose census.${field} is non-zero mints nothing`, () => {
			const outcome = verifyWithoutParsing(census);
			// Not vacuous: authentication must SUCCEED, so the refusal below can
			// only come from the mint's own census guard.
			if (!outcome.ok) throw new Error(`expected authentication, got: ${outcome.reason}`);
			expect(isVerifiedEvidenceBundle(outcome.bundle)).toBe(true);
			expect(outcome.bundle.envelope.kind).toBe("not_mutatable");
			expect(mintAuthenticatedZeroMutantCensus(outcome.bundle)).toBeNull();
		});
	}

	it("N4: the same bypass route DOES mint on an exact zero census", () => {
		const outcome = verifyWithoutParsing({ generated: 0, executable: 0, approved_excluded: 0 });
		if (!outcome.ok) throw new Error(`expected authentication, got: ${outcome.reason}`);
		expect(mintAuthenticatedZeroMutantCensus(outcome.bundle)?.targetFile).toBe("src/lib/constants.ts");
	});
});
