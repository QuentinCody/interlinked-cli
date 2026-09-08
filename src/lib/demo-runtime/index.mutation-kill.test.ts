// Mutation-kill companion for src/lib/demo-runtime/index.ts.
//
// index.test.ts already covers demoData's public dedupe/summary contract at
// a coarse grain (existence checks, .toContain, length counts). These cases
// tighten that to exact-value assertions (toBe/toEqual on full strings and
// shapes) and reach two surfaces the companion suite structurally cannot
// observe: setAttribute calls (its FakeElement.setAttribute is a documented
// no-op) and console.warn invocation (never spied there).

import { parseWire, wireArray, wireNumber, wireObject, wireString } from "../value-validation.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetDemoRegistry, demoData, demoStateSummary, mountDemoBanner } from "./index.js";

const isDemoEntry = wireObject<{ key: string; reason: string; registeredAt: number }>({
	key: wireString, reason: wireString, registeredAt: wireNumber,
});
function readGlobalEntries() {
	const value: unknown = Reflect.get(globalThis, "__INTERLINKED_DEMO__");
	return parseWire(value ?? [], wireArray(isDemoEntry), "demo registry entries");
}

/**
 * Recording DOM stand-in, distinct from index.test.ts's fake: that one's
 * setAttribute is a documented no-op ("role/aria-live are asserted
 * indirectly via behavior, not markup"), which is exactly why the
 * setAttribute-argument mutants below survived. This variant records every
 * call so those literals become directly assertable, and seeds a
 * non-empty textContent default so the "clear to exactly ''" mutant is
 * observable too.
 */
interface RecordingElement {
	tagName: string;
	dataset: Record<string, string>;
	attributes: Record<string, string>;
	style: { cssText: string; display: string };
	textContent: string;
	parentNode: RecordingElement | null;
	children: RecordingElement[];
	setAttribute: (name: string, value: string) => void;
	appendChild: (child: RecordingElement) => void;
	removeChild: (child: RecordingElement) => void;
}

function makeRecordingElement(tagName: string): RecordingElement {
	const el: RecordingElement = {
		tagName,
		dataset: {},
		attributes: {},
		style: { cssText: "", display: "" },
		textContent: "__preseeded__",
		parentNode: null,
		children: [],
		setAttribute(name, value) {
			el.attributes[name] = value;
		},
		appendChild(child) {
			child.parentNode = el;
			el.children.push(child);
		},
		removeChild(child) {
			el.children = el.children.filter((c) => c !== child);
			child.parentNode = null;
		},
	};
	return el;
}

function installRecordingDocument(bodyOverride: RecordingElement | null | undefined = makeRecordingElement("body")): {
	body: RecordingElement | null | undefined;
	restore: () => void;
} {
	const fakeDoc = { body: bodyOverride, createElement: (tag: string) => makeRecordingElement(tag) };
	const previous: unknown = Reflect.get(globalThis, "document");
	Reflect.set(globalThis, "document", fakeDoc);
	return {
		body: bodyOverride,
		restore: () => {
			Reflect.set(globalThis, "document", previous);
		},
	};
}

