import { allowedPackageEntry, canonicalPackageName, type Allowlist } from "../package-allowlist.js";
import {
    isExactPinnedVersion,
    pinnedVersionViolation,
    type Ecosystem,
    type PackageSpec,
} from "../package-install-parser-shared.js";

/** Preserve constraints, rather than extracting a matching numeric substring. */
export function manifestPackageVersion(ecosystem: Ecosystem, name: string, value: string): string | undefined {
    const trimmed = value.trim();
    if (ecosystem === "pypi") return pythonManifestVersion(name, trimmed);
    if (ecosystem === "cargo") return quotedVersion(trimmed) ?? inlineVersion(trimmed);
    if (ecosystem === "rubygems") return quotedVersion(trimmed);
    return trimmed || undefined;
}

function quotedVersion(value: string): string | undefined {
    return value.match(/^(["'])([^"']*)\1$/)?.[2];
}

function inlineVersion(value: string): string | undefined {
    if (!value.startsWith("{") || !value.endsWith("}")) return undefined;
    const fields = inlineFields(value.slice(1, -1));
    return quotedVersion(fields?.get("version") ?? "");
}

/** Consume every field, so a quoted or nested value cannot masquerade as a key. */
function inlineFields(body: string): Map<string, string> | undefined {
    const matches = body.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|\[[^\]]*\]|true|false)/g);
    const fields = new Map<string, string>();
    let cursor = 0;
    let separator = "";
    for (const field of matches) {
        if (body.slice(cursor, field.index).trim() !== separator) return undefined;
        const name = field[1] ?? "";
        if (fields.has(name)) return undefined;
        fields.set(name, field[2] ?? "");
        cursor = field.index + field[0].length;
        separator = ",";
    }
    if (body.slice(cursor).trim()) return undefined;
    return fields;
}

function pythonManifestVersion(name: string, value: string): string | undefined {
    const literal = quotedVersion(value) ?? inlineVersion(value);
    if (literal !== undefined) return literal;
    // A PEP 508 marker is not a package constraint. In particular, never
    // borrow its == version when the dependency itself has no version.
    const requirement = value.split(";", 1)[0]?.trim() ?? "";
    const parts = requirement.match(/^([A-Za-z0-9._-]+)(?:\[[^\]]*\])?\s*(.*)$/);
    if (!parts?.[1] || canonicalPackageName("pypi", parts[1]) !== canonicalPackageName("pypi", name)) return undefined;
    const constraint = parts[2]?.replace(/^\((.*)\)$/, "$1").trim();
    if (!constraint || !/^(===|==|~=|!=|>=|<=|>|<)/.test(constraint)) return undefined;
    return constraint.replace(/^(===|==|~=|!=|>=|<=|>|<)\s+/, "$1");
}

/** Name-only and range approvals keep their existing manifest-edit contract. */
export function manifestExactApprovalViolation(
    allowlist: Allowlist,
    ecosystem: Ecosystem,
    spec: PackageSpec,
): string | null {
    if (spec.kind !== "registry") return null;
    const approved = allowedPackageEntry(allowlist, ecosystem, spec.name)?.version_range;
    if (!approved || !isExactPinnedVersion(approved, ecosystem)) return null;
    return pinnedVersionViolation(spec, ecosystem);
}
