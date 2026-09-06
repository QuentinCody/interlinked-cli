import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	DEFAULT_SIMILARITY_THRESHOLD,
	extractFunctionShingles,
	findClones,
	jaccard,
	MIN_LOGICAL_LINES,
	shingleSet,
	tokenize,
} from "./dry.js";

// ==================================================================
// Primitive helpers
// ==================================================================

describe("tokenize / shingleSet / jaccard", () => {
	it("tokenizes identifiers, numbers, and punctuation separately", () => {
		expect(tokenize("a + b")).toEqual(["a", "+", "b"]);
		expect(tokenize("foo(1.5)")).toEqual(["foo", "(", "1.5", ")"]);
	});

	it("returns an empty shingle set below n tokens", () => {
		expect(shingleSet(["a", "b"], 4).size).toBe(0);
	});

	it("builds overlapping n-grams", () => {
		const s = shingleSet(["a", "b", "c", "d", "e"], 4);
		expect(s.size).toBe(2); // abcd, bcde
	});

	it("jaccard is 1 for identical sets, 0 for disjoint", () => {
		const a = new Set(["x", "y"]);
		const b = new Set(["x", "y"]);
		const c = new Set(["p", "q"]);
		expect(jaccard(a, b)).toBe(1);
		expect(jaccard(a, c)).toBe(0);
	});

	it("jaccard is 0 when either set is empty", () => {
		expect(jaccard(new Set(), new Set(["x"]))).toBe(0);
	});
});

// ==================================================================
// Positive cases — genuine near-duplicate functions MUST fire
// ==================================================================

describe("findClones — positive cases", () => {
	it("flags two near-identical functions in the same file", () => {
		const content = `
export function sumPositiveA(values: number[]): number {
	let total = 0;
	for (const value of values) {
		if (value > 0) {
			total = total + value;
		}
	}
	return total;
}

export function sumPositiveB(values: number[]): number {
	let total = 0;
	for (const value of values) {
		if (value > 0) {
			total = total + value;
		}
	}
	return total;
}
`;
		const fns = extractFunctionShingles(content, "src/math.ts");
		const findings = findClones({ edited: fns, candidates: [] });
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).similarity).toBeGreaterThanOrEqual(DEFAULT_SIMILARITY_THRESHOLD);
	});

	it("flags a clone that lives in a sibling file (candidate set)", () => {
		const edited = `
export function validateEmailField(input: string): boolean {
	const trimmed = input.trim();
	if (trimmed.length === 0) {
		return false;
	}
	if (!trimmed.includes("@")) {
		return false;
	}
	return true;
}
`;
		const sibling = `
export function validateNameField(input: string): boolean {
	const trimmed = input.trim();
	if (trimmed.length === 0) {
		return false;
	}
	if (!trimmed.includes("@")) {
		return false;
	}
	return true;
}
`;
		const editedFns = extractFunctionShingles(edited, "src/validators/email.ts");
		const siblingFns = extractFunctionShingles(sibling, "src/validators/name.ts");
		const findings = findClones({ edited: editedFns, candidates: siblingFns });
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).otherFile).toBe("src/validators/name.ts");
	});

	it("flags near-duplicates with only minor identifier drift", () => {
		const content = `
function loadUserConfig(path: string): Config {
	const raw = readFileSync(path, "utf-8");
	const parsed = JSON.parse(raw);
	if (parsed.version === undefined) {
		throw new Error("missing version");
	}
	return parsed;
}

function loadTeamConfig(path: string): Config {
	const raw = readFileSync(path, "utf-8");
	const parsed = JSON.parse(raw);
	if (parsed.version === undefined) {
		throw new Error("missing version");
	}
	return parsed;
}
`;
		const fns = extractFunctionShingles(content, "src/config.ts");
		const findings = findClones({ edited: fns, candidates: [] });
		expect(findings.length).toBe(1);
	});

	it("reports only the single strongest match for a triple duplicate", () => {
		const body = `{
	const acc = [];
	for (const item of items) {
		if (item.active) {
			acc.push(item.id);
		}
	}
	return acc;
}`;
		const content = `
function pickA(items: Item[]): string[] ${body}
function pickB(items: Item[]): string[] ${body}
function pickC(items: Item[]): string[] ${body}
`;
		const fns = extractFunctionShingles(content, "src/pick.ts");
		const findings = findClones({ edited: fns, candidates: [] });
		// pickA→best, pickB→best — pickC has no later partner. Each edited fn
		// reports at most one match, so no triple-counting.
		expect(findings.length).toBeLessThanOrEqual(2);
		expect(findings.length).toBeGreaterThanOrEqual(1);
	});
});

