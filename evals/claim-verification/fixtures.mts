export interface Fixture {
    id: string;
    source: string;
    claims: Array<{ id: string; parts: string[]; expected: "supported" | "insufficient" | "contradicted" }>;
    evidence: Array<{ tool: string; input: string; result_tail: string; error: boolean }>;
}

const receipt = (input: string, result_tail: string, error = false) => ({ tool: "Bash", input, result_tail, error });

/** Authored development fixtures, not representative or held-out evaluation. */
export const fixtures: Fixture[] = [
    {
        id: "short-claims", source: "Tests pass. Build failed.",
        claims: [
            { id: "tests", parts: ["Tests pass."], expected: "supported" },
            { id: "build", parts: ["Build failed."], expected: "supported" },
        ],
        evidence: [receipt("npm test", "Tests  14 passed"), receipt("npm run build", "Build failed: missing export", true)],
    },
    {
        id: "markdown-table", source: "| Check | Result |\n| --- | --- |\n| Parser tests | 14 passed, 0 failed |\n| Build | failed |",
        claims: [
            { id: "parser", parts: ["Parser tests", "14 passed, 0 failed"], expected: "supported" },
            { id: "build", parts: ["Build", "failed"], expected: "supported" },
        ],
        evidence: [receipt("npm test -- parser", "Tests  14 passed"), receipt("npm run build", "Build failed", true)],
    },
    {
        id: "after-twelve", source: [...Array.from({ length: 12 }, (_, i) => `The completed inspection number ${i + 1} found no missing configuration entries.`), "The full test suite passed all fourteen tests."].join(" "),
        claims: [{ id: "late-result", parts: ["The full test suite passed all fourteen tests."], expected: "supported" }],
        evidence: [receipt("npm test", "Test Files  3 passed\nTests  14 passed")],
    },
    {
        id: "unicode-crlf", source: "🧬 The cafe\u0301 parser passed all fourteen tests.\r\nThe public API output remains unchanged.",
        claims: [
            { id: "unicode", parts: ["The cafe\u0301 parser passed all fourteen tests."], expected: "supported" },
            { id: "api", parts: ["The public API output remains unchanged."], expected: "insufficient" },
        ],
        evidence: [receipt("npm test -- cafe", "Tests  14 passed")],
    },
    {
        id: "negation-exception", source: "The patch does not change the public API.\nThe client retries at most three times after the initial attempt.\nAuthentication failures are never retried.",
        claims: [
            { id: "api", parts: ["does not change the public API"], expected: "insufficient" },
            { id: "retry", parts: ["at most three times after the initial attempt", "Authentication failures are never retried"], expected: "insufficient" },
        ],
        evidence: [receipt("git diff --stat", "src/client.ts | 5 +++--")],
    },
    {
        id: "correction", source: "The retry limit is three retries.\nActually, the retry limit is five retries.",
        claims: [{ id: "corrected", parts: ["Actually, the retry limit is five retries."], expected: "supported" }],
        evidence: [receipt("cat src/retry-config.ts", "export const MAX_RETRIES = 5;")],
    },
    {
        id: "masked-runner-failure", source: "The parser test suite passed all fourteen tests.",
        claims: [{ id: "false-green", parts: ["The parser test suite passed all fourteen tests."], expected: "contradicted" }],
        evidence: [receipt("npm test -- parser | tail -2", "Tests  1 failed | 13 passed\nShell exit code: 0")],
    },
    {
        id: "scope-mismatch", source: "The entire repository test suite passed without failures.",
        claims: [{ id: "overbroad", parts: ["The entire repository test suite passed without failures."], expected: "insufficient" }],
        evidence: [receipt("npm test -- src/parser.test.ts", "Test Files  1 passed\nTests  14 passed")],
    },
];
