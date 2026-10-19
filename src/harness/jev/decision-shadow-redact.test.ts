import { describe, expect, it } from "vitest";
import {
	boundE20,
	commandOf,
	firstSecretMatch,
	maskedSecretContext,
	maskToken,
	pyDumpsHead,
	redactE20,
	residualSecretMatches,
} from "./decision-shadow-redact.js";

// Synthetic, assembled at runtime so no literal credential sits in the source.
const OPENAI_LIKE = `sk-${"A1b2C3d4E5f6G7h8"}${"I9j0K1l2M3n4O5p6"}`;
const AWS_LIKE = `AKIA${"Q7RZ"}${"M2PX"}${"K9TW"}${"V4BD"}`;

describe("decision-shadow-redact — positive (must fire)", () => {
	it("P1: redactE20 replaces a key-shaped token and keeps the assignment name", () => {
		const out = redactE20(`export OPENAI_API_KEY=${OPENAI_LIKE} && echo hi`);
		expect(out).not.toContain(OPENAI_LIKE);
		expect(out).toContain("[redacted]");
		expect(out).toContain("echo hi");
	});

	it("P2: boundE20 truncates with the E20 suffix at the cap", () => {
		const out = boundE20("x".repeat(300), 200);
		expect(out).toBe(`${"x".repeat(180)} …[truncated]`);
	});

	it("P3: pyDumpsHead renders Python json.dumps separators and literals", () => {
		expect(pyDumpsHead({ file_path: "/a.ts", n: 1, ok: true, none: null, list: [1, "b"] }, 500)).toBe(
			'{"file_path": "/a.ts", "n": 1, "ok": true, "none": null, "list": [1, "b"]}',
		);
	});

	it("P4: pyDumpsHead is a prefix of the full render when the budget cuts it", () => {
		const value = { content: "y".repeat(5_000), file_path: "/z" };
		const full = pyDumpsHead(value, 1_000_000);
		const head = pyDumpsHead(value, 200);
		expect(full.startsWith(head.slice(0, 200))).toBe(true);
		expect(head.length).toBeGreaterThanOrEqual(200);
	});

	it("P5: maskedSecretContext marks the target with first-4/last-2 and drops the raw value", () => {
		const text = `config line one\nOPENAI_API_KEY="${OPENAI_LIKE}"\nother text`;
		const hit = firstSecretMatch(text, "sig-secret-openai");
		expect(hit).not.toBeNull();
		if (!hit) return;
		const ctx = maskedSecretContext(text, hit.start, hit.end);
		expect(ctx).toContain(`⟦${maskToken(hit.raw)}⟧`);
		expect(ctx).not.toContain(OPENAI_LIKE);
		expect(ctx).not.toContain(OPENAI_LIKE.slice(4, -2));
	});

	it("P6: a neighbouring high-entropy token is masked too", () => {
		const neighbour = "Zq8vN3kW1xR7tY5uP2mL9sD4fG6hJ0cB";
		const text = `AWS_KEY=${AWS_LIKE} other=${neighbour} tail`;
		const hit = firstSecretMatch(text, "sig-secret-aws-key");
		expect(hit).not.toBeNull();
		if (!hit) return;
		const ctx = maskedSecretContext(text, hit.start, hit.end);
		expect(ctx).not.toContain(neighbour);
		expect(ctx).toContain(maskToken(neighbour));
	});
});

describe("decision-shadow-redact — negative (must not fire)", () => {
	it("N1: redactE20 leaves ordinary commands unchanged", () => {
		expect(redactE20("git status && npm run typecheck")).toBe("git status && npm run typecheck");
	});

	it("N2: boundE20 leaves short text and null alone", () => {
		expect(boundE20("ls -la", 200)).toBe("ls -la");
		expect(boundE20(null, 200)).toBeNull();
	});

	it("N3: a long low-entropy word without digits is not masked as a secret", () => {
		const text = `AKIA${"Q7RZM2PXK9TWV4BD"} documentation_paragraph_without_any_digits_here`;
		const hit = firstSecretMatch(text, "sig-secret-aws-key");
		expect(hit).not.toBeNull();
		if (!hit) return;
		expect(maskedSecretContext(text, hit.start, hit.end)).toContain("documentation_paragraph_without_any_digits_here");
	});

	it("N4: firstSecretMatch returns null for an unknown rule or no match", () => {
		expect(firstSecretMatch("nothing here", "sig-secret-openai")).toBeNull();
		expect(firstSecretMatch(OPENAI_LIKE, "sig-not-a-rule")).toBeNull();
	});

	it("N5: no unmasked rule match remains in a masked context", () => {
		const text = `a=${OPENAI_LIKE} b=${AWS_LIKE}`;
		const hit = firstSecretMatch(text, "sig-secret-aws-key");
		expect(hit).not.toBeNull();
		if (!hit) return;
		expect(residualSecretMatches(maskedSecretContext(text, hit.start, hit.end))).toBe(0);
	});

	it("N6: commandOf returns the shell command without JSON wrapping", () => {
		expect(commandOf({ command: "rm -rf build" })).toBe("rm -rf build");
		expect(commandOf({ command: ["git", "push", "--force"] })).toBe("git push --force");
	});
});
