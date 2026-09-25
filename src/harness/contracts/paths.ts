import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
export const CONTRACT_MANIFEST = ".interlinked/behavioral-contracts.json";
export const CONTRACT_POLICY = ".interlinked/contract-policy.json";
export const MAX_CONTRACT_BYTES = 1024 * 1024;
export function contractDigest(value: unknown): string {
    if (Buffer.isBuffer(value)) return createHash("sha256").update(value).digest("hex");
    return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}
export function contractPath(root: string, path: string): string {
    if (!path || isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).includes("..")) throw new Error(`Not a project-relative contract path: ${path}`);
    const absolute = resolve(root, path), rel = relative(root, absolute);
    if (!rel || isAbsolute(rel) || rel.startsWith("../")) throw new Error("Contract path escapes project");
    return absolute;
}
/** Confined, bounded, symlink-free read of raw bytes (binary-safe: compiled executables are contract inputs too). */
export function readContractBytes(root: string, path: string, limit = MAX_CONTRACT_BYTES): { bytes: Buffer; mode: number } {
    const absolute = contractPath(realpathSync(root), path);
    if (realpathSync(absolute) !== absolute) throw new Error(`Contract input crosses a symlink: ${path}`);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.size > limit) throw new Error(`Contract input is not a regular file within budget: ${path}`);
    const bytes = readFileSync(absolute);
    if (bytes.byteLength > limit) throw new Error(`Contract input grew beyond budget: ${path}`);
    return { bytes, mode: stat.mode & 0o777 };
}
/** Text read for manifests, policies and cited requirement documents; non-UTF-8 content is refused. */
export function readContractFile(root: string, path: string, limit = MAX_CONTRACT_BYTES): string {
    const { bytes } = readContractBytes(root, path, limit), content = bytes.toString("utf8");
    if (!Buffer.from(content).equals(bytes)) throw new Error(`Contract input is not UTF-8 text: ${path}`);
    return content;
}
