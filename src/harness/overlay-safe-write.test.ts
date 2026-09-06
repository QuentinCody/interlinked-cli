import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeInTree, symlinkInTree, writeFileInTree } from "./overlay-safe-write.js";

// A one-shot override for cpSync, toggled only by the "cpSync throws" test
// below. Every other call — including cpSync calls made by other tests in
// this file — passes straight through to the real implementation, so this
// mock changes nothing about the file's existing real-filesystem tests.
const cpSyncOverride = vi.hoisted((): { throwOnce: Error | null } => ({ throwOnce: null }));
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		cpSync: (...args: Parameters<typeof actual.cpSync>) => {
			if (cpSyncOverride.throwOnce) {
				const err = cpSyncOverride.throwOnce;
				cpSyncOverride.throwOnce = null;
				throw err;
			}
			return actual.cpSync(...args);
		},
	};
});

// SYMLINK-ESCAPE CONTRACT (findings 2026-06: overlay + snapshot data corruption). A
// repo can contain symlinked files or directories; a naive writeFileSync /
// copyFileSync FOLLOWS them and modifies the real target OUTSIDE the temp tree — data
// corruption during a read-only gate. Every overlay/snapshot write must stay inside
// the tree root, never touching an external symlink target.

let base: string;
beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "safe-write-"));
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("writeFileInTree — never follows a symlink out of the tree", () => {
	it("does NOT follow a symlinked FILE target", () => {
		const root = join(base, "tree");
		mkdirSync(root);
		const external = join(base, "real.txt");
		writeFileSync(external, "ORIGINAL", "utf-8");
		symlinkSync(external, join(root, "link.ts")); // tree/link.ts → ../real.txt

		writeFileInTree(root, "link.ts", "NEW");

		expect(readFileSync(external, "utf-8")).toBe("ORIGINAL"); // external file untouched
		expect(lstatSync(join(root, "link.ts")).isSymbolicLink()).toBe(false); // now a real file
		expect(readFileSync(join(root, "link.ts"), "utf-8")).toBe("NEW");
	});

	it("does NOT follow a symlinked DIRECTORY in the parent path", () => {
		const root = join(base, "tree");
		mkdirSync(root);
		const externalDir = join(base, "ext");
		mkdirSync(externalDir);
		writeFileSync(join(externalDir, "m.ts"), "ORIGINAL", "utf-8");
		symlinkSync(externalDir, join(root, "src"), "dir"); // tree/src → ../ext

		writeFileInTree(root, "src/m.ts", "NEW");

		expect(readFileSync(join(externalDir, "m.ts"), "utf-8")).toBe("ORIGINAL"); // untouched
		expect(lstatSync(join(root, "src")).isSymbolicLink()).toBe(false); // now a real dir
		expect(readFileSync(join(root, "src/m.ts"), "utf-8")).toBe("NEW");
	});
});

describe("symlinkInTree — updates a snapshot symlink without corrupting the old target", () => {
	it("recreates the link to a NEW target without overwriting the OLD target's contents", () => {
		const root = join(base, "tree");
		mkdirSync(root);
		const oldTarget = join(base, "old.txt");
		writeFileSync(oldTarget, "OLD", "utf-8");
		const newTarget = join(base, "new.txt");
		writeFileSync(newTarget, "NEW", "utf-8");
		symlinkSync(oldTarget, join(root, "link")); // existing snapshot symlink (the -a case)

		symlinkInTree(root, "link", newTarget);

		expect(readFileSync(oldTarget, "utf-8")).toBe("OLD"); // OLD external target untouched
		expect(lstatSync(join(root, "link")).isSymbolicLink()).toBe(true); // still a symlink
		expect(readlinkSync(join(root, "link"))).toBe(newTarget); // now points at NEW
	});
});

