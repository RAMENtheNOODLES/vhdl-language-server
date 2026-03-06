import type { TextDocument } from "vscode-languageserver-textdocument";
import type { Range } from "vscode-languageserver/node";
import { findEntityHeaders, findComponentHeaders } from "./extractHeader";
import { extractPortOrGenericNames } from "./extractPortLikeNames";
import { rangeFromOffsets } from "./textDocUtils";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface PortGenericEntry {
    name: string;
    nameLower: string;
    kind: "port" | "generic";
    startOffset: number;
    endOffset: number;
    range: Range;
}

export interface DesignUnitEntry {
    name: string;
    nameLower: string;
    kind: "entity" | "component";
    uri: string;
    /** Offset of the identifier name token (start inclusive) */
    nameStartOffset: number;
    /** Offset of the identifier name token (end exclusive) */
    nameEndOffset: number;
    nameRange: Range;
    /** Offset of the opening keyword (entity/component) */
    blockStartOffset: number;
    /** Offset of the end of the closing statement */
    blockEndOffset: number;
    blockRange: Range;
    ports: PortGenericEntry[];
    generics: PortGenericEntry[];
}

export interface LocalDecl {
    name: string;
    nameLower: string;
    kind: "signal" | "variable" | "constant";
    startOffset: number;
    endOffset: number;
    range: Range;
}

export interface IndexResult {
    entities: DesignUnitEntry[];
    components: DesignUnitEntry[];
    locals: LocalDecl[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the offset just past the end of an entity or component block.
 * Looks for:  end [entity|component] [name] ;
 */
function findBlockEnd(text: string, afterOffset: number, kind: "entity" | "component"): number {
    // Searching only from after the header to the end of text
    const sub = text.slice(afterOffset);
    // Match: end  entity/component  optional-name  ;
    const re = new RegExp(
        `\\bend\\s+(?:${kind}\\s+\\w+|${kind}|\\w+)\\s*;`,
        "im"
    );
    const m = re.exec(sub);
    if (m) return afterOffset + m.index + m[0].length;
    // Fallback: just "end ;"
    const fallback = /\bend\s*;/im.exec(sub);
    if (fallback) return afterOffset + fallback.index + fallback[0].length;
    return text.length;
}

/**
 * Extract port or generic names from the first occurrence of the given keyword
 * within [blockStart, blockEnd) of the text.
 */
function extractPortLike(
    doc: TextDocument,
    text: string,
    blockStart: number,
    blockEnd: number,
    keyword: "port" | "generic"
): PortGenericEntry[] {
    const pattern = new RegExp(`\\b${keyword}\\s*\\(`, "im");
    const sub = text.slice(blockStart, blockEnd);
    const m = pattern.exec(sub);
    if (!m) return [];

    // Offset of '(' in the original text
    const openParenOffset = blockStart + m.index + m[0].length - 1;
    const result = extractPortOrGenericNames(doc, openParenOffset);
    if (!result) return [];

    return result.hits.map((h) => ({
        name: h.name,
        nameLower: h.name.toLowerCase(),
        kind: keyword,
        startOffset: h.startOffset,
        endOffset: h.endOffset,
        range: h.range,
    }));
}

// ---------------------------------------------------------------------------
// Main indexText function
// ---------------------------------------------------------------------------

export function indexText(doc: TextDocument): IndexResult {
    const text = doc.getText();
    const uri = doc.uri;

    // --- entities ---
    const entityHeaders = findEntityHeaders(doc);
    const entities: DesignUnitEntry[] = entityHeaders.map((h) => {
        const blockEnd = findBlockEnd(text, h.startOffset, "entity");
        const blockStartOffset = (() => {
            // Walk back to find the 'entity' keyword offset
            const before = text.slice(0, h.startOffset).toLowerCase();
            const idx = before.lastIndexOf("entity");
            return idx >= 0 ? idx : h.startOffset;
        })();
        return {
            name: h.name,
            nameLower: h.name.toLowerCase(),
            kind: "entity",
            uri,
            nameStartOffset: h.startOffset,
            nameEndOffset: h.endOffset,
            nameRange: h.range,
            blockStartOffset,
            blockEndOffset: blockEnd,
            blockRange: rangeFromOffsets(doc, blockStartOffset, blockEnd),
            ports: extractPortLike(doc, text, h.startOffset, blockEnd, "port"),
            generics: extractPortLike(doc, text, h.startOffset, blockEnd, "generic"),
        };
    });

    // --- components ---
    const componentHeaders = findComponentHeaders(doc);
    const components: DesignUnitEntry[] = componentHeaders.map((h) => {
        const blockEnd = findBlockEnd(text, h.startOffset, "component");
        const blockStartOffset = (() => {
            const before = text.slice(0, h.startOffset).toLowerCase();
            const idx = before.lastIndexOf("component");
            return idx >= 0 ? idx : h.startOffset;
        })();
        return {
            name: h.name,
            nameLower: h.name.toLowerCase(),
            kind: "component",
            uri,
            nameStartOffset: h.startOffset,
            nameEndOffset: h.endOffset,
            nameRange: h.range,
            blockStartOffset,
            blockEndOffset: blockEnd,
            blockRange: rangeFromOffsets(doc, blockStartOffset, blockEnd),
            ports: extractPortLike(doc, text, h.startOffset, blockEnd, "port"),
            generics: extractPortLike(doc, text, h.startOffset, blockEnd, "generic"),
        };
    });

    // --- local declarations ---
    const localPatterns: Array<{ re: RegExp; kind: LocalDecl["kind"] }> = [
        { re: /\bsignal\s+(\w+)\b/gim, kind: "signal" },
        { re: /\bvariable\s+(\w+)\b/gim, kind: "variable" },
        { re: /\bconstant\s+(\w+)\b/gim, kind: "constant" },
    ];
    const locals: LocalDecl[] = [];
    for (const { re, kind } of localPatterns) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const name = m[1];
            // m[0] ends with the captured name, so startOffset = m.index + m[0].length - name.length
            const startOffset = m.index + m[0].length - name.length;
            const endOffset = startOffset + name.length;
            locals.push({
                name,
                nameLower: name.toLowerCase(),
                kind,
                startOffset,
                endOffset,
                range: rangeFromOffsets(doc, startOffset, endOffset),
            });
        }
    }

    return { entities, components, locals };
}