// interlinked-cli/demo-runtime — runtime helper for marking demo data.
// Exposed as a `package.json` subpath: `import ... from "interlinked-cli/demo-runtime"`.
//
// This module is intentionally tiny and dependency-free so it can be
// pasted into any project (or imported from this package) without pulling
// any framework into its consumers. It provides:
//
//   - `demoData(key, value, options?)` — passes the value through unchanged
//     while registering the key + reason in a process-wide registry.
//     Logs a console warning the first time each key is read so it shows
//     up in browser devtools / Node console without further wiring.
//
//   - `demoStateSummary()` — read-only snapshot of every key currently
//     registered, plus a pre-formatted banner-text suitable for rendering
//     in a UI banner.
//
//   - `subscribeToDemoState(listener)` — observer for UI integrations
//     (the banner component subscribes; on every demoData() call any
//     React-mounted banner re-renders with the current set).
//
//   - `__resetDemoRegistry()` — test-only escape hatch.
//
// Companion harness check: `demo_runtime_missing_banner` fires when a
// project file imports this module but the project's root layout doesn't
// also render `<DemoBanner />` (provided in the JSX-flavored sibling).

import type { JsonObject } from "../json-types.js";

export interface DemoDataOptions {
	/** One-line reason the data is fake. Surfaced in the UI banner. */
	reason?: string;
	/** Optional tracking ticket — appears next to the reason. */
	ticket?: string;
}

export interface DemoEntry {
	key: string;
	reason: string;
	ticket?: string | undefined;
	registeredAt: number;
}

export interface DemoStateSummary {
	entries: DemoEntry[];
	bannerText: string;
}

type DemoStateListener = (summary: DemoStateSummary) => void;

const REGISTRY = new Map<string, DemoEntry>();
const LISTENERS = new Set<DemoStateListener>();
const ANNOUNCED = new Set<string>();

/** Looked up through `globalThis` rather than the bare `document`
 *  identifier: this module deliberately runs in non-DOM environments too
 *  (Node, tests, SSR — see the module header), but the ambient `lib.dom`
 *  types claim `document` is always defined, which makes `typeof document
 *  !== "undefined"` a type-checker tautology even though it's a real
 *  runtime branch here. */
function getGlobalDocument(): Document | undefined {
	const doc = (globalThis as Record<string, unknown>).document;
	return typeof doc === "object" && doc !== null ? (doc as Document) : undefined;
}

/** `Document.body` is typed non-null by lib.dom, but the DOM spec allows a
 *  bodyless document (e.g. before the parser reaches <body>). Routed through
 *  a function with an explicit `| null` return type so the real nullability
 *  survives — assigning straight into a `const x: HTMLElement | null = ...`
 *  doesn't do it, since control-flow narrowing collapses to the initializer's
 *  own (non-null) type at the point of use, ignoring the wider annotation. */
function getBody(doc: Document): HTMLElement | null {
	return doc.body;
}

function announceOnce(key: string, reason: string): void {
	if (ANNOUNCED.has(key)) return;
	ANNOUNCED.add(key);
	const msg = `[demo-data] "${key}" is rendering fake/test data — ${reason}`;
	if (typeof console !== "undefined" && typeof console.warn === "function") {
		console.warn(msg);
	}
	if (typeof globalThis !== "undefined") {
		const target = globalThis as JsonObject;
		const list = (target.__INTERLINKED_DEMO__ as DemoEntry[] | undefined) ?? [];
		list.push({ key, reason, registeredAt: Date.now() });
		target.__INTERLINKED_DEMO__ = list;
	}
	const doc = getGlobalDocument();
	if (doc?.body) {
		doc.body.dataset.demo = "true";
	}
}

function notifyListeners(): void {
	if (LISTENERS.size === 0) return;
	const summary = demoStateSummary();
	for (const listener of LISTENERS) {
		try {
			listener(summary);
		} catch {
			// non-fatal: a listener error must not break the wrapper
		}
	}
}

/**
 * Public API — wrap a value to mark it as demo data. Returns the value
 * unchanged so callers can use it normally; side-effect is registry
 * registration + banner mount.
 */
export function demoData<T>(key: string, value: T, options: DemoDataOptions = {}): T {
	const reason = options.reason ?? "no reason provided";
	const existing = REGISTRY.get(key);
	if (!existing) {
		REGISTRY.set(key, {
			key,
			reason,
			ticket: options.ticket,
			registeredAt: Date.now(),
		});
	}
	announceOnce(key, reason);
	notifyListeners();
	return value;
}