// SIBLING-PRESERVATION CONTRACT (finding 2026-06). Replacing a symlinked parent
// directory with an EMPTY real dir made every sibling under it vanish from the
// overlay — module resolution / sibling tests failed and the red-bar gate falsely
// blocked valid edits in symlink-based workspaces. The replacement dir must carry
// a COPY of the link target's contents, while writes still never escape the tree.
describe("writeFileInTree — symlinked parents are MATERIALIZED, not emptied", () => {
	it("preserves SIBLING files when writing under a symlinked directory", () => {
		const root = join(base, "tree");
		mkdirSync(root);
		const externalDir = join(base, "shared-lib");
		mkdirSync(join(externalDir, "nested"), { recursive: true });
		writeFileSync(join(externalDir, "edited.ts"), "ORIGINAL", "utf-8");
		writeFileSync(join(externalDir, "sibling.ts"), "SIBLING", "utf-8");
		writeFileSync(join(externalDir, "nested", "deep.ts"), "DEEP", "utf-8");
		symlinkSync(externalDir, join(root, "lib"), "dir"); // tree/lib → ../shared-lib

		writeFileInTree(root, "lib/edited.ts", "NEW");

		// The write landed inside the tree; the external dir is untouched.
		expect(readFileSync(join(externalDir, "edited.ts"), "utf-8")).toBe("ORIGINAL");
		expect(lstatSync(join(root, "lib")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(root, "lib/edited.ts"), "utf-8")).toBe("NEW");
		// Siblings (and nested content) SURVIVED the de-symlinking.
		expect(readFileSync(join(root, "lib/sibling.ts"), "utf-8")).toBe("SIBLING");
		expect(readFileSync(join(root, "lib/nested/deep.ts"), "utf-8")).toBe("DEEP");
	});

	it("a nested symlink inside the materialized dir is preserved but still WRITE-guarded", () => {
		const root = join(base, "tree");
		mkdirSync(root);
		const externalDir = join(base, "shared-lib");
		mkdirSync(externalDir);
		const externalFile = join(base, "secret.txt");
		writeFileSync(externalFile, "SECRET", "utf-8");
		symlinkSync(externalFile, join(externalDir, "inner-link.txt"));
		symlinkSync(externalDir, join(root, "lib"), "dir");

		writeFileInTree(root, "lib/edited.ts", "NEW");

		// Nested links copy VERBATIM (the project mirror's own contract); the
		// escape guarantee lives in the WRITE path — a later in-tree write to the
		// linked path must de-symlink it, never modify the external target.
		writeFileInTree(root, "lib/inner-link.txt", "IN-TREE");
		expect(readFileSync(externalFile, "utf-8")).toBe("SECRET"); // untouched
		expect(lstatSync(join(root, "lib/inner-link.txt")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(root, "lib/inner-link.txt"), "utf-8")).toBe("IN-TREE");
	});

	it("falls back to an empty dir for a BROKEN symlinked parent (write still succeeds)", () => {
		const root = join(base, "tree");
		mkdirSync(root);
		symlinkSync(join(base, "does-not-exist"), join(root, "lib"), "dir");

		writeFileInTree(root, "lib/edited.ts", "NEW");

		expect(lstatSync(join(root, "lib")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(root, "lib/edited.ts"), "utf-8")).toBe("NEW");
	});

	it("falls back to an empty dir when the parent symlink points at a FILE", () => {
		const root = join(base, "tree");
		mkdirSync(root);
		const externalFile = join(base, "a-file.txt");
		writeFileSync(externalFile, "FILE", "utf-8");
		symlinkSync(externalFile, join(root, "lib"));

		writeFileInTree(root, "lib/edited.ts", "NEW");

		expect(readFileSync(join(root, "lib/edited.ts"), "utf-8")).toBe("NEW");
		expect(readFileSync(externalFile, "utf-8")).toBe("FILE"); // untouched
	});

	it("warns with the underlying error's message and still completes the write when cpSync throws mid-materialize", () => {
		const root = join(base, "tree");
		mkdirSync(root);
		const externalDir = join(base, "shared-lib");
		mkdirSync(externalDir);
		writeFileSync(join(externalDir, "sibling.ts"), "SIBLING", "utf-8");
		symlinkSync(externalDir, join(root, "lib"), "dir"); // tree/lib → ../shared-lib

		cpSyncOverride.throwOnce = new Error("EMFILE: too many open files");
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		writeFileInTree(root, "lib/edited.ts", "NEW");
		// Read the call history BEFORE mockRestore() — mockRestore() also clears
		// mock.calls (same as mockReset()), so reading after would always see [].
		const warned = stderrSpy.mock.calls.map((call) => String(call[0])).join("\n");
		stderrSpy.mockRestore();

		// The warning carries err.message (not String(err), which would read
		// "Error: EMFILE…" instead) — inverting that ternary would break this.
		expect(warned).toContain("could not materialize symlinked dir");
		expect(warned).toContain("(EMFILE: too many open files)");
		// The write itself still lands — the empty-dir fallback, not a crash.
		expect(lstatSync(join(root, "lib")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(root, "lib/edited.ts"), "utf-8")).toBe("NEW");
		// The sibling was never copied in (cpSync threw before it could run).
		expect(lstatSync(join(root, "lib/sibling.ts"), { throwIfNoEntry: false })).toBeUndefined();
	});

	it("refuses to materialize a link to an ANCESTOR of the tree (no recursive self-copy)", () => {
		const root = join(base, "tree");
		mkdirSync(join(root, "other"), { recursive: true });
		writeFileSync(join(root, "other", "x.txt"), "X", "utf-8");
		symlinkSync(base, join(root, "lib"), "dir"); // tree/lib → the tree's PARENT

		writeFileInTree(root, "lib/edited.ts", "NEW");

		// Left empty (plus the written file) rather than copying the tree into itself.
		expect(lstatSync(join(root, "lib")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(root, "lib/edited.ts"), "utf-8")).toBe("NEW");
	});
});

