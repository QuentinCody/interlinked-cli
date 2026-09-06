// test-contract: security — local protocol-v3 inputs stay bound to the
// descriptor that was validated, even when their pathname changes mid-read.
// Two internal races — the resolved *requested* path's identity decoupling
// from the tracked descriptor (assertRequestedPathStable), and the tracked
// *path*'s own identity decoupling from it (assertStableRead's own
// currentPathStatus check) — can't be *discriminated* through real
// filesystem timing without an actual concurrent process. confinedCandidate
// makes resolvedTarget === candidate.path by construction, and the two
// internal lstat calls run back-to-back inside assertStableRead with no
// hook seam between them, so any single hook-driven filesystem change is
// observed identically by both checks: proven empirically (see the
// "parent directory is swapped" case below) that a real-fs swap reaching
// one of them always reaches the other too, so a public-path test can prove
// REACHABILITY but not discriminate either check from its neighbor. Both
// races therefore call the exported `assertStableRead` directly with real
// (but hand-assembled) fs.Stats fixtures that decouple the two identities in
// a way no single-hook real race can — the "injectable seam" escape hatch,
// not a mock of the module under test. The short-read case injects the
// `readBytes` seam.

import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertStableRead,
	readConfinedFileBytes,
	readConfinedFileText,
} from "./mutation-cloud-v3-local-read.js";

let root = "";
let outsideRoot = "";

function fixturePath(name = "input.txt"): string {
	root = mkdtempSync(join(tmpdir(), "interlinked-v3-local-read-"));
	const path = join(root, name);
	mkdirSync(join(path, ".."), { recursive: true });
	return path;
}

function input(path: string, maxBytes = 64) {
	return { root, path, maxBytes, label: "protocol-v3 test input" };
}

afterEach(() => {
	if (root !== "") rmSync(root, { recursive: true, force: true });
	if (outsideRoot !== "") rmSync(outsideRoot, { recursive: true, force: true });
	root = "";
	outsideRoot = "";
});

