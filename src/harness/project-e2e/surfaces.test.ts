import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { loadE2ePolicy, E2E_POLICY_PATH } from "./policy.js";
import { discoverSurfaces, mapSurfaces, SURFACE_INVENTORY_PATH, writeSurfaceInventory } from "./surfaces.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
function policyOf(root: string) { const loaded = loadE2ePolicy(root); if (loaded.status !== "configured") throw new Error(loaded.status); return loaded.policy; }
const OPENAPI = { openapi: "3.1.0", paths: { "/orders": { post: { operationId: "createOrder" }, get: {} }, "/orders/{id}": { get: { operationId: "getOrder" } } } };

describe("discoverSurfaces — positive", () => {
    it("P1: package.json bin entries and Python script executables become CLI surfaces with source provenance", () => {
        const ts = fixtureProject("ts"), py = fixtureProject("py"); projects.push(ts, py);
        writeFileSync(join(ts.root, "package.json"), JSON.stringify({ name: "orders", bin: { orders: "dist/cli.js" } }));
        const tsInventory = discoverSurfaces(ts.root, policyOf(ts.root));
        expect(tsInventory.projects[0]?.surfaces).toEqual([expect.objectContaining({ kind: "cli", id: "cli:orders", address: "dist/cli.js", discovery: { method: "package-bin", version: 1 }, source: { path: "package.json" } })]);
        const pyInventory = discoverSurfaces(py.root, policyOf(py.root));
        expect(pyInventory.projects[0]?.surfaces.map(row => row.id)).toEqual(["cli:orders_cli.py"]);
    });
    it("P2: an OpenAPI JSON document yields one http surface per operation, keyed by operationId or method+path", () => {
        const ts = fixtureProject("ts"); projects.push(ts);
        writeFileSync(join(ts.root, "openapi.json"), JSON.stringify(OPENAPI));
        const inventory = discoverSurfaces(ts.root, policyOf(ts.root));
        const http = inventory.projects[0]!.surfaces.filter(row => row.kind === "http");
        expect(http.map(row => [row.id, row.method, row.address])).toEqual([["http:createOrder", "POST", "/orders"], ["http:GET /orders", "GET", "/orders"], ["http:getOrder", "GET", "/orders/{id}"]]);
        expect(inventory.projects[0]?.complete).toBe(true);
    });
    it("P3: mapping state is explicit only through scenario surfaceIds; a route literal in a test never maps (PE-63, PE-66)", () => {
        const ts = fixtureProject("ts"); projects.push(ts);
        writeFileSync(join(ts.root, "openapi.json"), JSON.stringify(OPENAPI));
        mkdirSync(join(ts.root, "test"), { recursive: true });
        writeFileSync(join(ts.root, "test/orders.test.js"), "fetch('/orders/{id}')\n");
        const policy = policyOf(ts.root);
        policy.projects[0]!.scenarios[0]!.surfaceIds = ["http:createOrder"];
        const inventory = discoverSurfaces(ts.root, policy);
        const mapped = mapSurfaces(inventory, policy);
        expect(mapped.find(row => row.surface.id === "http:createOrder")).toMatchObject({ state: "explicit", scenarioIds: ["order-persists"] });
        expect(mapped.find(row => row.surface.id === "http:getOrder")).toMatchObject({ state: "unresolved", scenarioIds: [] });
        const path = writeSurfaceInventory(ts.root, inventory);
        expect(path).toBe(SURFACE_INVENTORY_PATH);
        expect(existsSync(join(ts.root, path))).toBe(true);
        expect(JSON.parse(readFileSync(join(ts.root, path), "utf8")).version).toBe(1);
    });
});
describe("discoverSurfaces — negative (incomplete inventories are visible)", () => {
    it("N1: an HTTP framework dependency with no OpenAPI document is an explicit dynamic-registration limit, not an empty complete inventory (PE-64)", () => {
        const ts = fixtureProject("ts"); projects.push(ts);
        writeFileSync(join(ts.root, "package.json"), JSON.stringify({ name: "orders", dependencies: { express: "4" } }));
        const found = discoverSurfaces(ts.root, policyOf(ts.root)).projects[0]!;
        expect(found.complete).toBe(false);
        expect(found.limits.join("\n")).toMatch(/express.*registered in code are not extracted/);
    });
    it("N2: an OpenAPI YAML document is an unsupported-format limit; an unparseable JSON document is reported", () => {
        const ts = fixtureProject("ts"); projects.push(ts);
        writeFileSync(join(ts.root, "openapi.yaml"), "openapi: 3.1.0\n");
        let found = discoverSurfaces(ts.root, policyOf(ts.root)).projects[0]!;
        expect(found.complete).toBe(false);
        expect(found.limits.join("\n")).toMatch(/openapi\.yaml.*YAML.*not parsed/);
        writeFileSync(join(ts.root, "openapi.json"), "{ not json");
        found = discoverSurfaces(ts.root, policyOf(ts.root)).projects[0]!;
        expect(found.limits.join("\n")).toMatch(/openapi\.json.*could not be parsed/);
    });
    it("N3: a scenario naming a surface the inventory does not contain is reported as a dangling mapping", () => {
        const ts = fixtureProject("ts"); projects.push(ts);
        const policy = policyOf(ts.root);
        policy.projects[0]!.scenarios[0]!.surfaceIds = ["http:ghost"];
        writeFileSync(join(ts.root, E2E_POLICY_PATH), JSON.stringify(policy));
        const inventory = discoverSurfaces(ts.root, policy);
        expect(mapSurfaces(inventory, policy).find(row => row.surface.id === "http:ghost")).toMatchObject({ state: "dangling", scenarioIds: ["order-persists"] });
    });
});
