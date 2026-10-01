import { describe, expect, it } from "vitest";
import { astComplexityAvailable } from "./cyclomatic-ast.js";
import { effectCleanupFindingsAst } from "./missing-effect-cleanup-ast.js";

const PATH = "src/components/Widget.tsx";
function component(effectBody: string): string {
    return ["function Widget() {", "  useEffect(() => {", effectBody, "  }, []);", "  return <span>Polling</span>;", "}"].join("\n");
}
function lines(content: string): number[] {
    const findings = effectCleanupFindingsAst(content, PATH);
    if (findings === null) throw new Error("typescript is expected in this checkout");
    return findings.map((finding) => finding.line);
}

describe("effectCleanupFindingsAst — positive (must fire): a subscription with no cleanup RETURN STATEMENT in the callback", () => {
    // test-contract: bug — React disposes a subscription only through the value the effect callback returns; a render return, an object member named `return`, or a value-shaped return does not (https://react.dev/reference/react/useEffect#parameters)
    it("P1: a timer with no return, a bare return, and a return of a value or JSX all flag the effect's line", () => {
        expect(lines(component("    const id = setInterval(tick, 1000);"))).toEqual([2]);
        expect(lines(component("    const id = setInterval(tick, 1000);\n    if (!enabled) return\n    const other = setInterval(tick, 1000)"))).toEqual([2]);
        expect(lines(component("    const id = setInterval(tick, 1000);\n    return { force: false };"))).toEqual([2]);
        expect(lines(component("    const id = setInterval(tick, 1000);\n    return null;"))).toEqual([2]);
    });
    it("P2: an object member named return, with any signature, is not a return statement", () => {
        expect(lines(component("    const timer = setInterval(tick, 1000);\n    const iterator = { return: () => clearInterval(timer) };"))).toEqual([2]);
        expect(lines(component("    const timer = setInterval(tick, 1000);\n    const iterator = { return(): void { clearInterval(timer); } };"))).toEqual([2]);
        expect(lines(component("    const timer = setInterval(tick, 1000);\n    const iterator = { return(value = readValue()) { clearInterval(timer); } };"))).toEqual([2]);
    });
    // test-contract: bug — a callback under parens or a type-only wrapper is the same callback, and `void …` always evaluates to undefined, so neither hides a missing cleanup (review 2026-10-01)
    it("P4: a wrapped callback is still inspected, and a void-valued return is no cleanup", () => {
        expect(lines("function Widget() {\n  useEffect((() => { setInterval(tick, 1000); }), []);\n  return <span />;\n}")).toEqual([2]);
        expect(lines("function Widget() {\n  useEffect((() => { setInterval(tick, 1000); }) as EffectCallback, []);\n  return <span />;\n}")).toEqual([2]);
        expect(lines("function Widget() {\n  useEffect((() => { setInterval(tick, 1000); }) satisfies EffectCallback, []);\n  return <span />;\n}")).toEqual([2]);
        expect(lines("function Widget() {\n  useEffect(() => void window.addEventListener('resize', handleResize), []);\n  return <span />;\n}")).toEqual([2]);
        expect(lines(component("    const id = setInterval(tick, 1000);\n    return void 0;"))).toEqual([2]);
        expect(lines("function Widget() {\n  useEffect((() => { const id = setInterval(tick, 1000); return () => clearInterval(id); }), []);\n  return <span />;\n}")).toEqual([]);
    });
    // test-contract: bug — addEventListener returns undefined and setInterval/setTimeout return a timer id, so returning the setup call itself disposes nothing; `subscribe` returns the disposer by convention (review 2026-10-01)
    it("P5: returning a setup call's non-disposer result is no cleanup", () => {
        expect(lines('function Widget() {\n  useEffect(() => window.addEventListener("resize", handler), []);\n  return <span />;\n}')).toEqual([2]);
        expect(lines("function Widget() {\n  useEffect(() => window.setInterval(tick, 1000), []);\n  return <span />;\n}")).toEqual([2]);
        expect(lines(component("    const id = setInterval(tick, 1000);\n    return setTimeout(tick, 1000);"))).toEqual([2]);
        expect(lines("function Widget() {\n  useEffect(() => store.subscribe(listener), []);\n  return <span />;\n}")).toEqual([]);
    });
    it("P3: a return inside a NESTED function is not the effect's return", () => {
        expect(lines(component("    const id = setInterval(tick, 1000);\n    const stop = () => { return () => clearInterval(id); };"))).toEqual([2]);
    });
});

describe("effectCleanupFindingsAst — negative (must not fire): every parsed cleanup return", () => {
    it.each([
        ["arrow", "return () => clearInterval(id);"],
        ["parenthesized arrow", "return (() => clearInterval(id));"],
        ["destructured default arrow, parenthesized", "return (({ force = false } = {}) => clearInterval(id));"],
        ["generic arrow, parenthesized", "return (<T,>(value?: T) => clearInterval(id));"],
        ["generic arrow with a function-type constraint", "return <T extends () => void>(value?: T) => clearInterval(id);"],
        ["identifier", "const cleanup = () => clearInterval(id);\n    return cleanup"],
        ["member", "return this.disposer;"],
        ["call returning the disposer", "return store.subscribe(listener);"],
        ["switch labels", 'switch (mode) {\n      case "active": return () => clearInterval(id);\n      default: return () => clearInterval(id);\n    }'],
        ["guard then cleanup on one line", "const cleanup = enabled ? store.subscribe(listener) : undefined; if (!cleanup) return; return cleanup;"],
        ["multi-line call", "return store.subscribe(\n      listener\n    );"],
        ["URL string before the cleanup", 'fetch("https://example.com"); return () => clearInterval(id);'],
    ])("N1: %s", (_name, statement) => {
        expect(lines(component(`    const id = setInterval(tick, 1000);\n    ${statement}`))).toEqual([]);
    });
    it("N2: an expression-bodied effect returns its value; commented-out setup is no subscription", () => {
        expect(lines("function Widget() {\n  useEffect(() => store.subscribe(listener), []);\n  return <span />;\n}")).toEqual([]);
        expect(lines(component("    // const timer = setInterval(tick, 1000);\n    // return () => clearInterval(timer);"))).toEqual([]);
    });
    it("N3: the parser is available in this checkout, so the AST route is the one in use", () => {
        expect(astComplexityAvailable()).toBe(true);
    });
});
