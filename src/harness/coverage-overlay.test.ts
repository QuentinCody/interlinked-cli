import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoverageOverlay, sweepStaleOverlays } from "./coverage-overlay.js";

let root: string;

beforeEach(() => {
	// realpathSync so the root matches the symlink-resolved overlayRoot the
	// factory returns (macOS tmpdir is /var → /private/var); the production
	// caller likewise passes a resolved cwd.
	root = realpathSync(mkdtempSync(join(tmpdir(), "interlinked-cov-overlay-")));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
	writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(root, "src", "a.test.ts"), "// test\n");
	// node_modules should be linked, not copied.
	mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
	writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("createCoverageOverlay", () => {
	it("roots the overlay UNDER projectRoot (not os.tmpdir)", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		expect(relative(root, overlay.overlayRoot).startsWith("..")).toBe(false);
		expect(overlay.overlayRoot.startsWith(root)).toBe(true);
		overlay.cleanup();
	});

	it("writes the proposed content for the edited file into the overlay", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		const overlaidFile = join(overlay.overlayRoot, "src", "a.ts");
		expect(readFileSync(overlaidFile, "utf-8")).toBe("export const a = 2;\n");
		overlay.cleanup();
	});

	it("mirrors sibling source + test files so the suite sees the whole project", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		expect(existsSync(join(overlay.overlayRoot, "src", "a.test.ts"))).toBe(true);
		expect(existsSync(join(overlay.overlayRoot, "package.json"))).toBe(true);
		overlay.cleanup();
	});

	it("links node_modules rather than deep-copying it", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		const nm = join(overlay.overlayRoot, "node_modules");
		expect(existsSync(nm)).toBe(true);
		// A symlink keeps the mirror cheap; assert it's a link, not a real dir copy.
		expect(lstatSync(nm).isSymbolicLink()).toBe(true);
		overlay.cleanup();
	});

	it("supports a brand-new file not yet on disk (Write of a new module)", () => {
		const overlay = createCoverageOverlay(root, "src/brand-new.ts", "export const z = 9;\n");
		const overlaidFile = join(overlay.overlayRoot, "src", "brand-new.ts");
		expect(readFileSync(overlaidFile, "utf-8")).toBe("export const z = 9;\n");
		overlay.cleanup();
	});

	it("cleanup removes the overlay tree", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		const overlayRoot = overlay.overlayRoot;
		expect(existsSync(overlayRoot)).toBe(true);
		overlay.cleanup();
		expect(existsSync(overlayRoot)).toBe(false);
	});

	it("does not recursively copy a previous overlay dir into the new one", () => {
		const first = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		const second = createCoverageOverlay(root, "src/a.ts", "export const a = 3;\n");
		// The second overlay must not contain the first overlay nested inside it.
		const firstName = relative(dirname(first.overlayRoot), first.overlayRoot);
		expect(existsSync(join(second.overlayRoot, ".interlinked", firstName))).toBe(false);
		first.cleanup();
		second.cleanup();
	});

	it("honors a delete marker for the PRIMARY path (delete-only plan): the file ends ABSENT", () => {
		// A delete-only plan passes the deletion as the primary (content "") plus
		// its own delete marker in extraFiles — the write-then-remove must leave
		// the file absent, not resurrected as an empty module (finding 2026-06).
		const overlay = createCoverageOverlay(root, "src/a.ts", "", [
			{ relPath: "src/a.ts", content: "", delete: true },
		]);
		expect(existsSync(join(overlay.overlayRoot, "src", "a.ts"))).toBe(false);
		overlay.cleanup();
	});

	it("still skips a NON-delete duplicate of the primary (the primary content wins)", () => {
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 7;\n", [
			{ relPath: "src/a.ts", content: "export const a = 999;\n" },
		]);
		expect(readFileSync(join(overlay.overlayRoot, "src", "a.ts"), "utf-8")).toBe(
			"export const a = 7;\n",
		);
		overlay.cleanup();
	});

	it("materializes a non-delete sibling extraFiles entry alongside the primary edit", () => {
		// The primary path's own extraFiles entry is a duplicate skip (case above);
		// a DIFFERENT sibling path (e.g. a companion test co-created in the same
		// atomic patch) must actually be written into the overlay.
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n", [
			{ relPath: "src/a.newcompanion.test.ts", content: "// sibling companion\n" },
		]);
		expect(readFileSync(join(overlay.overlayRoot, "src", "a.newcompanion.test.ts"), "utf-8")).toBe(
			"// sibling companion\n",
		);
		overlay.cleanup();
	});

	it("degrades to an empty mirror (not a crash) when projectRoot becomes unreadable mid-mirror", () => {
		// Pre-create the `.interlinked` dir createCoverageOverlay's own mkdirSync
		// writes into, so that call stays a no-op once projectRoot's OWN read
		// permission is revoked below (mkdir only needs traverse/execute on an
		// already-existing parent, not read — readdir needs read).
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		chmodSync(root, 0o300); // write+execute, no read: readdirSync(root) now fails
		try {
			const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 9;\n");
			// mirrorProjectInto's readdirSync threw and was caught (an empty
			// mirror, not a thrown error escaping createCoverageOverlay) — the
			// edited file is still written, since writeEditedFile never depends
			// on the mirror having run.
			expect(readFileSync(overlay.editedFileInOverlay, "utf-8")).toBe("export const a = 9;\n");
			overlay.cleanup();
		} finally {
			chmodSync(root, 0o700);
		}
	});
});

