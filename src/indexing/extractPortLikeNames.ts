import type { TextDocument } from "vscode-languageserver-textdocument";
import type { Range } from "vscode-languageserver/node";
import { findMatchingParen } from "./findMatching";

function rangeFromOffsets(doc: TextDocument, startOffset: number, endOffset: number): Range {
    return { start: doc.positionAt(startOffset), end: doc.positionAt(endOffset) };
}

export interface NameHit {
    name: string;
    startOffset: number;
    endOffset: number;
    range: Range;
    detail: string;
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

export function extractPortOrGenericNames(
    doc: TextDocument,
    openParenOffset: number
): { hits: NameHit[]; closeParenOffset: number } | null {
    const text = doc.getText();
    const closeParenOffset = findMatchingParen(text, openParenOffset);
    if (closeParenOffset == null) return null;

    const contentStart = openParenOffset + 1;
    const contentEnd = closeParenOffset; // exclusive
    const block = text.slice(contentStart, contentEnd);

    const hits: NameHit[] = [];

    // naive clause splitting by ';'
    let clauseStartRel = 0;
    for (let i = 0; i <= block.length; i++) {
        const isEnd = i === block.length;
        const isSemi = !isEnd && block[i] === ";";
        if (!isEnd && !isSemi) continue;

        const clause = block.slice(clauseStartRel, i);
        const colon = clause.indexOf(":");
        if (colon >= 0) {
            const namesPart = clause.slice(0, colon);
            const detail = normalizeWhitespace(clause.slice(colon + 1));
            const rawNames = namesPart.split(",").map(s => s.trim()).filter(Boolean);

            // compute absolute start of this clause
            const clauseAbsStart = contentStart + clauseStartRel;
            const clauseLower = clause.toLowerCase();

            let searchFrom = 0;
            for (const nm of rawNames) {
                if (!/^[a-zA-Z_]\w*$/.test(nm)) continue;
                const nmLower = nm.toLowerCase();

                const rel = clauseLower.indexOf(nmLower, searchFrom);
                if (rel < 0) continue;

                const startOffset = clauseAbsStart + rel;
                const endOffset = startOffset + nm.length;
                hits.push({
                    name: nm,
                    startOffset,
                    endOffset,
                    range: rangeFromOffsets(doc, startOffset, endOffset),
                    detail,
                });

                searchFrom = rel + nm.length;
            }
        }

        clauseStartRel = i + 1; // char after ';'
    }

    return { hits, closeParenOffset };
}