// ==================================================================
// extractFunctionShingles — the shingle floor (MIN_SHINGLES)
// ==================================================================

describe("extractFunctionShingles — shingle floor", () => {
	it("empties an entry that clears the logical-line floor but yields <3 distinct shingles", () => {
		// Reaches the `shingles.size < MIN_SHINGLES` arm, which needs a body that
		// is long enough in LINES yet degenerate in TOKENS. Two stackable facts of
		// the real pipeline get it there:
		//   1. `stripCommentsAndStrings` treats a leading `#` as a line-comment
		//      marker, so a `#private` method's declaration line is blanked —
		//      its 5+ distinct declaration tokens never reach the shingler, while
		//      the TS AST still reports the method's full line..endLine span.
		//   2. The surviving tokens are `a a a a a }` — 3 four-token windows, only
		//      2 of them distinct.
		// Logical lines counts the blanked declaration line out but the five body
		// lines and the closing brace in, so the entry is past MIN_LOGICAL_LINES.
		const content = `
class Holder {
	#collect() {
		a
		a
		a
		a
		a
	}
}
`;
		const fns = extractFunctionShingles(content, "src/holder.ts");
		const collect = nonNull(fns.find((f) => f.name === "#collect"));
		// Past the logical-line floor, so this is NOT the MIN_LOGICAL_LINES arm.
		expect(collect.logicalLines).toBe(6);
		expect(collect.logicalLines).toBeGreaterThanOrEqual(MIN_LOGICAL_LINES);
		// Under the shingle floor: the entry is emptied rather than kept with a
		// noise-dominated 2-shingle set.
		expect(collect.shingles.size).toBe(0);
		// An emptied entry is dropped before any pairing.
		expect(findClones({ edited: fns, candidates: [] })).toEqual([]);
	});
});

// ==================================================================
// Negative cases — legitimate patterns must NOT fire
// ==================================================================

describe("findClones — negative cases", () => {
	it("does not flag tiny functions (below MIN_LOGICAL_LINES)", () => {
		const content = `
function getX(): number {
	return this.x;
}
function getY(): number {
	return this.y;
}
function getZ(): number {
	return this.z;
}
`;
		const fns = extractFunctionShingles(content, "src/point.ts");
		const findings = findClones({ edited: fns, candidates: [] });
		expect(findings.length).toBe(0);
	});

	it("does not flag structurally-similar-but-distinct logic", () => {
		const content = `
function computeArea(shape: Rect): number {
	const width = shape.right - shape.left;
	const height = shape.bottom - shape.top;
	const area = width * height;
	const padded = area + shape.margin;
	return padded;
}

function classifyRisk(score: number): string {
	const normalized = score / 100;
	if (normalized > 0.8) {
		return "high";
	}
	if (normalized > 0.4) {
		return "medium";
	}
	return "low";
}
`;
		const fns = extractFunctionShingles(content, "src/geometry.ts");
		const findings = findClones({ edited: fns, candidates: [] });
		expect(findings.length).toBe(0);
	});

	it("does not flag framework lifecycle stubs with shared boilerplate", () => {
		// React-style component method stubs: same arity, same lifecycle shape,
		// but each does genuinely different work.
		const content = `
class Widget extends Component {
	componentDidMount(): void {
		this.timer = setInterval(() => this.refresh(), 1000);
		this.subscription = this.store.subscribe(this.onChange);
		this.logger.info("widget mounted");
	}

	componentWillUnmount(): void {
		clearInterval(this.timer);
		this.subscription.unsubscribe();
		this.logger.info("widget unmounted");
	}
}
`;
		const fns = extractFunctionShingles(content, "src/widget.tsx");
		const findings = findClones({ edited: fns, candidates: [] });
		expect(findings.length).toBe(0);
	});

	it("does not flag two distinct switch-style dispatchers", () => {
		const content = `
function renderByKindA(kind: string): string {
	switch (kind) {
		case "alpha":
			return makeAlpha();
		case "beta":
			return makeBeta();
		default:
			return makeDefault();
	}
}

function priceByTierB(tier: string): number {
	switch (tier) {
		case "free":
			return 0;
		case "pro":
			return 20;
		default:
			return 99;
	}
}
`;
		const fns = extractFunctionShingles(content, "src/dispatch.ts");
		const findings = findClones({ edited: fns, candidates: [] });
		expect(findings.length).toBe(0);
	});
});
