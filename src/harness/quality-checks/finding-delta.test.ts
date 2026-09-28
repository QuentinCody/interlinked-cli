import { beforeEach, describe, expect, it } from "vitest";
import {
	formatEngineFindings,
	resetFindingDeltaStore,
	splitIntroducedFindings,
} from "./finding-delta.js";

interface Row {
	file: string;
	line: number;
	message: string;
}

const row = (file: string, line: number, message: string): Row => ({ file, line, message });

beforeEach(() => {
	resetFindingDeltaStore();
});

describe("splitIntroducedFindings — positive (must classify as introduced)", () => {
    it("attributes a cold compiler batch to every edited file without claiming unrelated errors", () => {
        const a = row("src/a.ts", 1, "A"), b = row("src/b.ts", 1, "B"), c = row("src/c.ts", 1, "C");
        expect(splitIntroducedFindings("/repo", "typescript", [a.file, b.file], [a, b, c])).toMatchObject({
            introduced: [a, b], preExisting: [c],
        });
    });
	it("P1: a finding absent from the previous run is introduced", () => {
		splitIntroducedFindings("/repo", "typescript", "src/a.ts", [row("src/a.ts", 3, "TS1: old")]);
		const second = splitIntroducedFindings("/repo", "typescript", "src/a.ts", [
			row("src/a.ts", 3, "TS1: old"),
			row("src/a.ts", 9, "TS2: fresh"),
		]);
		expect(second.introduced.map((r) => r.message)).toEqual(["TS2: fresh"]);
		expect(second.preExisting.map((r) => r.message)).toEqual(["TS1: old"]);
	});

	it("P2: with no previous run, a finding in the EDITED file is introduced (attributable)", () => {
		const first = splitIntroducedFindings("/repo", "typescript", "src/a.ts", [
			row("src/a.ts", 3, "TS1: here"),
		]);
		expect(first.introduced).toHaveLength(1);
		expect(first.preExisting).toHaveLength(0);
	});

	it("P3: a repeated message counts as a multiset — one extra copy is introduced", () => {
		splitIntroducedFindings("/repo", "typescript", "src/a.ts", [row("src/b.ts", 1, "TSX: dup")]);
		const second = splitIntroducedFindings("/repo", "typescript", "src/a.ts", [
			row("src/b.ts", 1, "TSX: dup"),
			row("src/b.ts", 7, "TSX: dup"),
		]);
		expect(second.introduced).toHaveLength(1);
		expect(second.preExisting).toHaveLength(1);
	});
});

describe("splitIntroducedFindings — negative (must classify as pre-existing)", () => {
	it("N1: findings carried over from the previous run are pre-existing (the 14×TS2740 case)", () => {
		const rows = Array.from({ length: 14 }, (_, i) =>
			row("src/binding.test.ts", i + 1, "TS2740: Set<number> is not IdNamespace"),
		);
		splitIntroducedFindings("/repo", "typescript", "src/binding.ts", rows);
		const second = splitIntroducedFindings("/repo", "typescript", "src/other.ts", rows);
		expect(second.introduced).toHaveLength(0);
		expect(second.preExisting).toHaveLength(14);
	});

	it("N2: with no previous run, a finding in an OTHER file is pre-existing (unattributable)", () => {
		const first = splitIntroducedFindings("/repo", "typescript", "src/a.ts", [
			row("src/elsewhere.ts", 5, "TS1: somewhere else"),
		]);
		expect(first.introduced).toHaveLength(0);
		expect(first.preExisting).toHaveLength(1);
	});

	it("N3: line-number drift does not resurrect a carried-over finding", () => {
		splitIntroducedFindings("/repo", "typescript", "src/a.ts", [row("src/b.ts", 10, "TS9: same")]);
		const second = splitIntroducedFindings("/repo", "typescript", "src/a.ts", [
			row("src/b.ts", 22, "TS9: same"),
		]);
		expect(second.introduced).toHaveLength(0);
	});

	it("N4: stores are keyed per project root and tool — no cross-talk", () => {
		splitIntroducedFindings("/repo-a", "typescript", "src/a.ts", [row("src/x.ts", 1, "TS1: a")]);
		const other = splitIntroducedFindings("/repo-b", "typescript", "src/a.ts", [
			row("src/x.ts", 1, "TS1: a"),
		]);
		// repo-b never saw this finding, and it is in another file with no history → pre-existing.
		expect(other.preExisting).toHaveLength(1);
	});
});

describe("formatEngineFindings", () => {
    it("bounds detail while preserving the total number of files and omitted groups", () => {
        const rows = Array.from({ length: 17 }, (_, i) => row(`src/file-${i}.ts`, i + 1, `TS${i}: error`));
        const formatted = formatEngineFindings("src/edited.ts", rows);
        expect(formatted.header).toBe("17 files (while checking src/edited.ts)");
        expect(formatted.detail).toContain("src/file-14.ts(15): TS14: error");
        expect(formatted.detail).not.toContain("src/file-15.ts");
        expect(formatted.detail).toContain("(2 more groups)");
    });
	it("groups by actual file and names the real location in the header", () => {
		const rows = [
			row("src/binding.test.ts", 14, "TS2740: bad"),
			row("src/binding.test.ts", 25, "TS2740: bad"),
			row("src/binding.test.ts", 37, "TS2740: bad"),
		];
		const out = formatEngineFindings("src/checks/spec-structure.ts", rows);
		// The real location leads; the edited file appears only as context.
		expect(out.header.startsWith("src/binding.test.ts")).toBe(true);
		expect(out.header).toContain("while checking");
	});

	it("collapses identical diagnostics to one line with a line list", () => {
		const rows = Array.from({ length: 14 }, (_, i) => row("src/b.ts", i + 1, "TS2740: bad"));
		const out = formatEngineFindings("src/a.ts", rows);
		const dupLines = out.detail.split("\n").filter((l) => l.includes("TS2740"));
		expect(dupLines).toHaveLength(1);
		expect(dupLines[0]).toContain("×14");
	});

	it("keeps distinct diagnostics as separate lines", () => {
		const out = formatEngineFindings("src/a.ts", [
			row("src/a.ts", 1, "TS1: one"),
			row("src/a.ts", 2, "TS2: two"),
		]);
		expect(out.detail).toContain("TS1: one");
		expect(out.detail).toContain("TS2: two");
	});
});
