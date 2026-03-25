import { SemanticTokensBuilder, type SemanticTokens, type SemanticTokensLegend } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { VHDL_KEYWORDS } from "./ghdl";
import { resolveSemanticEntry, type SemanticSymbolIndex } from "./semanticResolver";

const TOKEN_TYPES = ["type", "function"] as const;

const TOKEN_TYPE_INDEX: Record<(typeof TOKEN_TYPES)[number], number> = {
    type: TOKEN_TYPES.indexOf("type"),
    function: TOKEN_TYPES.indexOf("function"),
};

const WORD_RE = /\b[a-zA-Z_]\w*\b/g;
const KEYWORD_SET = new Set(VHDL_KEYWORDS.map((keyword) => keyword.toLowerCase()));

interface OffsetRange {
    start: number;
    end: number;
}

function collectIgnoredRanges(text: string): OffsetRange[] {
    const ranges: OffsetRange[] = [];

    let i = 0;
    while (i < text.length) {
        const ch = text[i];

        if (ch === "-" && text[i + 1] === "-") {
            const start = i;
            i += 2;
            while (i < text.length && text[i] !== "\n") {
                i++;
            }
            ranges.push({ start, end: i });
            continue;
        }

        if (ch === '"') {
            const start = i;
            i++;
            while (i < text.length) {
                if (text[i] === '"') {
                    // VHDL string escaping uses doubled quotes.
                    if (text[i + 1] === '"') {
                        i += 2;
                        continue;
                    }

                    i++;
                    break;
                }
                i++;
            }
            ranges.push({ start, end: i });
            continue;
        }

        i++;
    }

    return ranges;
}

function isOffsetInIgnoredRanges(offset: number, ranges: OffsetRange[]): boolean {
    return ranges.some((range) => range.start <= offset && offset < range.end);
}

function skipWhitespaceForward(text: string, offset: number): number {
    let cursor = offset;
    while (cursor < text.length && /\s/.test(text[cursor])) {
        cursor++;
    }
    return cursor;
}

function isFunctionCallSite(text: string, endOffset: number): boolean {
    const next = skipWhitespaceForward(text, endOffset);
    return next < text.length && text[next] === "(";
}

function getTokenTypeIndex(
    text: string,
    startOffset: number,
    endOffset: number,
    entryKind: string
): number | null {
    if (entryKind === "type" || entryKind === "subtype") {
        return TOKEN_TYPE_INDEX.type;
    }

    if (entryKind === "function" && isFunctionCallSite(text, endOffset)) {
        return TOKEN_TYPE_INDEX.function;
    }

    return null;
}

export const VHDL_SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
    tokenTypes: [...TOKEN_TYPES],
    tokenModifiers: [],
};

export function buildDocumentSemanticTokens(
    document: TextDocument,
    index: SemanticSymbolIndex
): SemanticTokens {
    const text = document.getText();
    const ignoredRanges = collectIgnoredRanges(text);
    const builder = new SemanticTokensBuilder();

    let match: RegExpExecArray | null;
    while ((match = WORD_RE.exec(text)) !== null) {
        const word = match[0];
        const startOffset = match.index;
        const endOffset = startOffset + word.length;
        const wordLower = word.toLowerCase();

        if (KEYWORD_SET.has(wordLower) || isOffsetInIgnoredRanges(startOffset, ignoredRanges)) {
            continue;
        }

        const resolution = resolveSemanticEntry(
            text,
            startOffset,
            endOffset,
            document.uri,
            index
        );
        const entry = resolution.entry;
        if (!entry || !("kind" in entry)) {
            continue;
        }

        const tokenType = getTokenTypeIndex(text, startOffset, endOffset, entry.kind);
        if (tokenType == null) {
            continue;
        }

        const pos = document.positionAt(startOffset);
        builder.push(pos.line, pos.character, word.length, tokenType, 0);
    }

    return builder.build();
}
