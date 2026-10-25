import { describe, expect, it } from "vitest";
import {
	formatOpenObligations,
	isExemptPath,
	obligationConflictMarkerRule,
	type ToolEvent,
} from "./obligation-inventory.js";

let idSeq = 0;
function edit(file: string, oldString: string, newString: string): ToolEvent {
	idSeq += 1;
	return {
		ts: new Date(2026, 5, 27, 1, 0, idSeq % 60).toISOString(),
		session: "s1",
		tool: "Edit",
		toolUseId: `me${idSeq}`,
		hook: "PostToolUse",
		input: { file_path: file, old_string: oldString, new_string: newString },
	};
}

function write(file: string, content: string): ToolEvent {
	idSeq += 1;
	return {
		ts: new Date(2026, 5, 27, 1, 0, idSeq % 60).toISOString(),
		session: "s1",
		tool: "Write",
		toolUseId: `mw${idSeq}`,
		hook: "PostToolUse",
		input: { file_path: file, content },
	};
}

describe("isExemptPath — mutation hardening", () => {
	// Basis: obligation-inventory.ts:76,79-81 — docs/prose files, snapshots are exempt.
	it("exempts plain-text and reStructuredText prose files like markdown", () => {
		expect(isExemptPath("notes/plan.txt")).toBe(true);
		expect(isExemptPath("notes/plan.rst")).toBe(true);
		expect(isExemptPath("notes/plan.mdx")).toBe(true);
	});

	it("exempts Windows-style backslash paths under fixtures and docs", () => {
		expect(isExemptPath("src\\__fixtures__\\a.ts")).toBe(true);
		expect(isExemptPath("pkg\\docs\\a.ts")).toBe(true);
	});

	it("exempts a docs/ directory at any depth but not a directory that merely ends in 'docs'", () => {
		expect(isExemptPath("packages/app/docs/helper.ts")).toBe(true);
		expect(isExemptPath("src/mydocs/helper.ts")).toBe(false);
	});

	it("exempts a .snap snapshot file that is not inside a __snapshots__ directory", () => {
		expect(isExemptPath("src/legacy.snap")).toBe(true);
	});
});

describe("formatOpenObligations — mutation hardening", () => {
	// Basis: obligation-inventory.ts:133 — the TODO / FIXME / XXX / HACK family.
	it("lists HACK and XXX markers as open TODO-family obligations", () => {
		const msg = formatOpenObligations([
			edit("src/hack.ts", "a", "// HACK: temporary\na"),
			edit("src/xxx.ts", "b", "// XXX: revisit\nb"),
		]);
		expect(msg).not.toBeNull();
		expect(msg!).toContain("TODO/FIXME/XXX/HACK (2)");
		expect(msg!).toContain("hack.ts");
		expect(msg!).toContain("xxx.ts");
	});

	// Basis: obligation-inventory.ts:135-137 — only a ticket/author tag suppresses.
	it("does not treat an empty or whitespace-only (...) suffix as a ticket tag", () => {
		const msg = formatOpenObligations([edit("src/blank-tag.ts", "a", "// TODO( ): unowned\na")]);
		expect(msg).not.toBeNull();
		expect(msg!).toContain("blank-tag.ts");
	});

	// Basis: obligation-inventory.ts:246-250 — removing an obligation never seen opened
	// cannot create a phantom negative.
	it("does not report an open obligation after removing a pre-existing one", () => {
		const events = [edit("src/pre.ts", "// TODO: old\nx", "x")];
		expect(formatOpenObligations(events)).toBeNull();
	});

	it("does not let a removed pre-existing obligation cancel a later re-added one", () => {
		const events = [
			edit("src/pre2.ts", "// TODO: old\nx", "x"),
			edit("src/pre2.ts", "x", "// TODO: old\nx"),
		];
		const msg = formatOpenObligations(events);
		expect(msg).not.toBeNull();
		expect(msg!).toContain("TODO/FIXME/XXX/HACK (1): pre2.ts");
	});

	// Basis: obligation-inventory.ts:249-250 — a closed obligation's entry is deleted,
	// not left as a stale zero that still names its file.
	it("does not name a file whose only obligation was closed", () => {
		const events = [
			edit("src/closed-file.ts", "x", "// TODO: gone\nx"),
			edit("src/closed-file.ts", "// TODO: gone\nx", "x"),
			edit("src/open-file.ts", "y", "// TODO: stays\ny"),
		];
		const msg = formatOpenObligations(events);
		expect(msg).not.toBeNull();
		expect(msg!).toContain("open-file.ts");
		expect(msg!).not.toContain("closed-file.ts");
	});

	// Basis: obligation-inventory.ts:92-94,293 — codegen data is exempt.
	it("ignores obligations added in text that carries the @codegen-data marker", () => {
		const events = [edit("src/table.ts", "x", "// @codegen-data\n// TODO: generated\nx")];
		expect(formatOpenObligations(events)).toBeNull();
	});

	// Basis: obligation-inventory.ts:210 — ledger is keyed by (file, kind, signature).
	it("tracks an identical TODO line in two files as two obligations", () => {
		const msg = formatOpenObligations([
			edit("src/dup-a.ts", "x", "// TODO: shared text\nx"),
			edit("src/dup-b.ts", "x", "// TODO: shared text\nx"),
		]);
		expect(msg).not.toBeNull();
		expect(msg!).toContain("TODO/FIXME/XXX/HACK (2)");
		expect(msg!).toContain("dup-a.ts");
		expect(msg!).toContain("dup-b.ts");
	});

	it("closing an identical TODO line in one file leaves the other file's obligation open", () => {
		const msg = formatOpenObligations([
			edit("src/keep-a.ts", "x", "// TODO: shared text\nx"),
			edit("src/keep-b.ts", "x", "// TODO: shared text\nx"),
			edit("src/keep-a.ts", "// TODO: shared text\nx", "x"),
		]);
		expect(msg).not.toBeNull();
		expect(msg!).toContain("TODO/FIXME/XXX/HACK (1): keep-b.ts");
		expect(msg!).not.toContain("keep-a.ts");
	});

	// Basis: obligation-inventory.ts:368-374 — files past the per-kind cap collapse into
	// an "and N more" suffix; the suffix only appears when there is something to count.
	it("never prints an '…and 0 more' suffix and accounts for every file", () => {
		for (let n = 1; n <= 12; n += 1) {
			const events = Array.from({ length: n }, (_, i) =>
				edit(`src/cap${i}.ts`, "x", `// TODO: item ${i}\nx`),
			);
			const msg = formatOpenObligations(events)!;
			expect(msg).not.toContain("and 0 more");
			const line = msg.split("\n").find((l) => l.includes("TODO/FIXME/XXX/HACK"))!;
			const listed = (line.match(/cap\d+\.ts/g) ?? []).length;
			const more = /…and (\d+) more/.exec(line);
			expect(listed + (more ? Number(more[1]) : 0)).toBe(n);
		}
	});
});

describe("obligationConflictMarkerRule — mutation hardening", () => {
	// Basis: obligation-inventory.ts:397-400 — a marker from an earlier same-file edit
	// that survives a later edit is flagged as persisted.
	it("notes persistence when the earlier marker came from a full Write", () => {
		const earlier = write("src/persist.ts", "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n");
		const latest = edit("src/persist.ts", "a", "<<<<<<< HEAD\na2");
		const v = obligationConflictMarkerRule([earlier], latest);
		expect(v).not.toBeNull();
		expect(v!.message).toContain("survived this one");
	});
});
