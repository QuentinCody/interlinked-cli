import { describe, expect, it } from "vitest";
import {
	proposedDirectoryExists,
	proposedFileContent,
	proposedFileExists,
	withoutProposedFiles,
	withProposedFiles,
} from "./proposed-files.js";

// Session review r3 (2026-09-05), finding 3: a batch that CREATES
// `widget.native.ts` and updates `widget.ts` to import it was refused as a
// self-import, because the resolver probed the old disk tree. The batch gate
// now publishes the whole proposed changeset as an ambient view for the
// duration of its synchronous evaluation; context-dependent checks consult the
// view before the disk. Outside a batch the view is empty and every question
// falls through to the filesystem (`undefined`).

describe("proposed-files view — positive (the view answers)", () => {
	it("P1: a file the batch writes exists, with the batch's bytes", () => {
		withProposedFiles(new Map([["/repo/widget.native.ts", "export const x = 1;\n"]]), () => {
			expect(proposedFileExists("/repo/widget.native.ts")).toBe(true);
			expect(proposedFileContent("/repo/widget.native.ts")).toBe("export const x = 1;\n");
		});
	});

	it("P2: a file the batch deletes (null) does not exist, and reads as deleted", () => {
		withProposedFiles(new Map([["/repo/gone.ts", null]]), () => {
			expect(proposedFileExists("/repo/gone.ts")).toBe(false);
			expect(proposedFileContent("/repo/gone.ts")).toBeNull();
		});
	});

	it("P3: a directory exists when the batch writes any file under it", () => {
		withProposedFiles(new Map([["/repo/new-dir/deep/file.ts", "x"]]), () => {
			expect(proposedDirectoryExists("/repo/new-dir")).toBe(true);
			expect(proposedDirectoryExists("/repo/new-dir/deep")).toBe(true);
			expect(proposedDirectoryExists("/repo/new-dir/deep/file.ts")).toBe(false);
		});
	});

	it("P4: the view is scoped — it is gone once the callback returns, and returns the callback's value", () => {
		const value = withProposedFiles(new Map([["/repo/a.ts", "x"]]), () => 42);
		expect(value).toBe(42);
		expect(proposedFileExists("/repo/a.ts")).toBeUndefined();
	});

	it("P5: nested views stack — the inner view wins for its paths and the outer view still answers the rest", () => {
		withProposedFiles(new Map([["/repo/a.ts", "outer"]]), () => {
			withProposedFiles(new Map([["/repo/b.ts", "inner"]]), () => {
				expect(proposedFileContent("/repo/b.ts")).toBe("inner");
				expect(proposedFileContent("/repo/a.ts")).toBe("outer");
			});
			expect(proposedFileExists("/repo/b.ts")).toBeUndefined();
		});
	});

	it("P6: paths compare after normalization — a relative spelling of a proposed path is the same file", () => {
		withProposedFiles(new Map([[`${process.cwd()}/src/x.ts`, "x"]]), () => {
			expect(proposedFileExists("src/x.ts")).toBe(true);
			expect(proposedFileExists("./src/../src/x.ts")).toBe(true);
		});
	});

	it("P8: withoutProposedFiles hides every active view — the disk baseline is judged as the disk (review r4, finding 2)", () => {
		withProposedFiles(new Map([["/repo/tsconfig.json", "{}"], ["/repo/gone.ts", null]]), () => {
			expect(proposedFileExists("/repo/tsconfig.json")).toBe(true);
			withoutProposedFiles(() => {
				expect(proposedFileExists("/repo/tsconfig.json")).toBeUndefined();
				expect(proposedFileContent("/repo/gone.ts")).toBeUndefined();
				expect(proposedDirectoryExists("/repo")).toBeUndefined();
			});
			// The suspension is scoped too: the view answers again afterwards.
			expect(proposedFileExists("/repo/tsconfig.json")).toBe(true);
		});
	});

	it("P7: the view is restored even when the callback throws", () => {
		expect(() =>
			withProposedFiles(new Map([["/repo/a.ts", "x"]]), () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(proposedFileExists("/repo/a.ts")).toBeUndefined();
	});
});

describe("proposed-files view — negative (falls through to the filesystem)", () => {
	it("N1: outside any batch every question is undefined — the caller asks the disk", () => {
		expect(proposedFileExists("/repo/anything.ts")).toBeUndefined();
		expect(proposedFileContent("/repo/anything.ts")).toBeUndefined();
		expect(proposedDirectoryExists("/repo")).toBeUndefined();
	});

	it("N2: inside a batch a path the batch never names is still undefined — the view never invents absence", () => {
		withProposedFiles(new Map([["/repo/a.ts", "x"]]), () => {
			expect(proposedFileExists("/repo/other.ts")).toBeUndefined();
			expect(proposedFileContent("/repo/other.ts")).toBeUndefined();
			expect(proposedDirectoryExists("/elsewhere")).toBeUndefined();
		});
	});
});
