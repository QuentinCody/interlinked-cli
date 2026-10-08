export interface EmbeddingInput {
    text: string;
    title?: string;
    role: "query" | "document" | "similarity";
}

export function isEmbeddingGemma2(model: string): boolean {
    const name = model.split("/").at(-1) ?? model;
    return /^embeddinggemma-2(?::|@|$)/.test(name);
}

/** Google's task instructions are part of the representation, not optional metadata. */
export function formatEmbeddingInputs(
    model: string,
    inputs: EmbeddingInput[],
): { texts: string[]; profile: string } {
    if (!isEmbeddingGemma2(model))
        return { texts: inputs.map((input) => input.text), profile: "raw-v1" };
    const families = new Set(
        inputs.map((input) => (input.role === "similarity" ? "similarity" : "code-retrieval")),
    );
    if (families.size > 1)
        throw new Error("similarity and retrieval embeddings require separate populations");
    const texts = inputs.map((input) => {
        switch (input.role) {
            case "query":
                return `task: code retrieval | query: ${input.text}`;
            case "document":
                return `title: ${input.title || "none"} | text: ${input.text}`;
            case "similarity":
                return `task: sentence similarity | query: ${input.text}`;
        }
    });
    return {
        texts,
        profile: `embeddinggemma-2-${families.values().next().value ?? "similarity"}-768d-v1`,
    };
}