/** Public API — read-only snapshot of the current demo registry. */
export function demoStateSummary(): DemoStateSummary {
	const entries = [...REGISTRY.values()];
	if (entries.length === 0) {
		return { entries: [], bannerText: "" };
	}
	const labels = entries
		.map((e) => (e.ticket ? `${e.key} (${e.ticket})` : e.key))
		.join(", ");
	const bannerText =
		`DEMO DATA — ${entries.length} source${entries.length === 1 ? "" : "s"} ` +
		`not connected to live APIs. ${labels}`;
	return { entries, bannerText };
}

/** Public API — UI integrations subscribe to receive registry changes. */
export function subscribeToDemoState(listener: DemoStateListener): () => void {
	LISTENERS.add(listener);
	listener(demoStateSummary());
	return () => {
		LISTENERS.delete(listener);
	};
}

/** Public API — test-only registry reset. */
export function __resetDemoRegistry(): void {
	REGISTRY.clear();
	LISTENERS.clear();
	ANNOUNCED.clear();
	if (typeof globalThis !== "undefined") {
		(globalThis as JsonObject).__INTERLINKED_DEMO__ = [];
	}
	const doc = getGlobalDocument();
	if (doc?.body) {
		delete doc.body.dataset.demo;
	}
}

// ==========================================================================
// DemoBanner — vanilla-DOM implementation, framework-agnostic.
// ==========================================================================
// The harness check `demo_runtime_missing_banner` instructs callers to mount
// `<DemoBanner />` from this module. Two shapes are exported:
//   - `mountDemoBanner()`: imperative — creates a fixed-position div in
//     `document.body`, subscribes to the registry, and returns an unmount
//     function. Safe to call in non-DOM environments (returns a no-op
//     unmount).
//   - `DemoBanner`: a thin function alias that auto-mounts on first call
//     and is shaped to be JSX-compatible (`<DemoBanner />` in React/Preact
//     works because both treat function components as `() => element`).
//
// No framework dependency is taken on in this package. React/Preact users
// who want richer styling can wrap `subscribeToDemoState` in their own
// component.

const DEFAULT_BANNER_STYLE =
	"position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
	"padding:8px 16px;font:600 13px/1.4 system-ui,sans-serif;" +
	"color:#1a1a00;background:#ffe066;border-bottom:2px solid #d4a017;" +
	"text-align:center;letter-spacing:0.02em;";

/** Public API — imperative mount; returns an unmount function. */
export function mountDemoBanner(options: { container?: HTMLElement } = {}): () => void {
	const doc = getGlobalDocument();
	if (!doc) return () => undefined;
	const container = options.container ?? getBody(doc);
	if (!container) return () => undefined;
	const el = doc.createElement("div");
	el.dataset.interlinkedDemoBanner = "true";
	el.setAttribute("role", "status");
	el.setAttribute("aria-live", "polite");
	el.style.cssText = DEFAULT_BANNER_STYLE;
	el.style.display = "none";
	container.appendChild(el);

	const unsubscribe = subscribeToDemoState((summary) => {
		if (summary.entries.length === 0) {
			el.style.display = "none";
			el.textContent = "";
			return;
		}
		el.style.display = "";
		el.textContent = `⚠  ${summary.bannerText}`;
	});

	return () => {
		unsubscribe();
		if (el.parentNode) el.parentNode.removeChild(el);
	};
}

/**
 * Public API — JSX-friendly alias. React/Preact `<DemoBanner />` calls a
 * function component; we mount once into document.body the first time the
 * component is rendered, then return null so React's reconciler doesn't
 * try to manage the DOM we control. Subsequent renders are no-ops.
 *
 * For non-React consumers, calling `DemoBanner()` directly is equivalent
 * to `mountDemoBanner()` (and returns null instead of an element so it's
 * safe in any consumer position).
 */
let demoBannerMountedOnce = false;
let demoBannerUnmount: (() => void) | null = null;

export function DemoBanner(): null {
	if (!demoBannerMountedOnce) {
		demoBannerMountedOnce = true;
		demoBannerUnmount = mountDemoBanner();
	}
	return null;
}

/** Public API — companion to DemoBanner; rare manual unmount path. */
export function unmountDemoBanner(): void {
	if (demoBannerUnmount) {
		demoBannerUnmount();
		demoBannerUnmount = null;
	}
	demoBannerMountedOnce = false;
}
