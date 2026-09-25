// Shared raw policy fixture for the project-e2e unit tests. Lives outside the
// *.test.ts files so importing it does not re-register another file's suites.
export type RawPolicy = Record<string, unknown>;
export function minimalPolicy(): RawPolicy {
    return {
        version: 1,
        projects: [{
            id: "orders", root: ".", protectedInputs: ["src/**"], mode: "required",
            suites: [{ id: "cli", adapter: "managed-contracts", prepare: [{ argv: ["node", "build.mjs"] }], artifacts: ["dist/cli.js"] }],
            scenarios: [{ id: "order-persists", suite: "cli", affects: ["src/**"], contractIds: ["orders.create"], required: true, boundary: { entry: "process", real: ["application"] } }],
        }],
        expectations: [],
    };
}