// The mirror used to cpSync EVERY top-level entry except `.git`/`.interlinked`/
// `node_modules` — on this repo 489.7 MB / 6440 files / ~2.3s per edit, which is
// why `per_edit_coverage` was disabled locally (plan 15 §9, plan 16 build item 5).
// Pruning generated output + diverting nested `node_modules` to symlinks brought
// that to 113.3 MB / 2891 files / ~0.5s. These cases pin BOTH directions: the
// generated trees must not be mirrored, and real source must still be.
describe("mirror skip policy — positive (must be pruned)", () => {
	/** Plant a directory with one marker file and return its relative path. */
	function plantDir(relDir: string): string {
		mkdirSync(join(root, relDir), { recursive: true });
		writeFileSync(join(root, relDir, "marker.txt"), "generated\n");
		return relDir;
	}

	function mirrored(overlayRoot: string, relDir: string): boolean {
		return existsSync(join(overlayRoot, relDir, "marker.txt"));
	}

	it("P1: does not mirror top-level build output (dist, build, out, target)", () => {
		for (const d of ["dist", "build", "out", "target"]) plantDir(d);
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		for (const d of ["dist", "build", "out", "target"]) {
			expect(mirrored(overlay.overlayRoot, d)).toBe(false);
		}
		overlay.cleanup();
	});

	it("P2: does not mirror top-level report output (coverage, reports)", () => {
		for (const d of ["coverage", "reports"]) plantDir(d);
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		for (const d of ["coverage", "reports"]) {
			expect(mirrored(overlay.overlayRoot, d)).toBe(false);
		}
		overlay.cleanup();
	});

	it("P3: does not mirror top-level tool caches (.wrangler, .stryker-tmp, .next, .turbo)", () => {
		const dirs = [".wrangler", ".stryker-tmp", ".next", ".turbo"];
		for (const d of dirs) plantDir(d);
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		for (const d of dirs) expect(mirrored(overlay.overlayRoot, d)).toBe(false);
		overlay.cleanup();
	});

	it("P4: prunes tool caches NESTED inside a mirrored dir (landing/.wrangler)", () => {
		plantDir(join("landing", ".wrangler"));
		writeFileSync(join(root, "landing", "index.html"), "<html></html>\n");
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		expect(mirrored(overlay.overlayRoot, join("landing", ".wrangler"))).toBe(false);
		// …while the dir that CONTAINED it is still mirrored.
		expect(existsSync(join(overlay.overlayRoot, "landing", "index.html"))).toBe(true);
		overlay.cleanup();
	});

	it("P5: prunes nested __pycache__ / .pytest_cache anywhere in the tree", () => {
		plantDir(join("src", "py", "__pycache__"));
		plantDir(join("src", "py", ".pytest_cache"));
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		expect(mirrored(overlay.overlayRoot, join("src", "py", "__pycache__"))).toBe(false);
		expect(mirrored(overlay.overlayRoot, join("src", "py", ".pytest_cache"))).toBe(false);
		overlay.cleanup();
	});

	it("P6: symlinks a NESTED node_modules instead of deep-copying it", () => {
		// A workspace package resolves deps through its own node_modules; the copy
		// of one such tree was 205 MB of the 490 MB mirror on this repo.
		mkdirSync(join(root, "pkg", "node_modules", "dep"), { recursive: true });
		writeFileSync(join(root, "pkg", "node_modules", "dep", "index.js"), "module.exports=2;\n");
		writeFileSync(join(root, "pkg", "package.json"), JSON.stringify({ name: "pkg" }));
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		const nested = join(overlay.overlayRoot, "pkg", "node_modules");
		expect(lstatSync(nested).isSymbolicLink()).toBe(true);
		// The link must resolve to the REAL nested tree, not the root one.
		expect(realpathSync(nested)).toBe(realpathSync(join(root, "pkg", "node_modules")));
		// …and the package's own files still come through as real copies.
		expect(existsSync(join(overlay.overlayRoot, "pkg", "package.json"))).toBe(true);
		overlay.cleanup();
	});
});