describe("announceOnce (internal, exercised only via demoData)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetDemoRegistry();
	});
	afterEach(() => __resetDemoRegistry());

	// test-contract: behavioral — a repeat demoData() call for the same key must not re-log or re-push (guards ANNOUNCED.has(key) against a forced-false mutant)
	it("does not re-announce on a repeat call for the same key", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		demoData("dupkey", 1, { reason: "r1" });
		demoData("dupkey", 2, { reason: "r1" });
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const list = readGlobalEntries();
		expect(list.length).toBe(1);
		warnSpy.mockRestore();
	});

	// test-contract: behavioral — console.warn is called exactly once with the exact formatted message on first announce
	it("calls console.warn with the exact demo-data message on first announce", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		demoData("revenue", 1, { reason: "API pending" });
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith('[demo-data] "revenue" is rendering fake/test data — API pending');
		warnSpy.mockRestore();
	});

	// test-contract: adversarial — console.warn not being a function must not crash demoData (guards typeof console.warn === "function")
	it("does not throw when console.warn is not a function", () => {
		const previousWarn = console.warn;
		// SAFETY: deliberately breaking console.warn to exercise the typeof guard; restored in finally.
		Reflect.set(console, "warn", "not-a-function");
		try {
			expect(() => demoData("notafn", 1)).not.toThrow();
		} finally {
			console.warn = previousWarn;
		}
	});

	// test-contract: adversarial — console itself being undefined must not crash demoData (guards typeof console !== "undefined" short-circuiting before typeof console.warn is read)
	it("does not throw when console itself is undefined", () => {
		const previousConsole = globalThis.console;
		// SAFETY: deliberately breaking the global console to exercise the typeof guard; restored in finally.
		Reflect.set(globalThis, "console", undefined);
		try {
			expect(() => demoData("noconsole", 1)).not.toThrow();
		} finally {
			globalThis.console = previousConsole;
		}
	});

	// test-contract: behavioral — the pushed __INTERLINKED_DEMO__ entry has the real key/reason/registeredAt shape, not an emptied object
	it("pushes a correctly-shaped entry onto globalThis.__INTERLINKED_DEMO__", () => {
		demoData("q1", 1, { reason: "r1" });
		const list = readGlobalEntries();
		expect(list.length).toBe(1);
		expect(list[0]?.key).toBe("q1");
		expect(list[0]?.reason).toBe("r1");
		expect(typeof list[0]?.registeredAt).toBe("number");
	});

	// test-contract: behavioral — sequential distinct-key announces accumulate in __INTERLINKED_DEMO__ instead of resetting it (guards the ?? [] fallback against a && [] mutant, which discards the list whenever it is already non-empty/truthy)
	it("accumulates entries across distinct keys instead of resetting the list", () => {
		demoData("first", 1);
		demoData("second", 2);
		const list = readGlobalEntries();
		expect(list.length).toBe(2);
		expect(list.map((e) => e.key)).toEqual(["first", "second"]);
	});

	// test-contract: behavioral — the ?? [] fallback starts a real empty array (not a poisoned placeholder) when __INTERLINKED_DEMO__ was never initialized at all. __resetDemoRegistry's beforeEach normally leaves the global as an already-real [] (which hides this site since ?? never triggers); deleting the key first forces the fallback to actually run.
	it("starts a real empty array (never a poisoned placeholder) when __INTERLINKED_DEMO__ is truly undefined, not just cleared", () => {
		Reflect.deleteProperty(globalThis, "__INTERLINKED_DEMO__");
		demoData("freshkey", 1, { reason: "r" });
		const list = readGlobalEntries();
		expect(list).toEqual([{ key: "freshkey", reason: "r", registeredAt: expect.any(Number) }]);
	});
});

describe("demoData — dedupe semantics", () => {
	beforeEach(() => __resetDemoRegistry());
	afterEach(() => __resetDemoRegistry());

	// test-contract: behavioral — default reason text is the exact literal when options.reason is omitted
	it("uses the exact default reason string when no reason is given", () => {
		demoData("nokreason", 1);
		expect(demoStateSummary().entries[0]?.reason).toBe("no reason provided");
	});

	// test-contract: behavioral — the FIRST call's reason wins on a repeat call for the same key (guards !existing against a forced-true always-overwrite mutant)
	it("keeps the first call's reason on a repeat call for the same key", () => {
		demoData("k", 1, { reason: "first" });
		demoData("k", 2, { reason: "second" });
		expect(demoStateSummary().entries[0]?.reason).toBe("first");
	});
});

