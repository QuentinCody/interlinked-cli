import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isNonemptyFile } from "./rule-matching-file-predicate.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A fixture tree: full.txt (bytes), empty.txt (0 bytes), sub/full.txt, dir/. */
function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "nonempty-file-"));
	roots.push(root);
	writeFileSync(join(root, "full.txt"), "contents\n");
	writeFileSync(join(root, "empty.txt"), "");
	mkdirSync(join(root, "sub"));
	writeFileSync(join(root, "sub", "full.txt"), "x");
	mkdirSync(join(root, "dir"));
	return root;
}

describe("isNonemptyFile — positive (must fire: the operand is a non-empty file)", () => {
	it("P1: an existing file with contents, relative to cwd", () => {
		const root = fixture();
		expect(isNonemptyFile(": > full.txt", "full.txt", root)).toBe(true);
	});
	it("P2: a relative operand after a same-command cd hop", () => {
		const root = fixture();
		expect(isNonemptyFile("cd sub && : > full.txt", "full.txt", root)).toBe(true);
	});
	it("P3: a quoted operand is unquoted before resolution", () => {
		const root = fixture();
		expect(isNonemptyFile('truncate -s 0 "full.txt"', '"full.txt"', root)).toBe(true);
	});
	it("P4: an operand the resolver cannot place keeps the match (fail closed)", () => {
		const root = fixture();
		expect(isNonemptyFile(": > $UNSET_DIR/full.txt", "$UNSET_DIR/full.txt", root)).toBe(true);
	});
});

describe("isNonemptyFile — negative (must not fire: nothing to destroy)", () => {
	it("N1: a file that does not exist yet", () => {
		const root = fixture();
		expect(isNonemptyFile(": > .gitkeep", ".gitkeep", root)).toBe(false);
		expect(isNonemptyFile("mkdir -p logs && : > logs/app.log", "logs/app.log", root)).toBe(false);
	});
	it("N2: an existing empty file", () => {
		const root = fixture();
		expect(isNonemptyFile(": > empty.txt", "empty.txt", root)).toBe(false);
	});
	it("N3: a directory", () => {
		const root = fixture();
		expect(isNonemptyFile(": > dir", "dir", root)).toBe(false);
	});
	it("N4: a cd hop that moves the operand to an absent file", () => {
		const root = fixture();
		expect(isNonemptyFile("cd dir && : > full.txt", "full.txt", root)).toBe(false);
	});
});