describe("descriptor-bound local protocol-v3 reads", () => {
	it("reads a normal regular file exactly once through its bounded descriptor", () => {
		const path = fixturePath();
		writeFileSync(path, "exact bytes", "utf8");

		expect(readConfinedFileBytes(input(path))).toEqual(Buffer.from("exact bytes"));
		expect(readConfinedFileText(input(path))).toBe("exact bytes");
	});

	it("rejects a file whose descriptor reports more than the byte cap", () => {
		const path = fixturePath();
		writeFileSync(path, Buffer.alloc(65));

		expect(() => readConfinedFileBytes(input(path))).toThrow("64-byte local limit");
	});

	it("rejects a regular-file replacement between pathname validation and open", () => {
		const path = fixturePath();
		const original = `${path}.original`;
		const replacement = `${path}.replacement`;
		writeFileSync(path, "original", "utf8");
		writeFileSync(replacement, "replaced", "utf8");

		expect(() => readConfinedFileBytes(input(path), {
			afterPathValidated: () => {
				renameSync(path, original);
				renameSync(replacement, path);
			},
		})).toThrow("changed while it was being read");
	});

	it("rejects a final-component symlink swap after descriptor validation", () => {
		const path = fixturePath();
		const original = `${path}.original`;
		const other = `${path}.other`;
		writeFileSync(path, "original", "utf8");
		writeFileSync(other, "foreign", "utf8");

		expect(() => readConfinedFileBytes(input(path), {
			afterDescriptorValidated: () => {
				renameSync(path, original);
				symlinkSync(other, path);
			},
		})).toThrow("changed while it was being read");
	});

	it("rejects inode size drift after descriptor validation", () => {
		const path = fixturePath();
		writeFileSync(path, "original", "utf8");

		expect(() => readConfinedFileBytes(input(path), {
			afterDescriptorValidated: () => appendFileSync(path, "-changed", "utf8"),
		})).toThrow("changed while it was being read");
	});

	it("rechecks confinement when an intermediate directory symlink is swapped", () => {
		const path = fixturePath("inside/input.txt");
		const alias = join(root, "alias");
		outsideRoot = mkdtempSync(join(tmpdir(), "interlinked-v3-local-read-outside-"));
		writeFileSync(path, "inside", "utf8");
		writeFileSync(join(outsideRoot, "input.txt"), "outside", "utf8");
		symlinkSync(join(root, "inside"), alias);

		expect(() => readConfinedFileBytes(input(join(alias, "input.txt")), {
			afterDescriptorValidated: () => {
				unlinkSync(alias);
				symlinkSync(outsideRoot, alias);
			},
		})).toThrow("changed while it was being read");
	});

	it("rejects a request that only resolves inside the root by detouring through an outside directory", () => {
		const path = fixturePath();
		writeFileSync(path, "real target", "utf8");
		outsideRoot = mkdtempSync(join(tmpdir(), "interlinked-v3-local-read-outside-"));
		// alias -> outsideRoot, and outsideRoot/back -> root/real.txt (absolute).
		// The final component's realpath lands back inside root (passes the
		// resolvedTarget confinement check), but its PARENT resolves through
		// outsideRoot (fails the separate parent-directory confinement check).
		const realTarget = join(root, "real.txt");
		writeFileSync(realTarget, "real target", "utf8");
		const alias = join(root, "alias");
		symlinkSync(outsideRoot, alias);
		symlinkSync(realTarget, join(outsideRoot, "back"));

		expect(() => readConfinedFileBytes(input(join(alias, "back")))).toThrow(
			"must resolve inside the repository root",
		);
	});

	it("rejects a symlink race where the target becomes a symlink between path validation and open", () => {
		const path = fixturePath();
		const other = `${path}.other`;
		writeFileSync(path, "original", "utf8");
		writeFileSync(other, "foreign", "utf8");

		expect(() => readConfinedFileBytes(input(path), {
			afterPathValidated: () => {
				unlinkSync(path);
				symlinkSync(other, path);
			},
		})).toThrow("must not be a symbolic link");
	});

	it("rethrows a non-symlink open failure surfaced during the confinement race window", () => {
		const path = fixturePath();
		writeFileSync(path, "original", "utf8");

		expect(() => readConfinedFileBytes(input(path), {
			afterPathValidated: () => unlinkSync(path),
		})).toThrow(/ENOENT/);
	});

	it("rejects a negative byte limit before any read is attempted", () => {
		const path = fixturePath();
		writeFileSync(path, "data", "utf8");

		expect(() => readConfinedFileBytes({ root, path, maxBytes: -1, label: "protocol-v3 test input" })).toThrow(
			"invalid local byte limit",
		);
	});

	it("rejects a concurrent write that grows the file past the cap during the read loop", () => {
		const path = fixturePath();
		writeFileSync(path, "AAAAA", "utf8"); // exactly at the 5-byte cap below

		expect(() => readConfinedFileBytes({ root, path, maxBytes: 5, label: "protocol-v3 test input" }, {
			afterDescriptorValidated: () => appendFileSync(path, "BBB", "utf8"),
		})).toThrow("5-byte local limit");
	});

	it("rejects when the tracked directory itself is renamed away mid-read", () => {
		const path = fixturePath("sub/input.txt");
		const subDir = join(root, "sub");
		const movedDir = join(root, "sub-moved");
		writeFileSync(path, "original", "utf8");

		expect(() => readConfinedFileBytes(input(path), {
			afterDescriptorValidated: () => renameSync(subDir, movedDir),
		})).toThrow("changed while it was being read");

		// Restore so afterEach's recursive rmSync(root) can traverse it.
		if (existsSync(movedDir)) renameSync(movedDir, subDir);
	});

	it("rejects when an intermediate symlink is removed after descriptor validation, before the requested path is rechecked", () => {
		const path = fixturePath("inside/input.txt");
		const alias = join(root, "alias");
		writeFileSync(path, "inside", "utf8");
		symlinkSync(join(root, "inside"), alias);

		expect(() => readConfinedFileBytes(input(join(alias, "input.txt")), {
			afterDescriptorValidated: () => unlinkSync(alias),
		})).toThrow("changed while it was being read");
	});

	it("rejects a short read whose byte count no longer matches the validated descriptor size", () => {
		const path = fixturePath();
		writeFileSync(path, "12345", "utf8"); // 5 bytes

		expect(() => readConfinedFileBytes(input(path), {
			readBytes: () => Buffer.from("1234"), // one byte short of the validated size
		})).toThrow("changed while it was being read");
	});

	it("assertStableRead: rejects when the resolved requested path's identity no longer matches the validated descriptor", () => {
		const path = fixturePath();
		writeFileSync(path, "tracked", "utf8");
		const decoyPath = `${path}.decoy`;
		writeFileSync(decoyPath, "a completely different file", "utf8");

		const before = lstatSync(path, { bigint: true });
		const resolvedDecoy = realpathSync(decoyPath);
		const candidate = {
			realRoot: realpathSync(root),
			requested: decoyPath,
			resolvedTarget: resolvedDecoy,
			path,
			initial: before,
		};

		expect(() =>
			assertStableRead({ candidate, label: "protocol-v3 test input", before, after: before }),
		).toThrow("changed while it was being read");
	});

	it("assertStableRead: rejects when the tracked path's own file identity differs from the validated descriptor", () => {
		const path = fixturePath();
		writeFileSync(path, "tracked", "utf8");
		const otherPath = `${path}.other`;
		writeFileSync(otherPath, "a completely different file", "utf8");

		const before = lstatSync(path, { bigint: true });
		const candidate = {
			realRoot: realpathSync(root),
			requested: path,
			// Must be the fully-resolved form: assertRequestedPathStable
			// freshly re-resolves `requested` and compares the STRING against
			// resolvedTarget, so an unresolved `path` (which differs from its
			// own realpath on a host where the tmp root sits behind a
			// symlink, e.g. macOS /var -> /private/var) trips that unrelated
			// string-mismatch check first and masks the identity check this
			// case targets.
			resolvedTarget: realpathSync(path),
			path: otherPath,
			initial: before,
		};

		expect(() =>
			assertStableRead({ candidate, label: "protocol-v3 test input", before, after: before }),
		).toThrow("changed while it was being read");
	});

	it("rejects when the tracked file's parent directory is swapped for a fresh one holding a same-name decoy", () => {
		// Reachability evidence, not a substitute for the case above: this
		// swap trips assertStableRead's currentPathStatus check via the real
		// public entry point, proving the check is exercised by a genuine
		// attack shape. It does NOT discriminate that check in isolation —
		// with no hook seam between the two internal lstat calls, the exact
		// same swap is also caught by assertRequestedPathStable's own
		// identity check one statement later, so a mutant that deletes only
		// the first check still throws here (empirically verified).
		const path = fixturePath("sub/input.txt");
		const subDir = join(root, "sub");
		const movedDir = join(root, "sub-moved");
		writeFileSync(path, "original", "utf8");

		expect(() => readConfinedFileBytes(input(path), {
			afterDescriptorValidated: () => {
				// Move the tracked file's directory aside (the open descriptor
				// keeps reading the same inode) and put a same-basename decoy in
				// a freshly created directory at the original location. The
				// tracked inode's own dev/ino/mode/nlink/size/mtime/ctime never
				// change, so descriptorUnchanged still passes; only a lookup by
				// pathname (candidate.path) finds the decoy instead.
				renameSync(subDir, movedDir);
				mkdirSync(subDir);
				writeFileSync(join(subDir, "input.txt"), "decoy", "utf8");
			},
		})).toThrow("changed while it was being read");

		// Restore so afterEach's recursive rmSync(root) can traverse it.
		rmSync(subDir, { recursive: true, force: true });
		renameSync(movedDir, subDir);
	});
});
