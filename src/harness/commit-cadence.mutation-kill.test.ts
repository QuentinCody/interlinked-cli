import { describe, expect, it } from "vitest";
import {
	formatMidSessionBackstop,
	formatStopNudge,
	formatWipCommitsNudge,
	isDocFile,
	isWipCommitSubject,
	readSessionTokens,
} from "./commit-cadence.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

describe("commit-cadence mutation boundaries", () => {
	describe("isDocFile glob semantics", () => {
		it("normalizes Windows separators and still rejects source paths", () => {
			expect(isDocFile("C:\\repo\\docs\\guide.json")).toBe(true);
			expect(isDocFile("C:\\repo\\src\\index.ts")).toBe(false);
		});

		it("uses the recursive relative-prefix fallback for absolute paths", () => {
			expect(isDocFile("/repo/plans/q3.yaml", ["plans/**"])).toBe(true);
			// An explicitly absolute glob must not be broadened by that fallback.
			expect(isDocFile("/repo/plans/q3.yaml", ["/plans/**"])).toBe(false);
		});

		it("keeps single-star matches within one path segment", () => {
			expect(isDocFile("a/b.txt", ["a/*.txt"])).toBe(true);
			expect(isDocFile("a/b/c.txt", ["a/*.txt"])).toBe(false);
			expect(isDocFile("a/b/c.txt", ["a/**/c.txt"])).toBe(true);
			expect(isDocFile("a/c.txt", ["a/**/c.txt"])).toBe(true);
			expect(isDocFile("a/foobar", ["a/**c"])).toBe(false);
		});

		it("distinguishes literal characters from wildcard operators", () => {
			expect(isDocFile("zzz", ["a?c"])).toBe(false);
			expect(isDocFile("a/x", ["a/?"])).toBe(true);
			expect(isDocFile("a/xy", ["a/?"])).toBe(false);
			expect(isDocFile("z", ["a*"])).toBe(false);
		});

		it("escapes regex punctuation and anchors the compiled expression", () => {
			expect(isDocFile("a/bXtxt", ["a/*.txt"])).toBe(false);
			expect(isDocFile("a/b.txt", ["a/(b).txt"])).toBe(false);
			expect(isDocFile("a/[b].txt", ["a/[b].txt"])).toBe(true);
			expect(isDocFile("a/b.txt", ["a/[b].txt"])).toBe(false);
			expect(isDocFile("price$.txt", ["price$.txt"])).toBe(true);
			expect(isDocFile("x/foo", ["/foo"])).toBe(false);
		});
	});

	describe("readSessionTokens and usage extraction", () => {
		function transcript(rows: unknown[]): string {
			const dir = mkdtempSync(join(tmpdir(), "commit-cadence-mutants-"));
			const path = join(dir, "transcript.jsonl");
			writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"));
			return path;
		}

		it("returns null for an existing transcript with no nonzero usage", () => {
			const path = transcript([
				{ type: "assistant", message: { usage: { input_tokens: 0, output_tokens: 0 } } },
			]);
			try {
				expect(readSessionTokens(path)).toBeNull();
			} finally {
				rmSync(dirname(path), { recursive: true, force: true });
			}
		});

		it("ignores null, primitive, and non-assistant rows", () => {
			const path = transcript([
				null,
				"assistant-looking string",
				42,
				{ type: "user", message: { usage: { input_tokens: 900, output_tokens: 900 } } },
				{ type: "assistant", message: { usage: { input_tokens: 3, output_tokens: 4 } } },
			]);
			try {
				expect(readSessionTokens(path)).toEqual({ input: 3, output: 4, total: 7 });
			} finally {
				rmSync(dirname(path), { recursive: true, force: true });
			}
		});

		it("ignores nonnumeric usage fields and accepts either nonzero side", () => {
			const path = transcript([
				{ type: "assistant", message: { usage: { input_tokens: "3", output_tokens: 4 } } },
				{ type: "assistant", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
				{ type: "assistant", message: { usage: { input_tokens: 0, output_tokens: 6 } } },
			]);
			try {
				expect(readSessionTokens(path)).toEqual({ input: 5, output: 10, total: 15 });
			} finally {
				rmSync(dirname(path), { recursive: true, force: true });
			}
		});
	});

	describe("formatStopNudge boundaries and wording", () => {
		const base = { threshold: 5, tokenBandLow: 200_000, tokenBandHigh: 400_000 };

		it("is silent exactly at the file threshold", () => {
			expect(formatStopNudge({ ...base, uncommittedNonDocCount: 5, docFilesExcluded: 0 })).toBeNull();
		});

		it("renders zero, singular, and plural doc exclusions accurately", () => {
			const none = formatStopNudge({ ...base, uncommittedNonDocCount: 6, docFilesExcluded: 0 });
			const one = formatStopNudge({ ...base, uncommittedNonDocCount: 6, docFilesExcluded: 1 });
			const many = formatStopNudge({ ...base, uncommittedNonDocCount: 6, docFilesExcluded: 2 });
			expect(none).not.toContain("doc/plan");
			expect(one).toContain("1 doc/plan file excluded");
			expect(many).toContain("2 doc/plan files excluded");
		});

		it("uses strict token-band boundaries", () => {
			expect(formatStopNudge({ ...base, uncommittedNonDocCount: 6, docFilesExcluded: 0, cumulativeTokens: 200_000 }))
				.toContain("Before ending");
			expect(formatStopNudge({ ...base, uncommittedNonDocCount: 6, docFilesExcluded: 0, cumulativeTokens: 400_000 }))
				.toContain("long session");
			expect(formatStopNudge({ ...base, uncommittedNonDocCount: 6, docFilesExcluded: 0, cumulativeTokens: 400_001 }))
				.toContain("very long session");
		});

		it("retains the complete user-facing guidance in each band", () => {
			const low = formatStopNudge({ ...base, uncommittedNonDocCount: 6, docFilesExcluded: 0 });
			const mid = formatStopNudge({ ...base, uncommittedNonDocCount: 6, docFilesExcluded: 0, cumulativeTokens: 250_000 });
			const high = formatStopNudge({ ...base, uncommittedNonDocCount: 6, docFilesExcluded: 0, cumulativeTokens: 450_000 });
			expect(low).toContain("Before ending: `git status` to review");
			expect(low).toContain("Don't push — leave that to the user.");
			expect(mid).toContain("while context is fresh");
			expect(mid).toContain("Bundle by concern: `git status` to review");
			expect(mid).toContain("Don't push.");
			expect(high).toContain("best captured soon");
			expect(high).toContain("suggested bundling (`git status` to review");
			expect(high).toContain("running `git commit` to clear this notice. Don't push.");
		});
	});

	it("keeps the mid-session backstop explanation", () => {
		const msg = formatMidSessionBackstop({ uncommittedNonDocCount: 41, threshold: 40 });
		expect(msg).toContain("that's a lot to bundle into one concern");
		expect(msg).toContain("Run `git status`");
	});

	describe("formatWipCommitsNudge and subject classification", () => {
		it("does not truncate a list exactly at maxShown and preserves separators", () => {
			const msg = formatWipCommitsNudge({ wipSubjects: ["wip 1", "wip 2", "wip 3"] });
			expect(msg).toContain('"wip 1", "wip 2", "wip 3"');
			expect(msg).not.toContain(", ...");
		});

		it("anchors autosquash exclusions while preserving a real WIP prefix", () => {
			expect(isWipCommitSubject("wip: fixup! parser")).toBe(true);
			expect(isWipCommitSubject("fixup! feat: parser")).toBe(false);
		});
	});
});
