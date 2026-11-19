import { expect } from "vitest";
import { bindEffectCleanupCases, type EffectCleanupCases, type EffectCleanupCheck } from "./effect-cleanup-registration.js";

const FILE = "src/components/Widget.tsx";

function effectWithReturn(returnLine: string): string {
	return [
		"useEffect(() => {",
		"  el.addEventListener('click', cb);",
		`  if (x) ${returnLine}`,
		"}, []);",
	].join("\n");
}

const subscriptionDetectionCases: EffectCleanupCases = {
	// --- kills 011fe83b7c733e4d (ArrayDeclaration: [] -> ["Stryker was here"]) ---
	// test-contract: public-api — checkMissingEffectCleanup must return an empty
	// array (not a seeded/garbage entry) when the file has no useEffect calls.
	"returns an empty array when there is no useEffect at all": (checkMissingEffectCleanup) => {
		const content = "const x = 1;\nexport function Widget() { return null; }\n";
		const result = checkMissingEffectCleanup(content, FILE);
		expect(result).toHaveLength(0);
	},

	// --- kills 9cd87732e5352897 (.on\s*\( -> .on\S*\() ---
	// test-contract: public-api — the subscription pattern allows whitespace
	// between `.on` and `(`, so `.on (` must still be recognized as a leak.
	"detects `.on (` with a space before the paren as a subscription": (checkMissingEffectCleanup) => {
		const content = ["useEffect(() => {", "  emitter.on ('data', handler);", "}, []);"].join(
			"\n",
		);
		const result = checkMissingEffectCleanup(content, FILE);
		expect(result).toHaveLength(1);
	},

	// --- kills 8f8b93ba652c6e24 (addEventListener\s*\( -> addEventListener\S*\() ---
	// test-contract: public-api — whitespace before `(` must not hide an
	// `addEventListener` subscription from the leak detector.
	"detects `addEventListener (` with a space before the paren as a subscription": (checkMissingEffectCleanup) => {
		const content = [
			"useEffect(() => {",
			"  window.addEventListener ('resize', onResize);",
			"}, []);",
		].join("\n");
		const result = checkMissingEffectCleanup(content, FILE);
		expect(result).toHaveLength(1);
	},

	// --- kills 82a638c5513407a1 (\buseEffect\s*\( -> \buseEffect\S*\() ---
	// test-contract: public-api — the useEffect-start pattern allows whitespace
	// before `(`, so `useEffect (` must still be treated as an effect start.
	"still recognizes `useEffect (` with a space before the paren as an effect start": (checkMissingEffectCleanup) => {
		const content = [
			"useEffect (() => {",
			"  window.addEventListener('resize', onResize);",
			"}, []);",
		].join("\n");
		const result = checkMissingEffectCleanup(content, FILE);
		expect(result).toHaveLength(1);
	},

	// --- kills 583104481bfe57c4 (nonNull(lines[start]).trim() -> nonNull(lines[start])) ---
	// test-contract: public-api — the reported finding text must show the
	// trimmed source line, with no leading indentation carried into the message.
	"reports the trimmed useEffect start line with no leading whitespace": (checkMissingEffectCleanup) => {
		const content = [
			"    useEffect(() => {",
			"      window.addEventListener('resize', onResize);",
			"    }, []);",
		].join("\n");
		const result = checkMissingEffectCleanup(content, FILE);
		expect(result).toHaveLength(1);
		expect(result[0]?.text).toContain("] useEffect(() => {");
		expect(result[0]?.text).not.toContain("    useEffect");
	},
};

