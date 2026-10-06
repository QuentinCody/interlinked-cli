// ===========================================
// Trajectory LTL — read-set recording
// ===========================================
//
// Records which fields an atom READ while it evaluated, so a violation report
// names only the evidence the predicate used (Bombadil's snapshot slicing,
// `lib/bombadil/src/specification/snapshots.rs`, Antithesis, MIT License —
// re-implemented here over plain objects with a Proxy instead of a JS-engine
// hook; no code copied).
//
// The proxy is read-only in effect: atoms are pure predicates, and a write
// through the proxy would reach the real object, so `set` is refused. Only
// plain objects are wrapped (one Proxy per nesting level, up to `MAX_DEPTH`);
// Maps, Sets, arrays and primitives are returned as-is — reading
// `state.fileReadSteps` records the field name, not every key inside it.

const MAX_DEPTH = 3;

/** The two wrapped inputs plus the paths read so far, in first-read order. */
export interface RecordedReads<S, E> {
	readonly state: S;
	readonly event: E;
	/** Dotted paths such as `event.input.command`. */
	readonly reads: () => string[];
}

interface Recorder {
	readonly prefix: string;
	readonly seen: Set<string>;
	readonly depth: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (v === null || typeof v !== "object") return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

function recordingGet(rec: Recorder, target: object, prop: string | symbol, receiver: unknown): unknown {
	const value: unknown = Reflect.get(target, prop, receiver);
	if (typeof prop === "symbol") return value;
	const path = `${rec.prefix}.${prop}`;
	rec.seen.add(path);
	const nested = rec.depth < MAX_DEPTH && isPlainObject(value);
	return nested ? wrap(value, { prefix: path, seen: rec.seen, depth: rec.depth + 1 }) : value;
}

function wrap<T extends object>(target: T, rec: Recorder): T {
	const handler: ProxyHandler<T> = {
		get: (t, prop, receiver) => recordingGet(rec, t, prop, receiver),
		set: () => false, // atoms are pure; refuse writes through the recorder
		deleteProperty: () => false,
	};
	return new Proxy(target, handler);
}

/** Wrap `state` and `event` so every field read is recorded. */
export function recordReads<S extends object, E extends object>(state: S, event: E): RecordedReads<S, E> {
	const seen = new Set<string>();
	return {
		state: wrap(state, { prefix: "state", seen, depth: 1 }),
		event: wrap(event, { prefix: "event", seen, depth: 1 }),
		reads: () => [...seen],
	};
}
