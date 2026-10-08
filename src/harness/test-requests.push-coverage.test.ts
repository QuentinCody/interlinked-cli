import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseObligation, readRequestObligation, recordRequeue, requestTests, supersededBy } from "./test-requests.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string {
    const path = mkdtempSync(join(tmpdir(), "test-request-audit-"));
    roots.push(path);
    return path;
}

it.each([null, {}, { full: false, paths: [1] }, { full: false, paths: [], requirements: { staticSelection: false } }])(
    "rejects malformed obligations without certifying them: %j", value => {
        expect(parseObligation(value)).toBeNull();
    },
);

it("reads immutable obligations with either id spelling and treats unreadable or torn evidence as missing", () => {
    const cwd = root();
    const id = requestTests(cwd, ["a.ts"], false, { coverage: { reporters: ["json"] } });
    const obligation = { paths: ["a.ts"], full: false, requirements: { coverage: { reporters: ["json"] } } };
    expect(readRequestObligation(cwd, id)).toEqual(obligation);
    expect(readRequestObligation(cwd, `${id}.json`)).toEqual(obligation);
    expect(readRequestObligation(cwd, "absent")).toBeNull();
    writeFileSync(join(cwd, ".interlinked/test-runs/requests", `${id}.json`), "{");
    expect(readRequestObligation(cwd, id)).toBeNull();
    expect(parseObligation({ paths: [], full: true })).toEqual({ paths: [], full: true, requirements: {} });
});

it("follows the newest valid requeue while ignoring torn and unrelated audit rows", () => {
    const cwd = root();
    expect(supersededBy(cwd, "old")).toBeNull();
    expect(recordRequeue(cwd, "old", "unwritten", [], false)).toBe(false);
    requestTests(cwd, [], false);
    expect(recordRequeue(cwd, "old", "first", ["a.ts"], false)).toBe(true);
    const audit = join(cwd, ".interlinked/test-runs/requests/superseded.jsonl");
    appendFileSync(audit, '\n{torn\nnull\n{"id":"other","by":"wrong"}\n{"id":"old","by":42}\n');
    expect(supersededBy(cwd, "old")).toBe("first");
    expect(recordRequeue(cwd, "old", "second", ["a.ts"], true)).toBe(true);
    expect(supersededBy(cwd, "old")).toBe("second");
    expect(supersededBy(cwd, "unrelated")).toBeNull();
});