const cleanupSyntaxCases: EffectCleanupCases = {
	// The following cases all wrap a cleanup `return` inside an `if (x) …` line so
	// the trimmed/raw line never starts with "return" itself — isolating the first
	// return-detection regex (`/\breturn\s+(function\b|\(\s*\)\s*=>|[\w]+\s*;)/`)
	// from the second, anchored check (`/^\s*return\s/`). Each variant probes one
	// quantifier/char-class in that first regex. With the real code every one of
	// these is recognized as a valid cleanup, so no finding is produced.


	// kills: ae456c73f7514a08 (test(...) -> false), d7dd8f7e6442416b (\s+ -> \S+),
	// 022d10c9957cbc03 ([\w]+ -> [\W]+), 78e46cdeea1781d4 ([\w]+ -> [^\w]+),
	// 55abf0384fd41a37 ([\w]+ -> [\w]), 81dd3d0d97617e8f (\s*; -> \s;),
	// 186fd2e1e86a8253 (hasReturn=true block emptied), ff57c829a7964b4d (true -> false)
	// test-contract: public-api — `return <identifier>;` mid-line is a documented
	// valid cleanup form, so it must suppress the leak finding.
	"recognizes `return identifier;` as cleanup mid-line": (checkMissingEffectCleanup) => {
		const content = effectWithReturn("return cleanupFn;");
		const result = checkMissingEffectCleanup(content, FILE);
		expect(result).toHaveLength(0);
	},

	// kills 03971650277cb199 (\breturn\s+ -> \breturn\s, single-char quantifier)
	// test-contract: public-api — the return-detection pattern allows one-or-more
	// whitespace after `return`, so extra spaces must not defeat cleanup detection.
	"recognizes `return  identifier;` with extra whitespace after return": (checkMissingEffectCleanup) => {
		const content = effectWithReturn("return  cleanupFn;");
		const result = checkMissingEffectCleanup(content, FILE);
		expect(result).toHaveLength(0);
	},

	// kills 0072f99b1e62535c (\)\s*=> -> \)\s=>) and d2663601337c66d0 (\(\s*\) -> \(\s\))
	// test-contract: public-api — the arrow-cleanup pattern permits zero spaces
	// inside the parens and around `=>`, so a compact arrow must still count.
	"recognizes `return ()=>{...}` with zero spaces around the arrow": (checkMissingEffectCleanup) => {
		const content = effectWithReturn("return ()=>{cleanup();};");
		const result = checkMissingEffectCleanup(content, FILE);
		expect(result).toHaveLength(0);
	},

	// kills 68fbd0bfe19a2d26 (\(\s*\) -> \(\S*\))
	// test-contract: public-api — the arrow-cleanup pattern allows whitespace
	// inside the parens, so `( )` must still be recognized as an empty arg list.
	"recognizes `return ( ) => {...}` with a space inside the parens": (checkMissingEffectCleanup) => {
		const content = effectWithReturn("return ( ) => {cleanup();};");
		const result = checkMissingEffectCleanup(content, FILE);
		expect(result).toHaveLength(0);
	},

	// kills 71e0168204c1bab8 (\)\s*=> -> \)\S*=>)
	// test-contract: public-api — whitespace between the closing paren and `=>`
	// is a permitted style, so it must not defeat cleanup detection.
	"recognizes `return () => {...}` with a space before the arrow": (checkMissingEffectCleanup) => {
		const content = effectWithReturn("return () => {cleanup();};");
		const result = checkMissingEffectCleanup(content, FILE);
		expect(result).toHaveLength(0);
	},

	// kills 4a7341357033a737 ([\w]+\s*; -> [\w]+\S*;)
	// test-contract: public-api — the return-detection pattern allows whitespace
	// before the trailing `;`, so it must not defeat cleanup detection.
	"recognizes `return identifier ;` with a space before the semicolon": (checkMissingEffectCleanup) => {
		const content = effectWithReturn("return cleanupFn ;");
		const result = checkMissingEffectCleanup(content, FILE);
		expect(result).toHaveLength(0);
	},

	// kills fa1cb6358aefb873 (/^\s*return\s/ -> /\s*return\s/, dropped ^ anchor)
	// test-contract: bug — the anchored `^\s*return\s` check must only match a
	// line that actually starts with `return`, not any comment mentioning it.
	"does NOT treat a mid-line comment mentioning `return` as cleanup": (checkMissingEffectCleanup) => {
		const content = [
			"useEffect(() => {",
			"  window.addEventListener('resize', onResize);",
			"  // TODO return later",
			"}, []);",
		].join("\n");
		const result = checkMissingEffectCleanup(content, FILE);
		expect(result).toHaveLength(1);
	},
};

export function effectCleanupMutationScenarios(check: EffectCleanupCheck) {
	return {
		"checkMissingEffectCleanup — mutation-kill w60": bindEffectCleanupCases(
			{ ...subscriptionDetectionCases, ...cleanupSyntaxCases }, check,
		),
	};
}
