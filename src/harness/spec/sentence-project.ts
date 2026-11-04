import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { attachSentenceCitations, type CitationSource } from "./sentence-citations.js";
import { withCheckRoot } from "../checks/check-root.js";
import { parseSpecSentences, SENTENCE_GRAMMAR, type SentenceClass, type SpecSentence } from "./sentences.js";

export const SPEC_FILE_BYTES = 1024 * 1024;
export const SPEC_CITATION_FILES = 25_000;
const SKIP = new Set(["node_modules", "dist", "build", "coverage", "generated", "@codegen-data", "fixtures", "__fixtures__"]);
export interface SentenceScanIssue { file: string; reason: string; }
export function defaultSentenceDocs(root: string): string[] {
    let plans: string[] = [];
    try { plans = readdirSync(join(root, "docs/plans")).filter(name => name.endsWith(".md")).sort().map(name => `docs/plans/${name}`); }
    catch { plans = []; /* Missing standard docs are reported when read below. */ }
    return [...plans, "docs/project-e2e.md", "docs/harness.md", "CLAUDE.md"];
}
function safeFile(root: string, file: string): string {
    const path = resolve(root, file), rel = relative(root, path);
    if (!rel || rel.startsWith("../") || isAbsolute(rel)) throw new Error("outside repository root");
    // Resolve parent symlinks before reading. Never read dot-state or private configuration.
    if (rel.split(/[\\/]/).some(part => part.startsWith(".") || SKIP.has(part))) throw new Error("excluded path");
    const real = realpathSync(path), actual = relative(root, real);
    if (actual !== rel || lstatSync(path).isSymbolicLink()) throw new Error("symlink input excluded");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > SPEC_FILE_BYTES) throw new Error("not a regular file or exceeds 1 MiB cap");
    return path;
}
function* sources(root: string, issues: SentenceScanIssue[]): Generator<CitationSource> {
    let count = 0;
    function* walk(file: string): Generator<CitationSource> {
        if (count >= SPEC_CITATION_FILES) { issues.push({ file, reason: "citation file cap reached" }); return; }
        const path = join(root, file);
        let stat;
        try { stat = lstatSync(path); } catch { return; }
        if (stat.isSymbolicLink()) { issues.push({ file, reason: "symlink excluded" }); return; }
        if (stat.isDirectory()) {
            let names: string[];
            try { names = readdirSync(path).sort(); } catch { issues.push({ file, reason: "directory unreadable" }); return; }
            for (const name of names) {
                if (name.startsWith(".") || SKIP.has(name)) { issues.push({ file: `${file}/${name}`, reason: "excluded directory or dotfile" }); continue; }
                yield* walk(`${file}/${name}`);
            }
        } else if (/\.(?:[cm]?[jt]sx?|md)$/.test(file)) {
            count++;
            try { yield { file, content: readFileSync(safeFile(root, file), "utf8") }; }
            catch (error) { issues.push({ file, reason: error instanceof Error ? error.message : "unreadable source" }); }
        }
    }
    for (const dir of ["src", "test", "tests", "docs", "README.md", "CLAUDE.md"]) yield* walk(dir);
}
export function summarizeSentences(rows: SpecSentence[]) {
    const counts: Record<SentenceClass, number> = { requirement: 0, rationale: 0, example: 0, note: 0 };
    for (const row of rows) counts[row.class]++;
    const requirements = rows.filter(row => row.class === "requirement");
    const cited = requirements.filter(row => row.citations.length).length;
    const direct = requirements.filter(row => row.citations.some(citation => citation.scope === "sentence")).length;
    return { counts, requirementsWithCitation: cited, requirementCitationShare: requirements.length ? cited / requirements.length : null,
        requirementsWithDirectCitation: direct, directRequirementCitationShare: requirements.length ? direct / requirements.length : null,
        topUncited: requirements.filter(row => !row.citations.length).slice(0, 20).map(row => ({ id: row.id, line: row.line, sentence: row.sentence })) };
}
export function scanSpecSentences(root: string, files?: string[]) {
    root = realpathSync(root);
    const docs = [...new Set(files?.length ? files : defaultSentenceDocs(root))];
    const issues: SentenceScanIssue[] = [], rows: SpecSentence[] = [], manifest: { file: string; sha256: string; bytes: number }[] = [];
    for (const file of docs) {
        try {
            if (extname(file) !== ".md") throw new Error("expected Markdown file");
            const path = safeFile(root, file), doc = relative(root, path).replaceAll("\\", "/"), content = readFileSync(path, "utf8");
            rows.push(...parseSpecSentences(doc, content));
            manifest.push({ file: doc, sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content) });
        } catch (error) { issues.push({ file, reason: error instanceof Error ? error.message : "unreadable document" }); }
    }
    const citationRun = withCheckRoot(root, () => attachSentenceCitations(rows, sources(root, issues)));
    issues.push(...citationRun.result);
    const perDocument = manifest.map(doc => ({ ...doc, ...summarizeSentences(rows.filter(row => row.doc === doc.file)) }));
    return { schema: SENTENCE_GRAMMAR, advisory: true, complete: !issues.length, rows, summary: { ...summarizeSentences(rows), documents: perDocument, issues },
        limits: { perFileBytes: SPEC_FILE_BYTES, citationFiles: SPEC_CITATION_FILES },
        interpretation: "Lexical citations establish mention, not implementation or executable coverage. Section/document citations are context only. Uncited means no exact citation found in the bounded scan." };
}
