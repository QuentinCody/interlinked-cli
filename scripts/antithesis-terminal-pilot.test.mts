import { expect, it } from "vitest";
import { runtimeImports, summarizeTrace } from "./antithesis-terminal-pilot.mts";
it("counts property failures even when the process exit status is zero", () => {
    const row = { action: { TypeText: "a" }, state: { exit_status: 0 }, violations: [{ name: "oneSelectionMarker", violation: { Always: {} } }] };
    expect(summarizeTrace(JSON.stringify(row))).toMatchObject({ states: 1, actions: 1, exited: true, violations: ["oneSelectionMarker"], invalid: 0 });
});
it("retains literal static and dynamic runtime chunks without old unrelated build files", () => {
    expect(runtimeImports('import {x} from "./chunk.js"; const next = import("./next.js"); // import("./old.js")')).toEqual(["./chunk.js", "./next.js"]);
});
it("never converts malformed or incomplete traces to completed clean runs", () => {
    expect(summarizeTrace('{"state":{}}\n{')).toMatchObject({ invalid: 2, exited: false });
    expect(summarizeTrace('{"state":{"exit_status":null},"violations":[],"action":null}')).toMatchObject({ exited: false, states: 1 });
});
