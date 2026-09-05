import { describe, expect, it } from "vitest";
import { extractSpecFacts } from "./extract-facts.js";
import { extractDeclaredFacts } from "./extract-misc.js";
import { maskExampleFields, maskQuotedFactText } from "./fact-context.js";
import { SpecLedger } from "./ledger.js";

describe("quoted examples are not live spec facts in any project", () => {
    const review = [
        "# Parser review",
        "1. [severity: high] Range parsing loses context.",
        "   Evidence: `FG-INV-01 through FG-INV-20` is sample parser input.",
        "   Evidence: Three rows for `FG-INV-01` through `FG-INV-03` plus `See future FG-INV-99`.",
        "   Evidence: Inputs `` `FG-INV-01` through `FG-INV-20` `` and `**FG-INV-01** through **FG-INV-20**`.",
        "   Evidence: breaking input: `Six bets; B1 B2 B3`.",
        "   Evidence: `<!-- fact:solo -->one<!-- /fact:solo -->` and `<!-- fact:solo -->two<!-- /fact:solo -->`.",
    ].join("\n");

    it.each(["README.md", "docs/review.md", "notes/anything.markdown"])("does not depend on the filename %s", (file) => {
        const facts = extractSpecFacts(review, file);
        expect(facts.rangeClaims).toEqual([]);
        expect(facts.countClaims).toEqual([]);
        expect(facts.namespaces).toEqual([]);
        expect(facts.declaredFacts).toEqual([]);
        const ledger = SpecLedger.fromContents("/some-other-project", {
            [file]: review,
            "registry.md": "| FG-INV-01 | a |\n| FG-INV-20 | b |\n| FG-INV-28 | c |",
        });
        expect(ledger.computeDrift()).toEqual([]);
    });

    it("retains genuine counts and endpoint formatting next to quoted examples", () => {
        const facts = extractSpecFacts([
            "The obsolete wording was `Six bets; B1 B2 B99`.",
            "The old phrase was “FG-INV-01 through FG-INV-99”.",
            "There are **six** bets: `B1` `B2` `B3`.",
            "Every invariant `FG-INV-01` through `FG-INV-20` is checked.",
        ].join("\n"), "README.md");
        expect(facts.countClaims.map((claim) => [claim.value, claim.line])).toEqual([[6, 3]]);
        expect(facts.rangeClaims.map((claim) => [claim.to, claim.line])).toEqual([[20, 4]]);
        expect(facts.namespaces[0]?.max).toBe(3);
    });

    it("masks labeled paragraphs and resumes at the next peer paragraph", () => {
        const lines = ["**Example:**", "    Six bets B1 B2 B99", "", "    FG-INV-01 through FG-INV-99", "Six bets are current."];
        const masked = maskExampleFields(lines);
        expect(masked.slice(0, 4).every((line) => line.trim() === "")).toBe(true);
        expect(masked[4]).toBe(lines[4]);
        expect(masked.map((line) => line.length)).toEqual(lines.map((line) => line.length));
    });

    it("does not interpret quoted, fenced or blockquoted markers as declarations", () => {
        const marker = "<!-- fact:mode -->active<!-- /fact:mode -->";
        const facts = extractDeclaredFacts([
            "`" + marker + "`", "``" + marker + "``", "> " + marker,
            "```html", marker, "```", "~~~", marker, "~~~", marker,
        ]);
        expect(facts).toEqual([{ name: "mode", value: "active", line: 10 }]);
    });

    it("retains exact live marker values containing code and quotes", () => {
        expect(extractDeclaredFacts(['<!-- fact:mode -->`active` "literal"<!-- /fact:mode -->'])).toEqual([
            { name: "mode", value: '`active` "literal"', line: 1 },
        ]);
    });

    it("ignores prose quotations of marker syntax while keeping the live declaration", () => {
        const marker = "<!-- fact:mode -->active<!-- /fact:mode -->";
        expect(extractDeclaredFacts(['The old syntax was "' + marker + '".', "Example wording ‘" + marker + "’.", marker])).toEqual([
            { name: "mode", value: "active", line: 3 },
        ]);
    });

    it("does not let a quote inside code swallow a following live marker", () => {
        expect(extractDeclaredFacts(['`"` <!-- fact:mode -->active<!-- /fact:mode --> "'])).toEqual([
            { name: "mode", value: "active", line: 1 },
        ]);
    });

    it("keeps long unmatched quote input bounded and preserves positions", () => {
        const text = "“example ".repeat(20_000);
        expect(maskQuotedFactText(text)).toBe(text);
        expect(maskQuotedFactText('old "six bets"; three phases').length).toBe('old "six bets"; three phases'.length);
    });
});
