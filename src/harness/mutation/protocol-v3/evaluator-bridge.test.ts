// test-contract: security — authenticated cloud evidence is still identity-
// checked against local target bytes before it reaches baseline policy.
// Also covers: source-anchor bounds checks that reject a claimed offset/span
// outside the hash-bound content; a "short result" refusal when the identity
// collaborator (../identity.js, spied via `identityModule` — never the SUT)
// returns fewer rows than requested or reports typescript unavailable; the
// terminal-kind refusal for a valid but non-evaluable arm (e.g. "cancelled");
// and the identity-algorithm self-check (evaluator-bridge.ts's own
// IDENTITY_ALGORITHM constant vs. the ../identity.js PORTABLE_IDENTITY_ALGORITHM
// it must agree with), exercised by mocking ../identity.js's value export
// through a `identityAlgorithmOverride` hoisted toggle — the SUT's source is
// never touched; every other test leaves the toggle unset so the mock falls
// through to the real constant.

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as identityModule from "../identity.js";
import { deriveIdentities, derivePortableIdentities } from "../identity.js";
import type { RawMutant } from "../types.js";
import { authenticatedEvidenceToMutationRun } from "./evaluator-bridge.js";
import { authenticateFixture } from "./test-authentication.js";
import { MUTATION_RESULT_TARGET_CONTENT, validMutationResult } from "./test-envelopes.js";
import { IDENTITY_ALGORITHM, type V3MutantRow, type V3MutationResult } from "./types.js";
import { parseAndVerify, type VerifiedEvidenceBundle } from "./verify.js";

/** Per-test override for ../identity.js's PORTABLE_IDENTITY_ALGORITHM value
 *  export, read by the vi.mock factory below. Only the identity-algorithm-
 *  mismatch test sets it; the afterEach resets it so no other test is
 *  affected — every other test's re-derivation still runs against the real
 *  algorithm constant. Declared via vi.hoisted so the hoisted vi.mock call
 *  below (which runs before this file's own top-level statements) can see it. */
const identityAlgorithmOverride = vi.hoisted((): { value: string | null } => ({ value: null }));

vi.mock("../identity.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../identity.js")>();
	return {
		...actual,
		get PORTABLE_IDENTITY_ALGORITHM() {
			return identityAlgorithmOverride.value ?? actual.PORTABLE_IDENTITY_ALGORITHM;
		},
	};
});

/** The real collaborator function, captured before any test spies over it —
 *  lets a spy's mock implementation delegate to genuine identity derivation
 *  and then perturb only the result, instead of stubbing it out entirely. */
const realDerivePortableIdentities = identityModule.derivePortableIdentities;

const CONTENT = "export function compare(x: number): boolean { return x > 0 && x > -1; }\n";

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function rawMutants(): RawMutant[] {
	return [
		{
			file: "src/lib/example.ts",
			mutator: "EqualityOperator",
			originalLexeme: ">",
			replacement: ">=",
			startOffset: CONTENT.indexOf("> 0"),
		},
		{
			file: "src/lib/example.ts",
			mutator: "EqualityOperator",
			originalLexeme: ">",
			replacement: "<=",
			startOffset: CONTENT.indexOf("> -1"),
		},
	];
}

function coherentRows(): V3MutantRow[] {
	const raw = rawMutants();
	const identities = derivePortableIdentities("src/lib/example.ts", CONTENT, raw);
	if (identities === null) throw new Error("typescript unavailable in identity bridge test");
	return identities.map((identity, index) => {
		const source = raw[index];
		if (source === undefined) throw new Error("missing raw mutant");
		return {
			mutant_id: identity.mutantId,
			site_id: identity.siteId,
			symbol_id: identity.symbolId,
			qualified_name: identity.qualifiedName,
			symbol_context: identity.symbolContext,
			mutator: source.mutator,
			original_lexeme: source.originalLexeme,
			replacement: source.replacement,
			start_offset: source.startOffset,
			ordinal_within_symbol: identity.ordinalWithinSymbol,
			status: index === 0 ? "killed" : "survived",
		};
	});
}

function coherentEnvelope(): V3MutationResult {
	const envelope = validMutationResult();
	envelope.job.target_content_hash = sha256(CONTENT);
	envelope.mutants = coherentRows();
	envelope.excluded = [];
	envelope.census = { generated: 2, executable: 2, approved_excluded: 0 };
	envelope.identity_algorithm = IDENTITY_ALGORITHM;
	return envelope;
}

function authenticate(envelope: V3MutationResult): VerifiedEvidenceBundle {
	// SAFETY: the fixture fabricator accepts a JSON object and the production
	// parser reconstructs/validates it before the branded bundle is returned.
	const fabricated = authenticateFixture(envelope as unknown as Record<string, unknown>);
	const outcome = parseAndVerify(fabricated.raw, fabricated.inputs);
	if (!outcome.ok) throw new Error(outcome.reason);
	return outcome.bundle;
}

