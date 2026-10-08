// Behavioral examples shared by the detector and the real hook boundary.
// Expectations come from the test-legitimacy contract, never detector output.
export const testLegitimacyCases = [
    {
        name: "standalone receipt grounds the following case",
        path: "widget.mutation-kill.test.ts",
        content: '// test-contract: boundary — renders the documented empty state\nit("empty", () => expect(render()).toEqual("Empty"));',
        lines: [],
    },
    {
        name: "a specific rationale can mention a contract without being a placeholder",
        path: "widget.mutation-kill.test.ts",
        content: '// test-contract: boundary — empty input preserves the documented API contract\nit("empty", () => expect(render()).toEqual("Empty"));',
        lines: [],
    },
    {
        name: "a trailing code comment cannot ground the next case",
        path: "widget.mutation-kill.test.ts",
        content: 'render();// test-contract: boundary — renders the documented empty state\nit("empty", () => expect(render()).toEqual("Empty"));',
        lines: [2],
    },
    {
        name: "whitespace cannot turn a placeholder into a specific rationale",
        path: "widget.mutation-kill.test.ts",
        content: '// test-contract: boundary — test                  \nit("empty", () => expect(render()).toEqual("Empty"));',
        lines: [2],
    },
    {
        name: "multiline fixture text is not a private import",
        path: "widget.test.ts",
        content: 'const fixture = `\nimport { __privateThing } from "./internal/widget.js";\n`;\nexpect(render(fixture)).toEqual("Example");',
        lines: [],
    },
    {
        name: "a real private import after a fixture still reports its own line",
        path: "widget.test.ts",
        content: 'const fixture = `\nimport { __privateThing } from "./internal/widget.js";\n`;\nimport { render } from "./private/widget.js";\nexpect(render(fixture)).toEqual("Example");',
        lines: [4],
    },
    {
        name: "an indented real private import remains visible",
        path: "widget.test.ts",
        content: '    import { render } from "./private/widget.js";\nexpect(render()).toEqual("Empty");',
        lines: [1],
    },
];
