import { describe, expect, it } from "vitest";
import type { ChangeSet } from "./changeset.js";
import { applyChangeSet, type FileTree, InMemoryProvisioner } from "./provisioner.js";

function nth<T>(arr: readonly T[], i: number): T {
	const v = arr[i];
	if (v === undefined) throw new Error(`expected element ${i}`);
	return v;
}

function tree(entries: Array<[string, string]>): FileTree {
	return new Map(entries);
}

describe("applyChangeSet", () => {
	it("creates and overwrites files via write", () => {
		const next = applyChangeSet(tree([["a", "1"]]), {
			ops: [
				{ kind: "write", path: "a", content: "2" },
				{ kind: "write", path: "b", content: "x" },
			],
		});
		expect(next.get("a")).toBe("2");
		expect(next.get("b")).toBe("x");
	});

	it("applies patch edits sequentially", () => {
		const next = applyChangeSet(tree([["a", "foo bar"]]), {
			ops: [
				{
					kind: "patch",
					path: "a",
					edits: [
						{ oldString: "foo", newString: "FOO" },
						{ oldString: "bar", newString: "BAR" },
					],
				},
			],
		});
		expect(next.get("a")).toBe("FOO BAR");
	});

	it("deletes and renames (renaming a missing file is a no-op)", () => {
		const next = applyChangeSet(tree([["d", "x"], ["from", "content"]]), {
			ops: [
				{ kind: "delete", path: "d" },
				{ kind: "rename", from: "from", to: "to" },
				{ kind: "rename", from: "ghost", to: "nope" },
			],
		});
		expect(next.has("d")).toBe(false);
		expect(next.has("from")).toBe(false);
		expect(next.get("to")).toBe("content");
		expect(next.has("nope")).toBe(false);
	});

	it("is non-destructive — the base tree is unchanged", () => {
		const base = tree([["a", "1"]]);
		applyChangeSet(base, { ops: [{ kind: "write", path: "a", content: "2" }] });
		expect(base.get("a")).toBe("1");
	});

	it("throws when a patch oldString is absent (incl. a missing file)", () => {
		const bad: ChangeSet = { ops: [{ kind: "patch", path: "a", edits: [{ oldString: "zzz", newString: "y" }] }] };
		expect(() => applyChangeSet(tree([["a", "x"]]), bad)).toThrow();
		expect(() => applyChangeSet(tree([]), bad)).toThrow();
	});

	it("applies an apply_patch add section, writing the reconstructed content", () => {
		const cs: ChangeSet = {
			ops: [{ kind: "apply_patch", path: "new.txt", section: { path: "new.txt", op: "add", body: ["+hello"] } }],
		};
		const next = applyChangeSet(tree([]), cs);
		expect(next.get("new.txt")).toBe("hello");
	});

	it("applies an apply_patch delete section, removing the source file", () => {
		const cs: ChangeSet = {
			ops: [{ kind: "apply_patch", path: "old.txt", section: { path: "old.txt", op: "delete", body: [] } }],
		};
		const next = applyChangeSet(tree([["old.txt", "content"]]), cs);
		expect(next.has("old.txt")).toBe(false);
	});

	it("applies a moved apply_patch update section, reading before-content from fromPath and dropping it", () => {
		const cs: ChangeSet = {
			ops: [
				{
					kind: "apply_patch",
					path: "new-name.ts",
					section: { path: "new-name.ts", op: "update", fromPath: "old-name.ts", body: [" foo", "-bar", "+BAR"] },
				},
			],
		};
		const next = applyChangeSet(tree([["old-name.ts", "foo\nbar"]]), cs);
		expect(next.has("old-name.ts")).toBe(false);
		expect(next.get("new-name.ts")).toBe("foo\nBAR");
	});

	it("throws with the section's path when an apply_patch update hunk cannot find its context", () => {
		const cs: ChangeSet = {
			ops: [
				{
					kind: "apply_patch",
					path: "unmatched.ts",
					section: { path: "unmatched.ts", op: "update", body: [" absent-context"] },
				},
			],
		};
		expect(() => applyChangeSet(tree([["unmatched.ts", "foo"]]), cs)).toThrow(
			"could not reconstruct apply_patch section for unmatched.ts",
		);
	});
});

describe("InMemoryProvisioner", () => {
	it("seeds, overlays non-destructively, commits, and forks independent copies", async () => {
		const p = new InMemoryProvisioner();
		await p.seed(tree([["a", "1"]]));

		const snap = await p.applyOverlay({ ops: [{ kind: "write", path: "a", content: "2" }] });
		expect(snap.tree.get("a")).toBe("2");
		expect(snap.changedPaths).toEqual(["a"]);

		const after = await p.applyOverlay({ ops: [] });
		expect(after.tree.get("a")).toBe("1"); // the overlay did not mutate session state

		await p.commitChange({ ops: [{ kind: "write", path: "a", content: "3" }] });
		const forks = await p.forkCopy(2);
		expect(forks).toHaveLength(2);
		nth(forks, 0).set("a", "mutated");
		expect(nth(forks, 1).get("a")).toBe("3"); // forks are independent worker roots
	});
});
