// ===========================================
// Protocol v3 — structural report verification (unit pins)
// ===========================================
// Review 2026-08-31 fourth pass: report "verification" was a substring
// check — {"note":"src/lib/example.ts 1111… 2222… 9999…"} authenticated.
// Reports are now a versioned structural schema, and the rows must
// correspond EXACTLY to the envelope's evidence.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseUntrustedEnvelope, type ParsedEnvelope } from "./parse.js";
import { buildStructuralReport, verifyReportAgainstEnvelope } from "./report.js";
import { validMutationResult, validNotMutatable } from "./test-envelopes.js";
import type { V3MutationResult, V3NotMutatable } from "./types.js";

function parsed(raw: unknown): ParsedEnvelope {
	const outcome = parseUntrustedEnvelope(raw);
	if (!outcome.ok) throw new Error(`fixture must parse: ${outcome.reason}`);
	return outcome.envelope;
}

function sha(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A parsed envelope whose report pointer matches `text`. */
function withReport(base: V3MutationResult | V3NotMutatable, text: string): ParsedEnvelope {
	return parsed({
		...base,
		report: { r2_sha256: sha(text), bytes: Buffer.byteLength(text, "utf8"), content_hash: sha(text) },
	});
}

describe("verifyReportAgainstEnvelope — positive (must verify)", () => {
	// test-contract: public-api — a structurally exact report (built by the
	// shared builder) verifies for mutation_result and not_mutatable.
	it("P1: exact structural reports verify for both report-requiring kinds", () => {
		const mr = validMutationResult();
		const mrText = buildStructuralReport(mr);
		expect(verifyReportAgainstEnvelope(withReport(mr, mrText), Buffer.from(mrText, "utf8"))).toBeNull();
		const nm = validNotMutatable();
		const nmText = buildStructuralReport(nm);
		expect(verifyReportAgainstEnvelope(withReport(nm, nmText), Buffer.from(nmText, "utf8"))).toBeNull();
	});
});

describe("verifyReportAgainstEnvelope — negative (must reject)", () => {
	it("rejects a non-object file map even when the report hash matches", () => {
		const text = JSON.stringify({ report_version: "1", files: [] });
		expect(verifyReportAgainstEnvelope(withReport(validMutationResult(), text), Buffer.from(text))).toBe("report.files must be an object");
	});

	it.each([null, {}])("rejects a non-array mutant list %j even when the report hash matches", (mutants) => {
		const base = validMutationResult();
		const text = JSON.stringify({ report_version: "1", files: { [base.job.target_file]: { mutants } } });
		expect(verifyReportAgainstEnvelope(withReport(base, text), Buffer.from(text))).toBe("report target entry must carry a mutants array");
	});

	// test-contract: security — the reviewer's repro: a prose mention of
	// the target and mutant ids is NOT a structural file entry.
	it("N1: the prose-mention smuggle rejects", () => {
		const prose = '{"note":"src/lib/example.ts 1111111111111111 2222222222222222 9999999999999999"}';
		const reason = verifyReportAgainstEnvelope(withReport(validMutationResult(), prose), Buffer.from(prose, "utf8"));
		expect(reason).toContain("report_version");
	});

	// test-contract: security — a structurally valid report whose rows do
	// not correspond to the envelope (missing target, wrong status, missing
	// exclusion) rejects with the exact discrepancy.
	it("N2: row/target correspondence failures reject", () => {
		const mr = validMutationResult();
		const noTarget = '{"report_version":"1","files":{"src/other.ts":{"mutants":[]}}}';
		expect(
			verifyReportAgainstEnvelope(withReport(mr, noTarget), Buffer.from(noTarget, "utf8")),
		).toContain("target");
		const wrongStatus = buildStructuralReport({
			...mr,
			mutants: [
				{ ...mr.mutants[0]!, status: "survived" },
				{ ...mr.mutants[1]!, status: "killed" },
			],
		});
		expect(
			verifyReportAgainstEnvelope(withReport(mr, wrongStatus), Buffer.from(wrongStatus, "utf8")),
		).toContain("status");
		const wrongIdentityContext = buildStructuralReport({
			...mr,
			mutants: [{ ...mr.mutants[0]!, qualified_name: "Foreign.example" }, mr.mutants[1]!],
		});
		expect(
			verifyReportAgainstEnvelope(
				withReport(mr, wrongIdentityContext),
				Buffer.from(wrongIdentityContext, "utf8"),
			),
		).toContain("qualified_name");
		const missingExclusion = buildStructuralReport({ ...mr, excluded: [] });
		expect(
			verifyReportAgainstEnvelope(withReport(mr, missingExclusion), Buffer.from(missingExclusion, "utf8")),
		).toContain("exclu");
		const wrongExclusionPolicy = buildStructuralReport({
			...mr,
			excluded: [{ ...mr.excluded[0]!, policy_id: "policy-different-approved-rule" }],
		});
		expect(
			verifyReportAgainstEnvelope(
				withReport(mr, wrongExclusionPolicy),
				Buffer.from(wrongExclusionPolicy, "utf8"),
			),
		).toContain("policy_id");
	});

	// test-contract: security — not_mutatable requires a structurally
	// present target with an EXACT zero-mutant result; any row rejects.
	it("N3: not_mutatable with any report row rejects", () => {
		const nm = validNotMutatable();
		const withRow = JSON.stringify({
			report_version: "1",
			files: {
				"src/lib/constants.ts": {
					mutants: [{ ...validMutationResult().excluded[0]!, status: "excluded" }],
				},
			},
		});
		expect(
			verifyReportAgainstEnvelope(withReport(nm, withRow), Buffer.from(withRow, "utf8")),
		).toContain("zero-mutant");
	});

	// test-contract: security — r2_sha256 and content_hash BOTH bind the
	// same retrieved bytes; a wrong r2 hash rejects (it was ignored before).
	it("N4: a wrong r2_sha256 rejects", () => {
		const mr = validMutationResult();
		const text = buildStructuralReport(mr);
		const env = parsed({
			...mr,
			report: { r2_sha256: "0".repeat(64), bytes: Buffer.byteLength(text, "utf8"), content_hash: sha(text) },
		});
		expect(verifyReportAgainstEnvelope(env, Buffer.from(text, "utf8"))).toContain("r2_sha256");
	});

	// test-contract: security — the retrieved bytes must match the pointer's
	// declared length before any hash is even computed.
	it("N5: retrieved bytes whose length disagrees with the pointer reject", () => {
		const mr = validMutationResult();
		const text = buildStructuralReport(mr);
		const env = withReport(mr, text);
		const longer = Buffer.from(`${text} `, "utf8");
		expect(verifyReportAgainstEnvelope(env, longer)).toContain("pointer declares");
	});

	// test-contract: security — non-JSON bytes reject before any structural
	// check runs (the JSON.parse failure path).
	it("N6: bytes that are not valid JSON reject", () => {
		const mr = validMutationResult();
		const notJson = "{not json";
		expect(
			verifyReportAgainstEnvelope(withReport(mr, notJson), Buffer.from(notJson, "utf8")),
		).toBe("report is not valid JSON");
	});

	// test-contract: security — a report entry that is present but not a
	// structural object (a string standing in for the target's row set)
	// rejects the same way as a missing entry.
	it("N7: a non-object file entry rejects", () => {
		const mr = validMutationResult();
		const text = JSON.stringify({ report_version: "1", files: { [mr.job.target_file]: "not-an-object" } });
		expect(
			verifyReportAgainstEnvelope(withReport(mr, text), Buffer.from(text, "utf8")),
		).toContain("no structural entry");
	});

	// test-contract: security — a mutant row that is not a {mutant_id,
	// status} shell (here: not even an object) rejects before any field
	// check runs.
	it("N8: a malformed row that is not a {mutant_id, status} shell rejects", () => {
		const mr = validMutationResult();
		const text = JSON.stringify({ report_version: "1", files: { [mr.job.target_file]: { mutants: [42] } } });
		expect(
			verifyReportAgainstEnvelope(withReport(mr, text), Buffer.from(text, "utf8")),
		).toBe("report mutant rows must be {mutant_id, status} objects");
	});

	// test-contract: security — an executable row's status must be one of
	// the known V3MutantStatus values.
	it("N9: an unrecognized mutant status rejects", () => {
		const mr = validMutationResult();
		const text = JSON.stringify({
			report_version: "1",
			files: { [mr.job.target_file]: { mutants: [{ ...mr.mutants[0]!, status: "bogus" }] } },
		});
		expect(
			verifyReportAgainstEnvelope(withReport(mr, text), Buffer.from(text, "utf8")),
		).toContain('not a known status');
	});

	// test-contract: security — the report cannot launder an envelope
	// mutant into an excluded row; the row for that mutant_id must still
	// carry an executable status.
	it("N10: a report that marks an envelope mutant as excluded rejects", () => {
		const mr = validMutationResult();
		// SAFETY: buildStructuralReport just constructed this report from mr; the test changes only row status/policy to exercise correspondence validation.
		const parsedReport = JSON.parse(buildStructuralReport(mr)) as {
			report_version: string;
			files: Record<string, { mutants: Array<Record<string, unknown>> }>;
		};
		const entry = parsedReport.files[mr.job.target_file]!;
		const flipped = entry.mutants.find((row) => row.mutant_id === mr.mutants[0]!.mutant_id)!;
		flipped.status = "excluded";
		flipped.policy_id = mr.excluded[0]!.policy_id;
		const text = JSON.stringify(parsedReport);
		expect(
			verifyReportAgainstEnvelope(withReport(mr, text), Buffer.from(text, "utf8")),
		).toContain(`report marks executable mutant "${mr.mutants[0]!.mutant_id}" as excluded`);
	});

	// test-contract: security — an extra row that does not correspond to
	// any envelope mutant or exclusion rejects on the final row-count check,
	// even though every envelope entry finds its own matching row.
	it("N11: an extra report row with no matching envelope entry rejects", () => {
		const mr = validMutationResult();
		// SAFETY: buildStructuralReport just constructed this report from mr; the test appends one foreign row and checks its rejection.
		const parsedReport = JSON.parse(buildStructuralReport(mr)) as {
			report_version: string;
			files: Record<string, { mutants: Array<Record<string, unknown>> }>;
		};
		const entry = parsedReport.files[mr.job.target_file]!;
		entry.mutants.push({ ...mr.mutants[0]!, mutant_id: sha("extra-row-marker"), status: "survived" });
		const text = JSON.stringify(parsedReport);
		expect(
			verifyReportAgainstEnvelope(withReport(mr, text), Buffer.from(text, "utf8")),
		).toContain("row(s) but the envelope accounts for exactly");
	});
});
