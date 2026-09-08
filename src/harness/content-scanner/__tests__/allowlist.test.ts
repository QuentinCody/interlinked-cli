// Tests for the allowlist filter that suppresses known false positives
// emitted by the OPF model. The contract that matters most: matching
// findings are dropped, non-matching findings pass through unchanged,
// and the kind catalog is fixed (no user-supplied regex → no ReDoS).

import { describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { applyAllowlist, compileAllowlist } from "../allowlist.js";
import type { ScanFinding } from "../types.js";

function finding(args: { label: string; text: string; start?: number }): ScanFinding {
	const start = args.start ?? 0;
	return {
		label: args.label,
		start,
		end: start + args.text.length,
		text: args.text,
		source: "Bash.command",
		score: 1,
	};
}

describe("compileAllowlist — graceful degradation", () => {
	it("returns an empty list when allowlist is undefined", () => {
		expect(compileAllowlist(undefined)).toEqual([]);
	});

	it("returns an empty list when allowlist is empty", () => {
		expect(compileAllowlist([])).toEqual([]);
	});

	it("skips entries with an unknown kind so newer config files don't crash older harnesses", () => {
		const entries = [
			{ kind: "exact", pattern: "noreply@anthropic.com", label: "private_email" },
			{ kind: "future_kind_we_dont_have_yet", pattern: "x", label: "private_person" },
			{ kind: "snake_case_identifier", label: "private_person" },
		];
		const compiled = compileAllowlist(entries);
		expect(compiled).toHaveLength(2);
	});

	it.each([null, { kind: "prefix" }, { kind: "contains", pattern: 1 }, { kind: "exact", pattern: "secret", label: 7 }, { kind: "uuid", reason: false }])("skips malformed entries without suppressing a valid neighboring finding: %j", (malformed) => {
		const compiled = compileAllowlist([malformed, { kind: "exact", pattern: "allowed" }]);
		const secret = finding({ label: "secret", text: "secret" });
		expect(compiled).toHaveLength(1);
		expect(applyAllowlist([secret], compiled).kept).toEqual([secret]);
	});

	it("ignores a malformed non-array allowlist", () => {
		expect(compileAllowlist({ kind: "exact", pattern: "secret" })).toEqual([]);
	});
});

describe("applyAllowlist — exact match", () => {
	it("drops a finding whose text equals the literal pattern", () => {
		const findings = [finding({ label: "private_email", text: "noreply@anthropic.com" })];
		const compiled = compileAllowlist([
			{ kind: "exact", pattern: "noreply@anthropic.com", label: "private_email" },
		]);
		const result = applyAllowlist(findings, compiled);
		expect(result.kept).toEqual([]);
		expect(result.suppressed).toHaveLength(1);
	});

	it("is case-sensitive — capital domain does not match lowercase pattern", () => {
		const findings = [finding({ label: "private_email", text: "noreply@Anthropic.com" })];
		const compiled = compileAllowlist([
			{ kind: "exact", pattern: "noreply@anthropic.com", label: "private_email" },
		]);
		const result = applyAllowlist(findings, compiled);
		expect(result.kept).toEqual(findings);
	});
});

describe("applyAllowlist — prefix / suffix / contains", () => {
	it("prefix matches case-insensitively", () => {
		const findings = [finding({ label: "private_email", text: "Noreply@example.org" })];
		const compiled = compileAllowlist([
			{ kind: "prefix", pattern: "noreply@", label: "private_email" },
		]);
		expect(applyAllowlist(findings, compiled).kept).toEqual([]);
	});

	it("suffix matches case-insensitively", () => {
		const findings = [finding({ label: "private_email", text: "support@Example.COM" })];
		const compiled = compileAllowlist([
			{ kind: "suffix", pattern: "@example.com", label: "private_email" },
		]);
		expect(applyAllowlist(findings, compiled).kept).toEqual([]);
	});

	it("contains matches case-insensitively", () => {
		const findings = [finding({ label: "private_url", text: "https://EXAMPLE.com/u/x" })];
		const compiled = compileAllowlist([
			{ kind: "contains", pattern: "example.com", label: "private_url" },
		]);
		expect(applyAllowlist(findings, compiled).kept).toEqual([]);
	});
});

describe("applyAllowlist — email_domain", () => {
	it("matches addresses ending with @<pattern>", () => {
		const findings = [finding({ label: "private_email", text: "anyone@anthropic.com" })];
		const compiled = compileAllowlist([
			{ kind: "email_domain", pattern: "anthropic.com", label: "private_email" },
		]);
		expect(applyAllowlist(findings, compiled).kept).toEqual([]);
	});

	it("does NOT match addresses that merely contain the domain as a substring", () => {
		// Regression: "example.com" must not allowlist "x@evilexample.com" — the
		// @ anchor blocks the substring shortcut a regex naively might allow.
		const findings = [finding({ label: "private_email", text: "x@evilexample.com" })];
		const compiled = compileAllowlist([
			{ kind: "email_domain", pattern: "example.com", label: "private_email" },
		]);
		expect(applyAllowlist(findings, compiled).kept).toEqual(findings);
	});
});

describe("applyAllowlist — snake_case_identifier", () => {
	it("drops a snake_case identifier mislabeled as private_person", () => {
		// Real false positive observed in production — the OPF model labeled
		// the identifier `content_scanner` as private_person.
		const findings = [finding({ label: "private_person", text: "content_scanner" })];
		const compiled = compileAllowlist([
			{ kind: "snake_case_identifier", label: "private_person" },
		]);
		expect(applyAllowlist(findings, compiled).kept).toEqual([]);
	});

	it("keeps a real person name with a space", () => {
		const findings = [finding({ label: "private_person", text: "Marigold Thistlewood" })];
		const compiled = compileAllowlist([
			{ kind: "snake_case_identifier", label: "private_person" },
		]);
		expect(applyAllowlist(findings, compiled).kept).toEqual(findings);
	});

	it("does not match an identifier starting with an uppercase letter", () => {
		const findings = [finding({ label: "private_person", text: "ContentScanner" })];
		const compiled = compileAllowlist([
			{ kind: "snake_case_identifier", label: "private_person" },
		]);
		expect(applyAllowlist(findings, compiled).kept).toEqual(findings);
	});
});

describe("applyAllowlist — uuid", () => {
	it("drops a UUID flagged as a secret (a real FP class for canonical IDs)", () => {
		const findings = [
			finding({ label: "secret", text: "550e8400-e29b-41d4-a716-446655440000" }),
		];
		const compiled = compileAllowlist([{ kind: "uuid", label: "secret" }]);
		expect(applyAllowlist(findings, compiled).kept).toEqual([]);
	});

	it("does NOT match a non-UUID string", () => {
		const findings = [finding({ label: "secret", text: "sk-live-abc123def456" })];
		const compiled = compileAllowlist([{ kind: "uuid", label: "secret" }]);
		expect(applyAllowlist(findings, compiled).kept).toEqual(findings);
	});
});

describe("applyAllowlist — label scope", () => {
	it("skips an entry whose label does not match the finding's label", () => {
		const findings = [finding({ label: "secret", text: "noreply@anthropic.com" })];
		const compiled = compileAllowlist([
			{ kind: "exact", pattern: "noreply@anthropic.com", label: "private_email" },
		]);
		expect(applyAllowlist(findings, compiled).kept).toEqual(findings);
	});

	it("applies category-agnostic entries to any label when label is omitted", () => {
		const findings = [
			finding({ label: "private_email", text: "spam" }),
			finding({ label: "secret", text: "spam" }),
		];
		const compiled = compileAllowlist([{ kind: "exact", pattern: "spam" }]);
		const result = applyAllowlist(findings, compiled);
		expect(result.kept).toEqual([]);
		expect(result.suppressed).toHaveLength(2);
	});
});

describe("applyAllowlist — passthrough when nothing matches", () => {
	it("passes findings through unchanged when allowlist is empty", () => {
		const findings = [finding({ label: "private_email", text: "x@y.com" })];
		const result = applyAllowlist(findings, []);
		expect(result.kept).toEqual(findings);
		expect(result.suppressed).toEqual([]);
	});

	it("each finding is checked against the full entry list independently", () => {
		const findings = [
			finding({ label: "private_email", text: "noreply@anthropic.com" }),
			finding({ label: "private_person", text: "content_scanner" }),
			finding({ label: "secret", text: "sk-live-abc123def456" }),
		];
		const compiled = compileAllowlist([
			{ kind: "exact", pattern: "noreply@anthropic.com", label: "private_email" },
			{ kind: "snake_case_identifier", label: "private_person" },
		]);
		const result = applyAllowlist(findings, compiled);
		expect(result.kept).toHaveLength(1);
		expect(nonNull(result.kept[0]).label).toBe("secret");
		expect(result.suppressed).toHaveLength(2);
	});
});
