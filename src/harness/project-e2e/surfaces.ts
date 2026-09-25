// ===========================================
// Surfaces — addressable public entry points and their scenario mappings
// ===========================================
// Plan 31 §6.5. A surface record is a CANDIDATE with provenance; only a
// scenario's explicit `surfaceIds` binds it. Extractors are narrow and
// honest about scope: package.json bins, Python scripts, Cargo bins and
// OpenAPI JSON operations. Routes registered in code and YAML documents are
// reported as limits, never as an empty complete inventory (PE-64).

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pythonEntryPoints } from "./discover.js";
import { E2E_POLICY_PATH, type E2ePolicy, type E2eProject } from "./policy.js";

export const SURFACE_INVENTORY_PATH = ".interlinked/test-runs/e2e/discovery/surfaces.json";
export interface SurfaceRecord {
    projectId: string; id: string; kind: "cli" | "http" | "other" | "unknown"; address: string; method?: string;
    source: { path: string }; discovery: { method: "package-bin" | "cargo-bin" | "python-script" | "python-entry" | "openapi-json" | "policy"; version: 1 };
}
export interface SurfaceInventoryProject { projectId: string; surfaces: SurfaceRecord[]; complete: boolean; limits: string[]; }
export interface SurfaceInventory { version: 1; generatedAt: string; projects: SurfaceInventoryProject[]; }
export interface SurfaceMapping { surface: SurfaceRecord; state: "explicit" | "unresolved" | "dangling"; scenarioIds: string[]; }

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const HTTP_FRAMEWORKS = ["express", "fastify", "hono", "koa", "@nestjs/core", "restify", "fastapi", "flask", "django", "starlette", "aiohttp"];
const OPENAPI_DIRECTORIES = [".", "api", "docs", "openapi", "spec"];
const OPENAPI_NAMES = ["openapi.json", "openapi.yaml", "openapi.yml", "swagger.json", "swagger.yaml"];
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function readText(path: string): string | null {
    try { if (statSync(path).size > MAX_TEXT_BYTES) return null; return readFileSync(path, "utf8"); } catch { return null; }
}
function readJson(path: string): Record<string, unknown> | null {
    const text = readText(path);
    if (text === null) return null;
    try {
        const value: unknown = JSON.parse(text);
        // SAFETY: non-null, non-array object per the guard.
        return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch { return null; }
}
function cliSurface(projectId: string, name: string, address: string, source: string, method: SurfaceRecord["discovery"]["method"]): SurfaceRecord {
    return { projectId, id: `cli:${name}`, kind: "cli", address, source: { path: source }, discovery: { method, version: 1 } };
}
function packageBinSurfaces(dir: string, projectId: string): SurfaceRecord[] {
    const pkg = readJson(join(dir, "package.json"));
    const bin = pkg?.bin;
    if (typeof bin === "string") return [cliSurface(projectId, String(pkg?.name ?? "bin").replace(/^@[^/]+\//, ""), bin, "package.json", "package-bin")];
    if (!bin || typeof bin !== "object") return [];
    return Object.entries(bin).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([name, path]) => cliSurface(projectId, name, path, "package.json", "package-bin"));
}
function pythonScriptSurfaces(dir: string, projectId: string): SurfaceRecord[] {
    let names: string[];
    try { names = readdirSync(dir).filter(name => name.endsWith(".py")).sort(); } catch { return []; }
    return names.filter(name => /__name__\s*==\s*["']__main__["']/.test(readText(join(dir, name)) ?? "")).map(name => cliSurface(projectId, name, name, name, "python-script"));
}
/** `[project.scripts]` console entries (B5): addressed by their declared `module:callable`, not by a substituted invocation. */
function pythonEntrySurfaces(dir: string, projectId: string): SurfaceRecord[] {
    return pythonEntryPoints(dir).map(entry => cliSurface(projectId, entry.name, `${entry.module}${entry.callable ? `:${entry.callable}` : ""}`, "pyproject.toml", "python-entry"));
}
/** Explicitly declared surfaces (plan §6.5): the fallback for interfaces no extractor knows. A declaration with an extracted twin's id replaces it. */
function declaredSurfaces(project: E2eProject): SurfaceRecord[] {
    return (project.surfaces ?? []).map(row => ({
        projectId: project.id, id: row.id, kind: row.kind, address: row.address, ...(row.method ? { method: row.method } : {}),
        source: { path: E2E_POLICY_PATH }, discovery: { method: "policy", version: 1 },
    }));
}
function cargoBinSurfaces(dir: string, projectId: string): SurfaceRecord[] {
    const text = readText(join(dir, "Cargo.toml"));
    if (text === null || !existsSync(join(dir, "src/main.rs"))) return [];
    const name = text.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    return name ? [cliSurface(projectId, name, `target/release/${name}`, "Cargo.toml", "cargo-bin")] : [];
}
function openApiDocuments(dir: string): Array<{ path: string; format: "json" | "yaml" }> {
    const found: Array<{ path: string; format: "json" | "yaml" }> = [];
    for (const sub of OPENAPI_DIRECTORIES) {
        for (const name of OPENAPI_NAMES) {
            const rel = sub === "." ? name : `${sub}/${name}`;
            if (existsSync(join(dir, rel))) found.push({ path: rel, format: name.endsWith(".json") ? "json" : "yaml" });
        }
    }
    return found;
}
/** Operations in DOCUMENT order (the author's ordering is part of the inventory's provenance). */
function operationsOf(projectId: string, path: string, route: string, item: Record<string, unknown>): SurfaceRecord[] {
    const surfaces: SurfaceRecord[] = [];
    for (const [method, operation] of Object.entries(item)) {
        // SAFETY: widening a literal tuple to string[] for membership; the check itself is what narrows `method`.
        if (!(HTTP_METHODS as readonly string[]).includes(method)) continue;
        const operationId = operation && typeof operation === "object" ? (operation as Record<string, unknown>).operationId : undefined; // SAFETY: object guard
        const upper = method.toUpperCase();
        surfaces.push({ projectId, id: `http:${typeof operationId === "string" ? operationId : `${upper} ${route}`}`, kind: "http", address: route, method: upper, source: { path }, discovery: { method: "openapi-json", version: 1 } });
    }
    return surfaces;
}
const MAX_REF_HOPS = 4;
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
/** Resolves a LOCAL JSON pointer (`#/a/b`) inside the document; null when external, malformed or missing. */
function resolvePointer(document: Record<string, unknown>, ref: string): Record<string, unknown> | null {
    if (!ref.startsWith("#/")) return null;
    let node: unknown = document;
    for (const segment of ref.slice(2).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
        if (!isRecord(node)) return null;
        node = node[segment];
    }
    return isRecord(node) ? node : null;
}
/** A path item may be a `$ref` chain (B4): follow local references a bounded number of hops; anything unresolved is a named limit, never a silent drop. */
function resolvePathItem(document: Record<string, unknown>, route: string, item: Record<string, unknown>, path: string, limits: string[]): Record<string, unknown> | null {
    let current: Record<string, unknown> = item;
    for (let hop = 0; hop < MAX_REF_HOPS; hop += 1) {
        const ref = current.$ref;
        if (ref === undefined) return current;
        const target = typeof ref === "string" ? resolvePointer(document, ref) : null;
        if (!target) { limits.push(`${path}: ${route} references ${String(ref)} which could not be resolved (external or missing); its operations are not extracted — declare the surface explicitly`); return null; }
        current = target;
    }
    limits.push(`${path}: ${route} follows more than ${MAX_REF_HOPS} $ref hops; its operations are not extracted — declare the surface explicitly`);
    return null;
}
function openApiOperations(dir: string, path: string, projectId: string, limits: string[]): SurfaceRecord[] {
    const document = readJson(join(dir, path));
    if (!document) { limits.push(`${path} could not be parsed as JSON; declare its surfaces explicitly or fix the document`); return []; }
    const paths = document.paths;
    if (!isRecord(paths)) { limits.push(`${path} has no "paths" object; no operations extracted`); return []; }
    return Object.entries(paths)
        .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
        .flatMap(([route, item]) => { const resolved = resolvePathItem(document, route, item, path, limits); return resolved ? operationsOf(projectId, path, route, resolved) : []; });
}
function frameworkLimit(dir: string): string | null {
    const pkg = readJson(join(dir, "package.json"));
    // SAFETY: dependency maps are read as unknown records; only their keys are used.
    const deps = Object.keys({ ...(pkg?.dependencies as Record<string, unknown> | undefined ?? {}), ...(pkg?.devDependencies as Record<string, unknown> | undefined ?? {}) });
    const pythonText = ["pyproject.toml", "requirements.txt"].map(name => readText(join(dir, name)) ?? "").join("\n").toLowerCase();
    const hit = HTTP_FRAMEWORKS.find(name => deps.includes(name) || (pythonText.length > 0 && new RegExp(`\\b${name.replace("@", "")}\\b`).test(pythonText)));
    return hit ? `${hit} is a dependency but no OpenAPI document was found: HTTP routes registered in code are not extracted; the inventory is incomplete until surfaces are declared explicitly` : null;
}
function projectSurfaces(root: string, project: E2eProject): SurfaceInventoryProject {
    const dir = project.root === "." ? root : join(root, project.root);
    const limits: string[] = [];
    const extracted = [...packageBinSurfaces(dir, project.id), ...pythonEntrySurfaces(dir, project.id), ...pythonScriptSurfaces(dir, project.id), ...cargoBinSurfaces(dir, project.id)];
    const documents = openApiDocuments(dir);
    for (const document of documents) {
        if (document.format === "yaml") limits.push(`${document.path} is an OpenAPI YAML document; YAML is not parsed (unsupported); convert to JSON or declare surfaces explicitly`);
        else extracted.push(...openApiOperations(dir, document.path, project.id, limits));
    }
    if (!documents.length) { const limit = frameworkLimit(dir); if (limit) limits.push(limit); }
    const declared = declaredSurfaces(project);
    const surfaces = [...extracted.filter(row => !declared.some(item => item.id === row.id)), ...declared];
    return { projectId: project.id, surfaces, complete: limits.length === 0, limits };
}
/** Read-only static discovery for every project in the policy. Runtime discovery (querying an owned application) is Unit D work. */
export function discoverSurfaces(root: string, policy: E2ePolicy): SurfaceInventory {
    return { version: 1, generatedAt: new Date().toISOString(), projects: policy.projects.map(project => projectSurfaces(root, project)) };
}
function boundSurfaces(project: E2eProject): Map<string, string[]> {
    const bound = new Map<string, string[]>();
    for (const scenario of project.scenarios) for (const id of scenario.surfaceIds ?? []) bound.set(id, [...(bound.get(id) ?? []), scenario.id]);
    return bound;
}
function projectMappings(project: E2eProject, known: readonly SurfaceRecord[]): SurfaceMapping[] {
    const bound = boundSurfaces(project);
    const mappings: SurfaceMapping[] = known.map(surface => { const scenarioIds = bound.get(surface.id) ?? []; return { surface, state: scenarioIds.length ? "explicit" : "unresolved", scenarioIds }; });
    for (const [id, scenarioIds] of bound) {
        if (known.some(surface => surface.id === id)) continue;
        mappings.push({ surface: { projectId: project.id, id, kind: "unknown", address: id, source: { path: ".interlinked/e2e-policy.json" }, discovery: { method: "policy", version: 1 } }, state: "dangling", scenarioIds });
    }
    return mappings;
}
/** Explicit only through `surfaceIds`; a literal in a test never maps (PE-63). Policy references the inventory lacks are dangling. */
export function mapSurfaces(inventory: SurfaceInventory, policy: E2ePolicy): SurfaceMapping[] {
    return policy.projects.flatMap(project => projectMappings(project, inventory.projects.find(row => row.projectId === project.id)?.surfaces ?? []));
}
/** Replaceable generated artifact (plan §5.2); never authority. Returns the project-relative path. */
export function writeSurfaceInventory(root: string, inventory: SurfaceInventory): string {
    const absolute = join(root, SURFACE_INVENTORY_PATH);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(inventory, null, 2)}\n`);
    return SURFACE_INVENTORY_PATH;
}
function mappingLine(mapping: SurfaceMapping): string {
    const method = mapping.surface.method ? ` ${mapping.surface.method}` : "";
    const bound = mapping.scenarioIds.length ? ` → ${mapping.scenarioIds.join(", ")}` : "";
    return `  ${mapping.surface.id} [${mapping.surface.kind}${method} ${mapping.surface.address}] ${mapping.state}${bound} (${mapping.surface.discovery.method}: ${mapping.surface.source.path})`;
}
export function formatSurfaces(inventory: SurfaceInventory, mappings: SurfaceMapping[]): string[] {
    return inventory.projects.flatMap(project => [
        `${project.projectId}: ${project.surfaces.length} surface(s), inventory ${project.complete ? "complete for the supported extractors" : "INCOMPLETE"}`,
        ...mappings.filter(row => row.surface.projectId === project.projectId).map(mappingLine),
        ...project.limits.map(limit => `  limit: ${limit}`),
    ]);
}
