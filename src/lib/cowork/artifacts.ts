import { lstatSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { inflateRawSync } from "node:zlib";
import { containsSecrets } from "../../harness/quality-checks/secret-detection.js";
import { digest } from "./receipts.js";

const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 4096;
export interface ArtifactFinding { check: string; severity: "error" | "warning"; message: string }
export interface ArtifactReport { path: string; sha256: string; status: "checked" | "unmeasured"; checks: string[]; findings: ArtifactFinding[]; limitations: string[] }

function zipDirectory(bytes: Buffer): { offset: number; count: number } {
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
        if (bytes.readUInt32LE(at) !== 0x06054b50) continue;
        if (at + 22 + bytes.readUInt16LE(at + 20) !== bytes.length) continue;
        if (bytes.readUInt16LE(at + 4) || bytes.readUInt16LE(at + 6)) throw new Error("Multi-disk ZIP unsupported");
        const count = bytes.readUInt16LE(at + 10);
        if (count > MAX_ZIP_ENTRIES) throw new Error("Office archive entry bound exceeded");
        return { offset: bytes.readUInt32LE(at + 16), count };
    }
    throw new Error("Office ZIP directory missing");
}

function xmlEntry(bytes: Buffer, at: number): { name: string; text: string; next: number; size: number } {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error("Invalid Office ZIP directory entry");
    const length = bytes.readUInt16LE(at + 28), packed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24);
    const name = bytes.subarray(at + 46, at + 46 + length).toString("utf8");
    const next = at + 46 + length + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    if (!/\.(xml|rels)$/.test(name)) return { name, text: "", next, size: 0 };
    if (size > MAX_XML_BYTES || bytes.readUInt16LE(at + 8) & 1) throw new Error("Encrypted or oversized Office XML");
    const local = bytes.readUInt32LE(at + 42), method = bytes.readUInt16LE(at + 10);
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error("Invalid Office ZIP local entry");
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + packed > bytes.length) throw new Error("Truncated Office XML");
    const compressed = bytes.subarray(start, start + packed);
    let data = compressed;
    if (method === 8) data = inflateRawSync(compressed, { maxOutputLength: MAX_XML_BYTES });
    else if (method !== 0) throw new Error("Unsupported Office ZIP compression");
    if (data.length !== size) throw new Error("Office XML length mismatch");
    return { name, text: data.toString("utf8"), next, size };
}

function officeText(bytes: Buffer, extension: string): { text: string; spreadsheetErrors: number } {
    const directory = zipDirectory(bytes), parts = new Map<string, string>();
    let at = directory.offset, total = 0;
    for (let index = 0; index < directory.count; index++) {
        const entry = xmlEntry(bytes, at);
        at = entry.next;
        total += entry.size;
        if (total > MAX_XML_BYTES) throw new Error("Office XML aggregate bound exceeded");
        if (parts.has(entry.name)) throw new Error("Duplicate Office ZIP entry");
        parts.set(entry.name, entry.text);
    }
    const required: Record<string, string> = { ".docx": "word/document.xml", ".xlsx": "xl/workbook.xml", ".pptx": "ppt/presentation.xml" };
    if (!parts.has("[Content_Types].xml") || !parts.has(required[extension] ?? "")) throw new Error("Office package required part missing");
    const xml = [...parts.values()].join("\n");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Office XML declarations unsupported");
    const spreadsheetErrors = [...parts.entries()].filter(([name]) => name.startsWith("xl/worksheets/")).reduce((count, [, text]) => count + (text.match(/<c\b[^>]*\bt=["']e["']/g)?.length ?? 0), 0);
    return { text: xml.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"), spreadsheetErrors };
}

/** Bounded structural and text checks; no formula calculation or factual certification. */
export function checkCoworkArtifact(path: string): ArtifactReport {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_BYTES) throw new Error("Artifact must be a regular file no larger than 32 MiB");
    const bytes = readFileSync(path), extension = extname(path).toLowerCase();
    const report: ArtifactReport = { path, sha256: digest(bytes), status: "checked", checks: [], findings: [],
        limitations: ["No factual/citation validation, formula recalculation, visual rendering, or publishing authorization."] };
    let text: string;
    if ([".docx", ".xlsx", ".pptx"].includes(extension)) {
        const office = officeText(bytes, extension);
        text = office.text;
        report.checks.push("office_zip_parts", "cached_spreadsheet_errors");
        report.limitations.push("Office inspection checks bounded ZIP/XML extraction and required parts; it does not validate CRCs, XML well-formedness, OPC relationships, macros, or document schemas.");
        if (office.spreadsheetErrors) report.findings.push({ check: "cached_spreadsheet_errors", severity: "error", message: `${office.spreadsheetErrors} spreadsheet cells contain cached error values` });
    } else if ([".md", ".txt", ".csv", ".tsv", ".html"].includes(extension)) text = bytes.toString("utf8");
    else return { ...report, status: "unmeasured", limitations: [...report.limitations, `Unsupported artifact format: ${extension}`] };
    report.checks.push("placeholder_text", "secret_patterns");
    if (/\b(?:TODO|TBD|FIXME|lorem ipsum)\b|\[INSERT[^\]]*\]/i.test(text)) report.findings.push({ check: "placeholder_text", severity: "warning", message: "Possible unfinished placeholder text; review in context" });
    if (containsSecrets(text).length) report.findings.push({ check: "secret_patterns", severity: "warning", message: "Credential-like material detected; inspect locally before sharing" });
    return report;
}