// Round 6 (finding 2026-06): `rmSync(link, {force})` throws ERR_FS_EISDIR for
// a DIRECTORY symlink on newer Node majors (observed on Node 25, inside the
// declared `node >=22` engine range), so every removal here dispatches on
// lstat and unlinks links explicitly — same behavior on every engine version.
describe("directory-symlink removal is unlink, never rm (Node 25 ERR_FS_EISDIR)", () => {
	it("writeFileInTree replaces a dir-symlink AT the target without touching its target", () => {
		const root = join(base, "tree");
		mkdirSync(root);
		const externalDir = join(base, "external");
		mkdirSync(externalDir);
		writeFileSync(join(externalDir, "keep.txt"), "KEEP", "utf-8");
		symlinkSync(externalDir, join(root, "entry"), "dir"); // tree/entry → external dir

		writeFileInTree(root, "entry", "NOW-A-FILE");

		expect(lstatSync(join(root, "entry")).isFile()).toBe(true);
		expect(readFileSync(join(root, "entry"), "utf-8")).toBe("NOW-A-FILE");
		expect(readFileSync(join(externalDir, "keep.txt"), "utf-8")).toBe("KEEP"); // untouched
	});

	it("removeInTree on a dir-symlink removes the LINK, never the target's contents", () => {
		const root = join(base, "tree");
		mkdirSync(root);
		const externalDir = join(base, "external");
		mkdirSync(externalDir);
		writeFileSync(join(externalDir, "keep.txt"), "KEEP", "utf-8");
		symlinkSync(externalDir, join(root, "gone"), "dir");

		removeInTree(root, "gone");

		expect(lstatSync(join(root, "gone"), { throwIfNoEntry: false })).toBeUndefined();
		expect(readFileSync(join(externalDir, "keep.txt"), "utf-8")).toBe("KEEP"); // untouched
	});
});
