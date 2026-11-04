import { createHash } from "node:crypto";
import type { FunctionTokenEntry } from "../function-tokens/types.js";
import type { EmbeddingModelManifest, FunctionEmbeddingInput } from "./types.js";

function sha256(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeEmbeddingSource(source: string): string {
    return source.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[\t ]+$/g, "")).join("\n");
}

function normalizedSignature(code: string, language: string): string {
    const lines = code.split("\n");
    if (language === "python") {
        const signature: string[] = [];
        for (const line of lines) {
            signature.push(line.trim());
            if (line.trimEnd().endsWith(":")) break;
        }
        return signature.join(" ").trim();
    }
    const openingBrace = code.indexOf("{");
    if (openingBrace >= 0) return code.slice(0, openingBrace).replace(/\s+/g, " ").trim();
    return (lines[0] ?? "").trim();
}

function cleanBlockDocumentation(value: string): string {
    return normalizeEmbeddingSource(value)
        .split("\n")
        .map((line) => line.replace(/^\s*\*\s?/, ""))
        .join("\n")
        .trim();
}

function attachedDocumentation(content: string, entry: FunctionTokenEntry, code: string): string {
    if (entry.language === "python") {
        const match = /:\s*\n\s*(?:[rRuUbBfF]{0,2})(["']{3})([\s\S]*?)\1/.exec(code);
        return match?.[2] === undefined ? "" : normalizeEmbeddingSource(match[2]).trim();
    }
    const before = content.slice(0, entry.startOffset);
    // An earlier JSDoc block must not absorb intervening code while searching
    // for the final closing delimiter before this declaration.
    const match = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*$/.exec(before);
    return match?.[1] === undefined ? "" : cleanBlockDocumentation(match[1]);
}

export function embeddingInputPrefix(input: FunctionEmbeddingInput, manifest: EmbeddingModelManifest): string {
    return `${manifest.documentPrefix}language: ${input.language}\nsymbol: ${input.qualifiedName}\nkind: ${input.declarationKind}\nsignature:\n${input.signature}\ndocumentation:\n${input.documentation}\ncode:\n`;
}

export function buildFunctionEmbeddingInput(
    content: string,
    entry: FunctionTokenEntry,
    manifest: EmbeddingModelManifest,
): FunctionEmbeddingInput {
    const code = normalizeEmbeddingSource(content.slice(entry.startOffset, entry.endOffset));
    const provisional: FunctionEmbeddingInput = {
        language: entry.language,
        qualifiedName: entry.qualifiedName,
        declarationKind: entry.declarationKind,
        signature: normalizedSignature(code, entry.language),
        documentation: attachedDocumentation(content, entry, code),
        code,
        text: "",
        inputHash: "",
        contentHash: sha256(code),
    };
    provisional.text = `${embeddingInputPrefix(provisional, manifest)}${code}`;
    provisional.inputHash = sha256(provisional.text);
    return provisional;
}
