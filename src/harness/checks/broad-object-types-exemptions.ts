// Exemption classes for the `broad_object_types` check's bare-`object` arm.
// Extracted from agent-safety-js-correctness.ts (per-file line cap) after the
// 2026-10-21 cross-repo falsification run: 7 of 9 adjudicated `object` hits
// on zod / zustand were legitimate. Each exemption below names the CLASS the
// run surfaced, never a repo. `Record<K, any>`, index-signature-to-`any` and
// bare `Function` are untouched — every one of those was a true positive.
//
// The check's premise is "a bare `object` hides a shape the reader needed".
// Each class here is a site where NO shape existed to hide:
//   1. `export { x as object }` / `import { x as object }` — a rename
//      specifier, not a type assertion at all.
//   2. `(x: object): x is T` — a type-guard predicate ON THAT parameter;
//      `object` is the domain the guard narrows FROM, and the predicate
//      supplies the shape.
//   3. `value as object` where `value` is declared `unknown`, or the cast
//      sits inside a spread / reflection consumer on its own line — the cast
//      narrows to the narrowest type that permits a spread / `in` /
//      `Object.keys` / `Set<object>` membership.
//   4. a parameter consumed ONLY as an opaque reflection / identity operand
//      (`Object.defineProperty(proto, …)`, `Reflect.*`, `seen.has(x)`,
//      `Symbol.iterator in obj`, a WeakMap/WeakSet key) — the builtin
//      demands `object` and no property of the value is read. A spread
//      options bag, a property read or a forward to another callee in the
//      same body still fires (2026-10-21 verifier repair, P8-P10).

import { escapeRegex } from "../structural-checks/helpers.js";

/** `export { objectType as object }` / `import { x as object }` — a rename. */
const SPECIFIER_RENAME = /\b(?:import|export)\s+(?:type\s+)?(?:\*\s+as\s+object\b|\{[^}]*\bas\s+object\b)/;
const SPECIFIER_OPEN = /\b(?:import|export)\s+(?:type\s+)?\{[^}]*$/;
/** A bare `name as object,` line — a specifier inside a multi-line brace list. */
const BARE_SPECIFIER_LINE = /^\s*[\w$]+\s+as\s+object\s*,?\s*$/;

/** `): x is T` / `): asserts x is T` — a type-guard signature. */
const TYPE_PREDICATE = /\)\s*:\s*(?:asserts\s+)?[\w$]+\s+is\s+/;

/** `name: object` (a parameter / variable annotation); captures the name. */
const OBJECT_ANNOTATION = /\b([\w$]+)\s*\??\s*:\s*object\b/;
/** `expr as object`; captures the operand (an identifier or member chain). */
const OBJECT_CAST = /([\w$]+(?:\.[\w$]+)*)\s+as\s+object\b/;

/** Lines a type-guard predicate may sit on after its first parameter. */
const SIGNATURE_WINDOW = 4;
/** Lines scanned for a reflection use of an annotated parameter. */
const BODY_WINDOW = 60;
const TOP_LEVEL_DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\b/;

/**
 * Class 1: the `as object` on this line is an import/export rename
 * specifier. Tracks a multi-line `{ … }` specifier list through `open`.
 */
export function isSpecifierRename(strippedLines: readonly string[], index: number): boolean {
	const line = strippedLines[index] ?? "";
	if (SPECIFIER_RENAME.test(line)) return true;
	if (!BARE_SPECIFIER_LINE.test(line)) return false;
	for (let j = index - 1; j >= 0 && index - j <= BODY_WINDOW; j--) {
		const prior = strippedLines[j] ?? "";
		if (prior.includes("}")) return false;
		if (SPECIFIER_OPEN.test(prior)) return true;
	}
	return false;
}

/**
 * Class 2: the `name: object` parameter belongs to a signature that returns a
 * predicate ON THAT PARAMETER (`): name is T` / `): asserts name is T`). The
 * predicate must follow the `)` that closes the parameter's own list — a
 * guard declared on the next lines, or a predicate on another name, is not
 * this signature's return type.
 */
export function isTypeGuardSignature(strippedLines: readonly string[], index: number): boolean {
	const window = strippedLines.slice(index, index + SIGNATURE_WINDOW).join("\n");
	const ann = OBJECT_ANNOTATION.exec(window);
	if (!ann || !TYPE_PREDICATE.test(window)) return false;
	let depth = 1;
	for (let k = ann.index + ann[0].length; k < window.length; k++) {
		const ch = window[k];
		if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) {
			const predicate = new RegExp(`^\\s*:\\s*(?:asserts\\s+)?${escapeRegex(ann[1] ?? "")}\\s+is\\s+`);
			return predicate.test(window.slice(k + 1));
		}
	}
	return false;
}

/**
 * The NEAREST preceding declaration of `name` (an annotation `name: T`, a
 * `catch (name)` binding, or an unannotated `const|let|var name`) decides
 * whether it is `unknown`. A file-wide search let a same-named `unknown`
 * parameter in another function exempt `value as object` on a `value: User`
 * — common names (`value`, `data`, `obj`) made that a real over-exemption.
 */
function isDeclaredUnknown(strippedLines: readonly string[], index: number, name: string): boolean {
	const n = escapeRegex(name);
	const decl = new RegExp(
		`\\b${n}\\s*\\??\\s*:\\s*([\\w$.]+)|\\bcatch\\s*\\(\\s*${n}\\b|\\b(?:const|let|var)\\s+${n}\\b(?!\\s*\\??\\s*:)`,
	);
	for (let j = index; j >= 0 && index - j <= BODY_WINDOW; j--) {
		const found = decl.exec(strippedLines[j] ?? "");
		if (!found) continue;
		if (found[0].startsWith("catch")) return true;
		return found[1] === "unknown";
	}
	return false;
}