describe("demoStateSummary — exact banner text", () => {
	beforeEach(() => __resetDemoRegistry());
	afterEach(() => __resetDemoRegistry());

	// test-contract: behavioral — empty registry produces the exact empty bannerText literal
	it("returns exactly an empty bannerText for an empty registry", () => {
		expect(demoStateSummary().bannerText).toBe("");
	});

	// test-contract: behavioral — singular grammar ("1 source", no "s") for exactly one entry
	it("uses singular grammar for exactly one entry", () => {
		demoData("solo", 1);
		expect(demoStateSummary().bannerText).toBe("DEMO DATA — 1 source not connected to live APIs. solo");
	});

	// test-contract: behavioral — plural grammar ("2 sources") and a ", " join separator for two entries
	it("uses plural grammar and a comma-space join for two entries", () => {
		demoData("alpha", 1);
		demoData("beta", 2);
		expect(demoStateSummary().bannerText).toBe(
			"DEMO DATA — 2 sources not connected to live APIs. alpha, beta",
		);
	});

	// test-contract: behavioral — a ticketed entry's label is exactly "key (ticket)"
	it("formats a ticketed entry's label as key (ticket)", () => {
		demoData("rev", 1, { ticket: "TICKET-1" });
		expect(demoStateSummary().bannerText).toBe(
			"DEMO DATA — 1 source not connected to live APIs. rev (TICKET-1)",
		);
	});
});

describe("__resetDemoRegistry — globalThis reset", () => {
	beforeEach(() => __resetDemoRegistry());
	afterEach(() => __resetDemoRegistry());

	// test-contract: behavioral — reset overwrites a polluted __INTERLINKED_DEMO__ with exactly a fresh empty array
	it("overwrites a polluted __INTERLINKED_DEMO__ with exactly an empty array", () => {
		Reflect.set(globalThis, "__INTERLINKED_DEMO__", [
			{ key: "stale", reason: "stale", registeredAt: 0 },
		]);
		__resetDemoRegistry();
		expect(Reflect.get(globalThis, "__INTERLINKED_DEMO__")).toEqual([]);
	});
});

describe("mountDemoBanner — exact DOM setup (recording fake)", () => {
	beforeEach(() => __resetDemoRegistry());
	afterEach(() => __resetDemoRegistry());

	const EXPECTED_BANNER_STYLE =
		"position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
		"padding:8px 16px;font:600 13px/1.4 system-ui,sans-serif;" +
		"color:#1a1a00;background:#ffe066;border-bottom:2px solid #d4a017;" +
		"text-align:center;letter-spacing:0.02em;";

	// test-contract: behavioral — every DOM-setup literal (tag, dataset flag, role/aria-live attributes, css text, initial display) is exactly the source's value
	it("creates a div with the exact tag, dataset flag, role/aria-live attributes, css text, and initial hidden display", () => {
		const { body, restore } = installRecordingDocument();
		try {
			mountDemoBanner();
			const banner = body?.children[0];
			expect(banner?.tagName).toBe("div");
			expect(banner?.dataset.interlinkedDemoBanner).toBe("true");
			expect(banner?.attributes.role).toBe("status");
			expect(banner?.attributes["aria-live"]).toBe("polite");
			expect(banner?.style.cssText).toBe(EXPECTED_BANNER_STYLE);
			expect(banner?.style.display).toBe("none");
		} finally {
			restore();
		}
	});

	// test-contract: behavioral — the immediate empty-registry subscribe callback clears textContent to exactly "" rather than leaving the element's pre-existing content
	it("clears the freshly-created element's textContent to exactly empty string via the immediate empty-registry callback", () => {
		const { body, restore } = installRecordingDocument();
		try {
			mountDemoBanner();
			const banner = body?.children[0];
			expect(banner?.textContent).toBe("");
		} finally {
			restore();
		}
	});

	// test-contract: adversarial — a null document.body must not crash mountDemoBanner (guards the !container escape hatch; document.body can be null between typeof document check passing and a body existing)
	it("does not throw and returns a no-op unmount when document.body is null", () => {
		const { restore } = installRecordingDocument(null);
		try {
			let unmount: (() => void) | undefined;
			expect(() => {
				unmount = mountDemoBanner();
			}).not.toThrow();
			expect(typeof unmount).toBe("function");
			expect(() => unmount?.()).not.toThrow();
		} finally {
			restore();
		}
	});

	// test-contract: adversarial — calling the returned unmount function a second time does not throw (guards el.parentNode truthiness on the second, already-detached call)
	it("is idempotent: calling the returned unmount function a second time does not throw", () => {
		const { restore } = installRecordingDocument();
		try {
			const unmount = mountDemoBanner();
			unmount();
			expect(() => unmount()).not.toThrow();
		} finally {
			restore();
		}
	});
});