describe("mirror skip policy — negative (must still be mirrored)", () => {
	function plantFile(relPath: string, content: string): void {
		mkdirSync(join(root, dirname(relPath)), { recursive: true });
		writeFileSync(join(root, relPath), content);
	}

	it("N1: mirrors ordinary source and doc trees", () => {
		plantFile(join("docs", "design", "notes.md"), "# notes\n");
		plantFile(join("scripts", "gen.mjs"), "export {};\n");
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		expect(existsSync(join(overlay.overlayRoot, "docs", "design", "notes.md"))).toBe(true);
		expect(existsSync(join(overlay.overlayRoot, "scripts", "gen.mjs"))).toBe(true);
		expect(existsSync(join(overlay.overlayRoot, "src", "a.test.ts"))).toBe(true);
		overlay.cleanup();
	});

	it("N2: mirrors NESTED dirs whose names are only root-level build conventions", () => {
		// `src/commands/build/` and `src/out/` are real source in plenty of repos —
		// pruning them would make the overlay's suite fail to import, which the gate
		// reads as a failing suite (a silent false block). Root-only is deliberate.
		plantFile(join("src", "commands", "build", "index.ts"), "export const b = 1;\n");
		plantFile(join("src", "out", "writer.ts"), "export const w = 1;\n");
		plantFile(join("src", "coverage", "model.ts"), "export const c = 1;\n");
		plantFile(join("src", "target", "t.ts"), "export const t = 1;\n");
		plantFile(join("src", "reports", "r.ts"), "export const r = 1;\n");
		plantFile(join("src", "dist", "d.ts"), "export const d = 1;\n");
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		for (const rel of [
			join("src", "commands", "build", "index.ts"),
			join("src", "out", "writer.ts"),
			join("src", "coverage", "model.ts"),
			join("src", "target", "t.ts"),
			join("src", "reports", "r.ts"),
			join("src", "dist", "d.ts"),
		]) {
			expect(existsSync(join(overlay.overlayRoot, rel))).toBe(true);
		}
		overlay.cleanup();
	});

	it("N3: still writes the proposed content when the prune filter is active", () => {
		mkdirSync(join(root, "dist"), { recursive: true });
		writeFileSync(join(root, "dist", "bundle.js"), "//generated\n");
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 42;\n");
		expect(readFileSync(join(overlay.overlayRoot, "src", "a.ts"), "utf-8")).toBe(
			"export const a = 42;\n",
		);
		overlay.cleanup();
	});
});

describe("sweepStaleOverlays — leaked-tree reaping (finding 2026-06-11: 7 leaked trees ≈ 24 GB)", () => {
	const HOUR_MS = 60 * 60 * 1000;

	/** Make a fake overlay dir under .interlinked with a controlled age. */
	function plantOverlay(name: string, ageMs: number): string {
		const parent = join(root, ".interlinked");
		const dir = join(parent, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "marker.txt"), "leaked");
		const t = new Date(Date.now() - ageMs);
		utimesSync(dir, t, t);
		return dir;
	}

	it("removes overlay-prefixed siblings older than the max age", () => {
		const stale = plantOverlay(".cov-overlay-stale1", 2 * HOUR_MS);
		sweepStaleOverlays(join(root, ".interlinked"));
		expect(existsSync(stale)).toBe(false);
	});

	it("keeps overlay-prefixed siblings younger than the max age (could be live)", () => {
		const fresh = plantOverlay(".cov-overlay-fresh", 5 * 60 * 1000);
		sweepStaleOverlays(join(root, ".interlinked"));
		expect(existsSync(fresh)).toBe(true);
	});

	it("never touches non-overlay entries, however old", () => {
		const parent = join(root, ".interlinked");
		mkdirSync(parent, { recursive: true });
		const precious = join(parent, "activity.jsonl");
		writeFileSync(precious, "data\n");
		const old = new Date(Date.now() - 30 * 24 * HOUR_MS);
		utimesSync(precious, old, old);
		sweepStaleOverlays(parent);
		expect(existsSync(precious)).toBe(true);
	});

	it("is a no-op when the parent directory does not exist", () => {
		expect(() => sweepStaleOverlays(join(root, "no-such-dir"))).not.toThrow();
	});

	it("createCoverageOverlay reaps stale siblings as a side effect (self-healing)", () => {
		const stale = plantOverlay(".cov-overlay-deadbeef", 2 * HOUR_MS);
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(overlay.overlayRoot)).toBe(true);
		overlay.cleanup();
	});

	it("createCoverageOverlay leaves fresh siblings alone (a parallel gate may own them)", () => {
		const fresh = plantOverlay(".cov-overlay-parallel", 60 * 1000);
		const overlay = createCoverageOverlay(root, "src/a.ts", "export const a = 2;\n");
		expect(existsSync(fresh)).toBe(true);
		overlay.cleanup();
		rmSync(fresh, { recursive: true, force: true });
	});
});
