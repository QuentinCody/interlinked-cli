import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../non-null.js";
import {
	__resetDemoRegistry,
	DemoBanner,
	demoData,
	demoStateSummary,
	mountDemoBanner,
	subscribeToDemoState,
	unmountDemoBanner,
} from "./index.js";

/**
 * Minimal DOM stand-in for the vanilla-DOM banner. Vitest runs this suite in
 * `environment: "node"` (see vitest.config.ts), so there is no real `document`
 * — mountDemoBanner/DemoBanner/unmountDemoBanner branch on `typeof document`
 * and are otherwise dead code under the existing tests. This fake implements
 * only the surface `mountDemoBanner` actually calls (createElement, body,
 * appendChild/removeChild, dataset/style/textContent/setAttribute), so it
 * exercises the real DOM-branch logic without pulling in jsdom.
 */
interface FakeElement {
	dataset: Record<string, string>;
	style: { cssText: string; display: string };
	textContent: string;
	parentNode: FakeElement | null;
	children: FakeElement[];
	setAttribute: (name: string, value: string) => void;
	appendChild: (child: FakeElement) => void;
	removeChild: (child: FakeElement) => void;
}

function makeFakeElement(): FakeElement {
	const el: FakeElement = {
		dataset: {},
		style: { cssText: "", display: "" },
		textContent: "",
		parentNode: null,
		children: [],
		setAttribute() {
			/* no-op: role/aria-live are asserted indirectly via behavior, not markup */
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

function installFakeDocument(): { body: FakeElement; restore: () => void } {
	const body = makeFakeElement();
	const fakeDoc = { body, createElement: () => makeFakeElement() };
	const previous: unknown = Reflect.get(globalThis, "document");
	Reflect.set(globalThis, "document", fakeDoc);
	return {
		body,
		restore: () => {
			Reflect.set(globalThis, "document", previous);
		},
	};
}

describe("demoData", () => {
	beforeEach(() => __resetDemoRegistry());
	afterEach(() => __resetDemoRegistry());

	it("returns the wrapped value unchanged", () => {
		const arr = [{ id: 1, name: "alice" }];
		expect(demoData("users", arr)).toBe(arr);
	});

	it("registers the key + reason in the runtime registry", () => {
		demoData("revenue", [{ x: 1 }], { reason: "API pending", ticket: "TICKET-9" });
		const summary = demoStateSummary();
		expect(summary.entries.length).toBe(1);
		expect(nonNull(summary.entries[0]).key).toBe("revenue");
		expect(nonNull(summary.entries[0]).reason).toBe("API pending");
		expect(nonNull(summary.entries[0]).ticket).toBe("TICKET-9");
	});

	it("dedupes by key", () => {
		demoData("users", []);
		demoData("users", [{ a: 1 }]);
		expect(demoStateSummary().entries.length).toBe(1);
	});

	it("supports multiple distinct keys", () => {
		demoData("users", []);
		demoData("orders", []);
		demoData("revenue", []);
		expect(demoStateSummary().entries.length).toBe(3);
	});

	it("exposes a non-empty banner-text helper when entries exist", () => {
		demoData("revenue", []);
		expect(demoStateSummary().bannerText).toContain("DEMO DATA");
		expect(demoStateSummary().bannerText).toContain("revenue");
	});

	it("returns an empty banner when nothing is wrapped", () => {
		expect(demoStateSummary().bannerText).toBe("");
	});
});

describe("mountDemoBanner / DemoBanner (vanilla DOM)", () => {
	beforeEach(() => __resetDemoRegistry());
	afterEach(() => __resetDemoRegistry());

	it("returns a no-op unmount when there is no document (Node)", () => {
		// In a non-DOM environment the banner mounts nothing and returns
		// a callable unmount that's safe to invoke.
		const unmount = mountDemoBanner();
		expect(unmount()).toBeUndefined();
	});

	it("DemoBanner is exported as the JSX-friendly alias of mountDemoBanner", () => {
		// The check warning instructs `<DemoBanner />` import; we ship a
		// JSX-shaped React-component compatible function so plain JSX
		// `<DemoBanner />` calls work in React/Preact codebases without
		// taking on a framework dependency in this package.
		const rendered = DemoBanner();
		unmountDemoBanner();
		expect(rendered).toBeNull();
	});
});

describe("subscribeToDemoState", () => {
	beforeEach(() => __resetDemoRegistry());
	afterEach(() => __resetDemoRegistry());

	it("calls the listener immediately with the current summary on subscribe", () => {
		demoData("revenue", []);
		const seen: string[][] = [];
		const unsubscribe = subscribeToDemoState((summary) => {
			seen.push(summary.entries.map((e) => e.key));
		});
		expect(seen).toEqual([["revenue"]]);
		unsubscribe();
	});

	it("notifies subscribed listeners on every subsequent demoData call", () => {
		const seen: number[] = [];
		const unsubscribe = subscribeToDemoState((summary) => {
			seen.push(summary.entries.length);
		});
		demoData("users", []);
		demoData("orders", []);
		// Initial subscribe call (0) + one notification per demoData call.
		expect(seen).toEqual([0, 1, 2]);
		unsubscribe();
	});

	it("stops notifying once unsubscribed", () => {
		const seen: number[] = [];
		const unsubscribe = subscribeToDemoState((summary) => {
			seen.push(summary.entries.length);
		});
		unsubscribe();
		demoData("users", []);
		// Only the initial subscribe call landed; the post-unsubscribe demoData
		// call produced no further notification.
		expect(seen).toEqual([0]);
	});

	it("a listener that throws during notifyListeners does not break demoData or other listeners", () => {
		// The initial subscribe-time call in subscribeToDemoState is unguarded
		// by design (it runs before the listener is registered); only the
		// notifyListeners fan-out on later demoData() calls is try/catch
		// wrapped. So the bad listener must stay quiet on its first call and
		// throw only from the second call onward to exercise that catch.
		let calls = 0;
		const unsubBad = subscribeToDemoState(() => {
			calls += 1;
			if (calls > 1) throw new Error("listener boom");
		});
		const seen: number[] = [];
		const unsubGood = subscribeToDemoState((summary) => {
			seen.push(summary.entries.length);
		});
		expect(() => demoData("users", [])).not.toThrow();
		expect(seen).toEqual([0, 1]);
		unsubBad();
		unsubGood();
	});
});

describe("mountDemoBanner — with a DOM present", () => {
	beforeEach(() => __resetDemoRegistry());
	afterEach(() => __resetDemoRegistry());

	it("appends a hidden banner element to document.body and shows it once demo data is registered", () => {
		const { body, restore } = installFakeDocument();
		try {
			const unmount = mountDemoBanner();
			expect(body.children).toHaveLength(1);
			const banner = nonNull(body.children[0]);
			expect(banner.style.display).toBe("none");

			demoData("revenue", [], { reason: "API pending" });
			expect(banner.style.display).toBe("");
			expect(banner.textContent).toContain("revenue");
			expect(banner.textContent).toContain("DEMO DATA");

			unmount();
			expect(body.children).toHaveLength(0);
			expect(banner.parentNode).toBeNull();
		} finally {
			restore();
		}
	});

	it("a second banner mounted after a reset starts hidden against the now-empty registry", () => {
		// __resetDemoRegistry() clears LISTENERS along with the registry, so an
		// already-mounted banner's subscription is wiped rather than notified —
		// there is no "goes back to hidden" transition to observe on it. What IS
		// observable: a banner mounted fresh AFTER a reset starts from the
		// correct (hidden) state instead of inheriting the previous registry.
		const { body, restore } = installFakeDocument();
		try {
			demoData("users", []);
			const firstUnmount = mountDemoBanner();
			expect(nonNull(body.children[0]).style.display).toBe("");
			firstUnmount();

			__resetDemoRegistry();
			const secondUnmount = mountDemoBanner();
			const banner = nonNull(body.children[0]);
			expect(banner.style.display).toBe("none");

			demoData("orders", []);
			expect(banner.style.display).toBe("");
			expect(banner.textContent).toContain("orders");

			secondUnmount();
		} finally {
			restore();
		}
	});

	it("mounts into a custom container when one is supplied", () => {
		const { restore } = installFakeDocument();
		try {
			const container = makeFakeElement();
			// SAFETY: container only needs the appendChild surface mountDemoBanner
			// calls; the fake implements it, the DOM lib type does not describe it.
			const unmount = mountDemoBanner({ container: container as unknown as HTMLElement });
			expect(container.children).toHaveLength(1);
			unmount();
			expect(container.children).toHaveLength(0);
		} finally {
			restore();
		}
	});

	it("sets and clears document.body.dataset.demo when a DOM is present", () => {
		const { body, restore } = installFakeDocument();
		try {
			expect(body.dataset.demo).toBeUndefined();
			demoData("revenue", []);
			expect(body.dataset.demo).toBe("true");

			__resetDemoRegistry();
			expect(body.dataset.demo).toBeUndefined();
		} finally {
			restore();
		}
	});
});

describe("DemoBanner / unmountDemoBanner — auto-mount lifecycle", () => {
	beforeEach(() => __resetDemoRegistry());
	afterEach(() => {
		unmountDemoBanner();
		__resetDemoRegistry();
	});

	it("mounts once on first call and is a no-op on subsequent calls", () => {
		const { body, restore } = installFakeDocument();
		try {
			expect(DemoBanner()).toBeNull();
			expect(body.children).toHaveLength(1);

			expect(DemoBanner()).toBeNull();
			// Still exactly one banner element — the second call did not mount again.
			expect(body.children).toHaveLength(1);
		} finally {
			restore();
		}
	});

	it("unmountDemoBanner tears down the mounted banner and allows a fresh mount afterward", () => {
		const { body, restore } = installFakeDocument();
		try {
			DemoBanner();
			expect(body.children).toHaveLength(1);

			unmountDemoBanner();
			expect(body.children).toHaveLength(0);

			DemoBanner();
			expect(body.children).toHaveLength(1);
		} finally {
			restore();
		}
	});

	it("unmountDemoBanner is a safe no-op when nothing was ever mounted", () => {
		expect(() => unmountDemoBanner()).not.toThrow();
	});
});
