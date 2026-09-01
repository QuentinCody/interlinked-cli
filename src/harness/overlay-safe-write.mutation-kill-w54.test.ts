import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyDirInTree, removeInTree, writeFileInTree } from "./overlay-safe-write.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "ilk-overlay-safe-write-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("materializeSymlinkedDir — recursive copy + dereference preserved (positive)", () => {
	it("copies sibling contents recursively and preserves nested symlinks verbatim", () => {
		// Source dir OUTSIDE root, with a sibling file and a nested symlink.
		const outside = mkdtempSync(join(tmpdir(), "ilk-overlay-src-"));
		const realTargetFile = join(outside, "real-target.txt");
		writeFileSync(realTargetFile, "target-content");
		const srcDir = join(outside, "srcdir");
		mkdirSync(srcDir);
		writeFileSync(join(srcDir, "sibling.txt"), "sibling-content");
		const nestedLink = join(srcDir, "nested-link");
		symlinkSync(realTargetFile, nestedLink);

		// root/linkdir -> srcDir (symlinked directory segment)
		const linkDir = join(tmpRoot, "linkdir");
		symlinkSync(srcDir, linkDir);

		const written = writeFileInTree(tmpRoot, "linkdir/new.txt", "hello");

		// The write itself succeeded.
		expect(readFileSync(written, "utf-8")).toBe("hello");
		// Recursive copy brought over the sibling file (kills recursive:true→{} / true→false).
		expect(readFileSync(join(tmpRoot, "linkdir", "sibling.txt"), "utf-8")).toBe("sibling-content");
		// Nested symlink preserved AS a symlink, not dereferenced into file content
		// (kills dereference:false→true).
		const copiedNested = join(tmpRoot, "linkdir", "nested-link");
		expect(lstatSync(copiedNested).isSymbolicLink()).toBe(true);
		expect(realpathSync(readlinkSync(copiedNested))).toBe(realpathSync(realTargetFile));

		rmSync(outside, { recursive: true, force: true });
	});
});

describe("materializeSymlinkedDir — ancestor-of-root guard (equality branch)", () => {
	it("detects a symlink resolving to root itself, warns, and leaves it empty", () => {
		const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const rootReal = realpathSync(tmpRoot);
		const linkDir = join(tmpRoot, "selflink");
		symlinkSync(rootReal, linkDir);

		const written = writeFileInTree(tmpRoot, "selflink/new.txt", "hi");

		expect(readFileSync(written, "utf-8")).toBe("hi");
		const expectedMsg = `[interlinked:overlay] WARNING: symlinked dir ${linkDir} resolves to an ancestor of the tree — left empty\n`;
		const calls = writeSpy.mock.calls.map((c) => c[0]);
		expect(calls).toContain(expectedMsg);
		// Only the newly written file should be present under selflink — no attempt
		// to recursively copy root into its own subdirectory occurred.
		expect(existsSync(join(tmpRoot, "selflink", "new.txt"))).toBe(true);
	});
});

describe("materializeSymlinkedDir — broken link and file-target early returns", () => {
	it("silently materializes an empty dir for a broken symlink (no stderr warning)", () => {
		const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const linkDir = join(tmpRoot, "brokenlink");
		symlinkSync(join(tmpRoot, "does-not-exist-target"), linkDir);

		const written = writeFileInTree(tmpRoot, "brokenlink/new.txt", "content");

		expect(readFileSync(written, "utf-8")).toBe("content");
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it("silently materializes an empty dir when the link resolves to a file, not a dir", () => {
		const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const outside = mkdtempSync(join(tmpdir(), "ilk-overlay-file-target-"));
		const fileTarget = join(outside, "afile.txt");
		writeFileSync(fileTarget, "not-a-dir");
		const linkDir = join(tmpRoot, "filelink");
		symlinkSync(fileTarget, linkDir);

		const written = writeFileInTree(tmpRoot, "filelink/new.txt", "content2");

		expect(readFileSync(written, "utf-8")).toBe("content2");
		expect(writeSpy).not.toHaveBeenCalled();

		rmSync(outside, { recursive: true, force: true });
	});
});

describe("removeEntryNoFollow — symlink vs real-entry branch (via removeInTree)", () => {
	it("unlinks a directory symlink without touching its target's contents", () => {
		const targetDir = join(tmpRoot, "real-target-dir");
		mkdirSync(targetDir);
		writeFileSync(join(targetDir, "keep.txt"), "keep-me");

		const linkDir = join(tmpRoot, "dirlink");
		symlinkSync(targetDir, linkDir);

		expect(() => removeInTree(tmpRoot, "dirlink")).not.toThrow();

		expect(existsSync(linkDir)).toBe(false);
		// Target directory and its file must survive — only the link was removed.
		expect(readFileSync(join(targetDir, "keep.txt"), "utf-8")).toBe("keep-me");
	});

	it("removes a real (non-symlink) directory recursively via rmSync", () => {
		const realDir = join(tmpRoot, "real-plain-dir");
		mkdirSync(realDir);
		writeFileSync(join(realDir, "inside.txt"), "inside-content");

		expect(() => removeInTree(tmpRoot, "real-plain-dir")).not.toThrow();
		expect(existsSync(realDir)).toBe(false);
	});
});

describe("desymlinkParents — non-existent parent segment handling", () => {
	it("writes into a not-yet-existing nested directory without throwing", () => {
		const written = writeFileInTree(tmpRoot, "brandnew/nested/file.txt", "deep-content");
		expect(readFileSync(written, "utf-8")).toBe("deep-content");
		expect(existsSync(join(tmpRoot, "brandnew", "nested", "file.txt"))).toBe(true);
	});
});

describe("desymlinkPath — target removal semantics", () => {
	it("throws rather than silently deleting a pre-existing directory at the write target", () => {
		const dirAtTarget = join(tmpRoot, "was-a-dir");
		mkdirSync(dirAtTarget);

		expect(() => writeFileInTree(tmpRoot, "was-a-dir", "oops")).toThrow();
	});
});

describe("copyDirInTree — recursive directory copy", () => {
	it("copies nested subdirectories and files, not just the top level", () => {
		const outside = mkdtempSync(join(tmpdir(), "ilk-overlay-copydir-"));
		mkdirSync(join(outside, "sub"), { recursive: true });
		writeFileSync(join(outside, "top.txt"), "top-content");
		writeFileSync(join(outside, "sub", "deep.txt"), "deep-content");

		expect(() => copyDirInTree(tmpRoot, "copied", outside)).not.toThrow();

		expect(readFileSync(join(tmpRoot, "copied", "top.txt"), "utf-8")).toBe("top-content");
		expect(readFileSync(join(tmpRoot, "copied", "sub", "deep.txt"), "utf-8")).toBe("deep-content");

		rmSync(outside, { recursive: true, force: true });
	});
});