/**
 * A use of `name` as an opaque reflection / identity operand: the builtin
 * demands `object` and reads no property the reader would need a shape for.
 */
function reflectionUse(name: string, flags = ""): RegExp {
	const n = escapeRegex(name);
	return new RegExp(
		[
			`\\b(?:Object|Reflect)\\.[\\w$]+\\(\\s*${n}\\b`, // Object.keys(x) / Reflect.ownKeys(x)
			`\\.(?:has|add|get|set|delete)\\(\\s*${n}\\b`, // seen.has(x) / weak.set(x, …)
			`\\bin\\s+${n}\\b`, // Symbol.iterator in x / for (k in x)
			`\\bnew\\s+Weak(?:Map|Set|Ref)\\b[^;]*\\b${n}\\b`, // new WeakSet([x])
		].join("|"),
		flags,
	);
}

/**
 * A cast consumer on the cast's own line: a reflection operand, or a spread
 * (`...(x as object)`). The spread arm is cast-only — TypeScript demands an
 * object-typed operand there when the value is `unknown` / generic. An
 * ANNOTATED `opts: object` that the body spreads is an options bag, the
 * shape-hiding case the check exists for, so the parameter path omits it.
 */
function castConsumer(name: string): RegExp {
	return new RegExp(`${reflectionUse(name).source}|\\.\\.\\.\\(?\\s*${escapeRegex(name)}\\b`);
}

/**
 * Uses of `name` that read no property: an assignment target (a prototype
 * walk `p = Object.getPrototypeOf(p)`), an identity / nullish comparison, a
 * truthiness test, or `typeof`.
 */
function opaqueUse(name: string): RegExp {
	const n = escapeRegex(name);
	return new RegExp(
		[
			`\\b${n}\\s*=(?![=>])`,
			`\\b${n}\\s*[!=]==?`,
			`[!=]==?\\s*${n}\\b`,
			`\\btypeof\\s+${n}\\b`,
			`!\\s*${n}\\b`,
			`\\b(?:if|while)\\s*\\(\\s*${n}\\s*\\)`,
			`\\b${n}\\s*(?:&&|\\|\\||\\?\\?)`,
		].join("|"),
		"g",
	);
}

/**
 * True when `body` uses `name` reflectively at least once and NEVER in a way
 * that needs its shape: every remaining occurrence (after removing the
 * declaration, the reflection operands and the opaque uses) would be a
 * property read, a cast, or a forward to an arbitrary callee.
 */
function usedOnlyReflectively(body: string, name: string): boolean {
	const n = escapeRegex(name);
	const rest = body.replace(new RegExp(`\\b${n}\\s*\\??\\s*:\\s*object\\b`), " ");
	if (!reflectionUse(name).test(rest)) return false;
	const residue = rest.replace(reflectionUse(name, "g"), " ").replace(opaqueUse(name), " ");
	// `(?<![\w$.])` skips `other.name`; `(?!\s*\??:)` skips an object-literal key.
	return !new RegExp(`(?<![\\w$.])${n}(?![\\w$])(?!\\s*\\??:)`).test(residue);
}

/**
 * Classes 3 + 4 for a cast: `value as object` narrows a value whose nearest
 * declaration is `unknown`, or sits directly inside a reflection consumer on
 * the same line.
 */
export function isNarrowingCast(strippedLines: readonly string[], index: number): boolean {
	const line = strippedLines[index] ?? "";
	const cast = OBJECT_CAST.exec(line);
	if (!cast) return false;
	const operand = cast[1] ?? "";
	return isDeclaredUnknown(strippedLines, index, operand) || castConsumer(operand).test(line);
}

/** Lines from the signature at `index` to the end of its block (bounded). */
function bodyWindow(strippedLines: readonly string[], index: number): string {
	const out: string[] = [];
	let depth = 0;
	let opened = false;
	for (let j = index; j < strippedLines.length && j - index < BODY_WINDOW; j++) {
		const line = strippedLines[j] ?? "";
		if (j > index && depth === 0 && TOP_LEVEL_DECL.test(line)) break;
		out.push(line);
		for (const ch of line) {
			if (ch === "{") {
				depth++;
				opened = true;
			} else if (ch === "}") depth--;
		}
		if (opened && depth <= 0) break;
	}
	return out.join("\n");
}

/**
 * Class 4 for an annotation: the parameter named `: object` is used inside
 * its own block ONLY as a reflection / identity operand. A parameter the body
 * never touches that way, spreads as an options bag, or also reads a
 * property of (`(cfg as any).timeout`) still fires — `object` there hides a
 * shape the next reader has to guess.
 */
export function isReflectionTargetParam(strippedLines: readonly string[], index: number): boolean {
	const ann = OBJECT_ANNOTATION.exec(strippedLines[index] ?? "");
	if (!ann) return false;
	return usedOnlyReflectively(bodyWindow(strippedLines, index), ann[1] ?? "");
}

/** True when the bare-`object` hit on `index` falls into one of the four classes. */
export function isExemptBareObject(strippedLines: readonly string[], index: number): boolean {
	return (
		isSpecifierRename(strippedLines, index) ||
		isTypeGuardSignature(strippedLines, index) ||
		isNarrowingCast(strippedLines, index) ||
		isReflectionTargetParam(strippedLines, index)
	);
}
