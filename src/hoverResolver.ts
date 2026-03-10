import {
    resolveSemanticEntry,
    type SemanticEntry,
    type SemanticSymbolIndex,
} from "./semanticResolver";

export type HoverSymbolIndex = SemanticSymbolIndex;
export type HoverEntry = SemanticEntry;

export function resolveHoverEntry(
    text: string,
    wordStart: number,
    wordEnd: number,
    currentUri: string,
    index: HoverSymbolIndex
): HoverEntry | null {
    return resolveSemanticEntry(text, wordStart, wordEnd, currentUri, index).entry;
}

export function formatHoverMarkdown(entry: HoverEntry): string {
    return ["```vhdl", entry.signature, "```"].join("\n");
}