describe("authenticatedEvidenceToMutationRun", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		identityAlgorithmOverride.value = null;
	});

	it("P: re-derives v2 identities, then supplies raw mutants to the legacy evaluator", () => {
		const bridged = authenticatedEvidenceToMutationRun(authenticate(coherentEnvelope()), CONTENT);
		expect(bridged.ok).toBe(true);
		if (!bridged.ok) return;
		expect(bridged.run.mutants.map((row) => row.status)).toEqual(["killed", "survived"]);
		expect(bridged.run.testRun).toEqual({ overlayGreen: true, redWitnessSatisfied: null });
		expect(bridged.run.engineExitCode).toBe(0);
		const legacy = deriveIdentities(
			"src/lib/example.ts",
			CONTENT,
			bridged.run.mutants.map((row) => row.raw),
		);
		expect(legacy?.every((identity) => identity.mutantId.length === 16)).toBe(true);
	});

	it("P: includes approved exclusions in ordinal ranking before adapting executable rows", () => {
		const envelope = coherentEnvelope();
		const [first, second] = coherentRows();
		if (first === undefined || second === undefined) throw new Error("identity rows missing");
		const { status: _excludedStatus, ...excludedIdentity } = first;
		envelope.mutants = [second];
		envelope.excluded = [{ ...excludedIdentity, policy_id: "policy-string-literal-noise" }];
		envelope.census = { generated: 2, executable: 1, approved_excluded: 1 };
		const bridged = authenticatedEvidenceToMutationRun(authenticate(envelope), CONTENT);
		expect(bridged.ok).toBe(true);
		if (bridged.ok) {
			expect(bridged.run.mutants[0]?.raw.startOffset).toBe(CONTENT.indexOf("> -1"));
			expect(bridged.run.evidenceGaps).toEqual([
				"approved exclusion rows are not executable mutant evidence (1 excluded mutant(s))",
			]);
		}
	});

	it("N: rejects a valid-looking, signed engine id that does not equal the local v2 derivation", () => {
		const envelope = coherentEnvelope();
		envelope.mutants[0] = { ...envelope.mutants[0]!, mutant_id: "f".repeat(64) };
		const bridged = authenticatedEvidenceToMutationRun(authenticate(envelope), CONTENT);
		expect(bridged).toEqual(expect.objectContaining({ ok: false }));
		if (!bridged.ok) expect(bridged.reason).toContain("mutant_id does not match");
	});

	it("N: rejects a structural bundle copy that the verifier did not mint", () => {
		const genuine = authenticate(coherentEnvelope());
		// SAFETY: deliberate type forgery exercises the runtime trust boundary.
		const forged = { ...genuine };
		expect(authenticatedEvidenceToMutationRun(forged, CONTENT)).toEqual({
			ok: false,
			reason: "protocol-v3 evidence bundle was not minted by the verifier",
		});
	});

	it("N: rejects signed symbol/site/context claims that disagree with the local AST", () => {
		for (const patch of [
			{ symbol_id: "f".repeat(64) },
			{ site_id: "e".repeat(64) },
			{ qualified_name: "Foreign.compare" },
			{ symbol_context: "Foreign.compare#anonymous-9" },
			{ ordinal_within_symbol: 9 },
		]) {
			const envelope = coherentEnvelope();
			envelope.mutants[0] = { ...envelope.mutants[0]!, ...patch };
			const bridged = authenticatedEvidenceToMutationRun(authenticate(envelope), CONTENT);
			expect(bridged.ok).toBe(false);
		}
	});

	it("N: rejects duplicate semantic identities even when the signed claimed ids differ", () => {
		const envelope = coherentEnvelope();
		envelope.mutants[1] = {
			...envelope.mutants[0]!,
			mutant_id: "e".repeat(64),
			site_id: "d".repeat(64),
		};
		const bridged = authenticatedEvidenceToMutationRun(authenticate(envelope), CONTENT);
		expect(bridged).toEqual({
			ok: false,
			reason: "duplicate locally derived mutant identities — evidence is not one row per mutant",
		});
	});

	it("N: refuses local bytes or lexeme anchors that do not match the authenticated target", () => {
		const wrongContent = `${CONTENT}// different\n`;
		expect(authenticatedEvidenceToMutationRun(authenticate(coherentEnvelope()), wrongContent)).toEqual({
			ok: false,
			reason: "local target content does not match the authenticated job target_content_hash",
		});
		const envelope = coherentEnvelope();
		envelope.mutants[0] = { ...envelope.mutants[0]!, original_lexeme: "<" };
		const bridged = authenticatedEvidenceToMutationRun(authenticate(envelope), CONTENT);
		expect(bridged.ok).toBe(false);
		if (!bridged.ok) expect(bridged.reason).toContain("original_lexeme");
	});

	it("N: refuses a mutant whose claimed start_offset begins beyond the hash-bound target content", () => {
		const envelope = coherentEnvelope();
		envelope.mutants[0] = { ...envelope.mutants[0]!, start_offset: CONTENT.length + 5 };
		const bridged = authenticatedEvidenceToMutationRun(authenticate(envelope), CONTENT);
		expect(bridged.ok).toBe(false);
		if (!bridged.ok) {
			expect(bridged.reason).toBe(
				`mutant ${envelope.mutants[0]!.mutant_id} starts outside the hash-bound target content`,
			);
		}
	});

	it("N: refuses a mutant whose lexeme span extends beyond the hash-bound target content", () => {
		const envelope = coherentEnvelope();
		envelope.mutants[0] = {
			...envelope.mutants[0]!,
			start_offset: CONTENT.length - 2,
			original_lexeme: "abcdefghij",
		};
		const bridged = authenticatedEvidenceToMutationRun(authenticate(envelope), CONTENT);
		expect(bridged.ok).toBe(false);
		if (!bridged.ok) {
			expect(bridged.reason).toBe(
				`mutant ${envelope.mutants[0]!.mutant_id} span extends outside the hash-bound target content`,
			);
		}
	});

	it("N: refuses when local identity re-derivation returns fewer rows than the evidence claims", () => {
		const envelope = coherentEnvelope();
		const bundle = authenticate(envelope);
		vi.spyOn(identityModule, "derivePortableIdentities").mockImplementationOnce((file, content, raws) => {
			const identities = realDerivePortableIdentities(file, content, raws);
			if (identities === null) throw new Error("typescript unavailable in identity bridge test");
			// Drop the last derived identity so a later row in the same
			// evidence set has no matching locally-derived counterpart —
			// the row itself is still present, so the message can't name a
			// mutant_id (that's the whole point of a "short result").
			return identities.slice(0, -1);
		});
		const bridged = authenticatedEvidenceToMutationRun(bundle, CONTENT);
		expect(bridged).toEqual({
			ok: false,
			reason: "mutant identity derivation returned a short result",
		});
	});

	it("N: refuses with a typescript-unavailable reason when identity re-derivation reports unavailable", () => {
		const bundle = authenticate(coherentEnvelope());
		vi.spyOn(identityModule, "derivePortableIdentities").mockReturnValueOnce(null);
		const bridged = authenticatedEvidenceToMutationRun(bundle, CONTENT);
		expect(bridged).toEqual({
			ok: false,
			reason: "typescript unavailable — portable mutant identity cannot be verified",
		});
	});

	it("N: refuses a terminal kind that carries no evaluator mutation run", () => {
		const base = validMutationResult();
		// SAFETY: widened to the "cancelled" terminal shape (no mutation_result
		// evidence fields) — mirrors verify.test.ts's cancelledFixture.
		const cancelled = { ...base, kind: "cancelled", cancellation_reason: "operator_stop" } as Record<
			string,
			unknown
		>;
		for (const key of [
			"execution_receipt_hash",
			"attempt_id",
			"scope",
			"engine",
			"runner",
			"census",
			"excluded",
			"mutants",
			"identity_algorithm",
			"test_run",
			"report",
		]) {
			delete cancelled[key];
		}
		const fabricated = authenticateFixture(cancelled);
		const outcome = parseAndVerify(fabricated.raw, fabricated.inputs);
		if (!outcome.ok) throw new Error(outcome.reason);
		const bridged = authenticatedEvidenceToMutationRun(outcome.bundle, MUTATION_RESULT_TARGET_CONTENT);
		expect(bridged).toEqual({
			ok: false,
			reason: "terminal kind cancelled carries no evaluator mutation run",
		});
	});

	it("N: refuses when the protocol identity constant disagrees with the local implementation", () => {
		// Forge ONLY the ../identity.js collaborator's PORTABLE_IDENTITY_ALGORITHM
		// value export (via the hoisted toggle read by the vi.mock factory above)
		// so it diverges from evaluator-bridge.ts's own IDENTITY_ALGORITHM import
		// (./types.js, untouched) — the SUT's source is never mocked or edited.
		identityAlgorithmOverride.value = "interlinked-site-v9-forged";
		const bridged = authenticatedEvidenceToMutationRun(authenticate(coherentEnvelope()), CONTENT);
		expect(bridged).toEqual({
			ok: false,
			reason: "protocol identity constant disagrees with the identity implementation",
		});
	});
});
