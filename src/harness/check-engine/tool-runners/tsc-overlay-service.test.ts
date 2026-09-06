// Smoke coverage for the extracted LS-construction module. Full behavioral
// coverage (sibling overlays, cross-file resolution, missing-typescript
// degrade) lives in tsc-overlay.test.ts / tsc-overlay.no-typescript.test.ts,
// which exercise the same code through the dispatcher in "in-process" mode.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildLanguageServiceHost,
	clearOverlayServiceCache,
	diagnosticSeverity,
	OVERLAY_EXT,
	runOverlayCheckInProcess,
} from "./tsc-overlay-service.js";

const created: string[] = [];

function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "tsc-overlay-service-"));
	created.push(dir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				module: "nodenext",
				moduleResolution: "nodenext",
				strict: true,
				noEmit: true,
				skipLibCheck: true,
			},
			include: ["*.ts"],
		}),
	);
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

afterEach(() => {
	for (const dir of created.splice(0)) {
		clearOverlayServiceCache(dir);
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("tsc-overlay-service", () => {
	// kind: public-api — positive (must fire)
	it("P1: OVERLAY_EXT matches .ts/.tsx/.mts/.cts", () => {
		expect(OVERLAY_EXT.test("a.ts")).toBe(true);
		expect(OVERLAY_EXT.test("a.tsx")).toBe(true);
		expect(OVERLAY_EXT.test("a.mts")).toBe(true);
		expect(OVERLAY_EXT.test("a.cts")).toBe(true);
	});

	// kind: public-api — negative (must not fire)
	it("N1: OVERLAY_EXT rejects non-TS extensions", () => {
		expect(OVERLAY_EXT.test("a.js")).toBe(false);
		expect(OVERLAY_EXT.test("a.md")).toBe(false);
	});

	// kind: public-api — positive (must fire)
	it("P2: runOverlayCheckInProcess finds a real type error in overlaid content", () => {
		const dir = project({ "a.ts": "export const x: number = 1;\n" });
		const out = runOverlayCheckInProcess({
			projectRoot: dir,
			filePath: join(dir, "a.ts"),
			content: 'export const x: number = "not a number";\n',
		});
		expect(out.some((r) => r.ruleId === "TS2322")).toBe(true);
	});

	// kind: public-api — negative (must not fire)
	it("N2: runOverlayCheckInProcess returns [] for non-TS-overlayable files", () => {
		const dir = project({ "a.ts": "export const x = 1;\n" });
		const out = runOverlayCheckInProcess({
			projectRoot: dir,
			filePath: join(dir, "a.md"),
			content: "# hi\n",
		});
		expect(out).toEqual([]);
	});

	it("clearOverlayServiceCache(projectRoot) and clearOverlayServiceCache() both run without throwing", () => {
		const dir = project({ "a.ts": "export const x = 1;\n" });
		runOverlayCheckInProcess({ projectRoot: dir, filePath: join(dir, "a.ts"), content: "export const x = 1;\n" });
		expect(() => clearOverlayServiceCache(dir)).not.toThrow();
		expect(() => clearOverlayServiceCache()).not.toThrow();
	});
});

// ===========================================================================
// diagnosticSeverity — pure category mapper. buildOverlayResults only ever
// exercises the Error branch through a real overlaid type error (see P2
// above); these fixtures drive the Warning and "neither" branches directly,
// since no genuine tsc diagnostic in this project's config is emitted as a
// Warning or Suggestion.
// ===========================================================================

describe("diagnosticSeverity", () => {
	function fakeDiagnostic(category: import("typescript").DiagnosticCategory): import("typescript").Diagnostic {
		// SAFETY: diagnosticSeverity reads only `.category` — a minimal fixture
		// with the rest of Diagnostic's fields omitted is sound for this test.
		return { category } as unknown as import("typescript").Diagnostic;
	}

	// kind: category-mapping — positive (must fire)
	it("P3: maps a Warning-category diagnostic to 'warning'", () => {
		expect(diagnosticSeverity(ts, fakeDiagnostic(ts.DiagnosticCategory.Warning))).toBe("warning");
	});

	// kind: category-mapping — negative (must not fire)
	it("N3: maps a Suggestion-category diagnostic (neither Error nor Warning) to null", () => {
		expect(diagnosticSeverity(ts, fakeDiagnostic(ts.DiagnosticCategory.Suggestion))).toBeNull();
	});
});

// ===========================================================================
// buildLanguageServiceHost — the assembled LanguageServiceHost object.
// getOrCreateService only ever hands this to `ts.createLanguageService`,
// which invokes `.readDirectory` itself only via completions or project
// references (neither of which runOverlayCheckInProcess exercises) — calling
// the built host's own `readDirectory` hook directly is the only way to prove
// that specific wiring (including its private `hostReadDirectory` delegate,
// which has no importer outside this module) without depending on that
// unrelated internal TS path.
// ===========================================================================

describe("buildLanguageServiceHost", () => {
	// kind: host-wiring — positive (must fire)
	it("P5: the built host's readDirectory hook forwards the include glob to the real directory listing", () => {
		const dir = project({ "a.ts": "export const x = 1;\n" });
		writeFileSync(join(dir, "notes.txt"), "not typescript\n");
		const ctx = {
			ts,
			service: null,
			tsconfigDir: dir,
			overlay: null,
			siblings: new Map<string, string>(),
			versions: new Map<string, number>(),
			mtimes: new Map<string, number>(),
		};
		const host = buildLanguageServiceHost(ctx, ts, dir, ["a.ts"], {});

		// No `extensions` filter passed — an empty result, or notes.txt present,
		// can only happen if the `include` glob arg was dropped/ignored rather
		// than forwarded (verified: ts.sys.readDirectory(dir, undefined,
		// undefined, undefined) returns BOTH files; only adding `include` back
		// excludes notes.txt).
		const files = host.readDirectory?.(dir, undefined, undefined, ["*.ts"]) ?? [];

		expect(files.some((f: string) => f.endsWith("a.ts"))).toBe(true);
		expect(files.some((f: string) => f.endsWith("notes.txt"))).toBe(false);
	});
});
