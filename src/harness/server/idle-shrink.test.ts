import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTestIndex } from "../__tests__/fixtures/trigram.js";

const { clearDiagnosticCacheMock, clearManifestCacheMock, clearTscOverlayCacheMock } = vi.hoisted(
	() => ({
		clearDiagnosticCacheMock: vi.fn(),
		clearManifestCacheMock: vi.fn(),
		clearTscOverlayCacheMock: vi.fn(),
	}),
);

vi.mock("../mutation/manifest.js", () => ({
	clearManifestCache: clearManifestCacheMock,
}));
vi.mock("../check-engine/tool-runners/tsc-overlay.js", () => ({
	clearTscOverlayCache: clearTscOverlayCacheMock,
}));
vi.mock("../check-engine/index.js", () => ({
	clearCheckEngineDiagnosticCache: clearDiagnosticCacheMock,
}));

import { makeShrinkIdleMemory } from "./idle-shrink.js";

describe("makeShrinkIdleMemory", () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
	});

	// P1 (must fire): clears every reconstructible PostTool cache, including the
	// file-diagnostic map that otherwise grows with every visited file.
	it("P1: clears diagnostic, manifest, tsc, and trigram caches", () => {
		const trigramIndex = buildTestIndex({});
		const clearDirty = vi.spyOn(trigramIndex, "clearDirty");
		const shrink = makeShrinkIdleMemory(() => trigramIndex);

		shrink();

		expect(clearManifestCacheMock).toHaveBeenCalledTimes(1);
		expect(clearDiagnosticCacheMock).toHaveBeenCalledTimes(1);
		expect(clearTscOverlayCacheMock).toHaveBeenCalledTimes(1);
		expect(clearDirty).toHaveBeenCalledTimes(1);
	});

	// P2 (must fire): a null trigram index (not yet loaded) must not throw —
	// the other two caches still get cleared.
	it("P2: tolerates a null trigram index without throwing", () => {
		const shrink = makeShrinkIdleMemory(() => null);

		expect(() => shrink()).not.toThrow();
		expect(clearManifestCacheMock).toHaveBeenCalledTimes(1);
		expect(clearTscOverlayCacheMock).toHaveBeenCalledTimes(1);
	});

	// P3 (must fire): when --expose-gc's global gc is present, it is invoked.
	it("P3: invokes globalThis.gc when present", () => {
		const gcMock = vi.fn();
		vi.stubGlobal("gc", gcMock);
		const shrink = makeShrinkIdleMemory(() => null);

		shrink();

		expect(gcMock).toHaveBeenCalledTimes(1);
	});

	// N1 (must NOT throw/fire gc): without --expose-gc, globalThis.gc is
	// undefined — the optional-chained call must be a silent no-op.
	it("N1: does not throw when globalThis.gc is absent", () => {
		vi.stubGlobal("gc", undefined);
		const shrink = makeShrinkIdleMemory(() => null);
		expect(() => shrink()).not.toThrow();
	});
});
