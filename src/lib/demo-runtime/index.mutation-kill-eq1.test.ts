import { describe, expect, it } from "vitest";
import { __resetDemoRegistry, mountDemoBanner } from "./index.js";

/**
 * Adversarial pass-1 equivalence-falsification for
 * scratch/fleet-r3/equiv-briefs/src_lib_demo-runtime_index.ts.json.
 *
 * Minimal fake DOM element whose `style.display` setter records every
 * assignment (in order) into `writes`. This is strictly narrower than the
 * suite's shared `installFakeDocument` helper in index.test.ts — that fake
 * uses a plain `{ display: string }` object, which only lets a test observe
 * the FINAL value of `display`, not the sequence of writes leading to it.
 * The mutant this file targets is only observable through that sequence.
 */
interface SpyElement {
	dataset: Record<string, string>;
	style: { cssText: string; display: string };
	textContent: string;
	parentNode: SpyElement | null;
	children: SpyElement[];
	setAttribute: (name: string, value: string) => void;
	appendChild: (child: SpyElement) => void;
	removeChild: (child: SpyElement) => void;
}

function makeSpyElement(writes: string[]): SpyElement {
	let displayValue = "";
	const style = {
		cssText: "",
		get display() {
			return displayValue;
		},
		set display(v: string) {
			displayValue = v;
			writes.push(v);
		},
	};
	const el: SpyElement = {
		dataset: {},
		// SAFETY: `style` implements exactly the `{cssText, display}` surface
		// mountDemoBanner touches (a getter/setter pair standing in for the
		// real CSSStyleDeclaration accessor); the cast bridges that shape to
		// the plain-object type SpyElement declares for it.
		style: style,
		textContent: "",
		parentNode: null,
		children: [],
		setAttribute() {
			/* no-op: not exercised by this test */
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

function installSpyDocument(writes: string[]): { restore: () => void } {
	const body = makeSpyElement([]);
	const fakeDoc = { body, createElement: () => makeSpyElement(writes) };
	const previous: unknown = Reflect.get(globalThis, "document");
	Reflect.set(globalThis, "document", fakeDoc);
	return {
		restore: () => {
			Reflect.set(globalThis, "document", previous);
		},
	};
}

describe("mountDemoBanner — initial style.display write (mutation-directed)", () => {
	// test-contract: public-api — mountDemoBanner (src/lib/demo-runtime/index.ts)
	// is documented as creating the banner element hidden ("Safe to call in
	// non-DOM environments") before subscribeToDemoState's synchronous
	// initial callback re-renders it; mutant f3ac120525079970 replaces the
	// "none" init literal with "". The brief claims this is dead because the
	// synchronous listener always overwrites the FINAL value — true — but
	// the WRITE SEQUENCE still differs: original code sets display to
	// "none" twice in a row (imperative init, then the listener's
	// empty-registry branch); the mutant sets "" then "none". A spied
	// `display` setter records that sequence deterministically (no timing
	// race, no real event loop needed), which is exactly the first-paint
	// flash a real browser would render between element insertion and the
	// listener's re-render.
	it("writes 'none' as the very first style.display assignment", () => {
		__resetDemoRegistry();
		const writes: string[] = [];
		const { restore } = installSpyDocument(writes);
		const unmount = mountDemoBanner();
		expect(writes[0]).toBe("none");
		restore();
		unmount();
		__resetDemoRegistry();
	});

	// test-contract: public-api — same call as above; pins the full
	// two-write sequence (not just the first element) so a mutant that
	// swaps which write is dropped/duplicated is also caught.
	it("writes the full two-write sequence ['none', 'none'] for an empty registry", () => {
		__resetDemoRegistry();
		const writes: string[] = [];
		const { restore } = installSpyDocument(writes);
		const unmount = mountDemoBanner();
		expect(writes).toEqual(["none", "none"]);
		restore();
		unmount();
		__resetDemoRegistry();
	});
});
