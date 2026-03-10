import type { TextDocument } from "vscode-languageserver-textdocument";
import type { Range } from "vscode-languageserver/node";
import { findEntityHeaders, findComponentHeaders } from "./extractHeader";
import { extractPortOrGenericNames } from "./extractPortLikeNames";
import { findMatchingParen } from "./findMatching";
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
    signature: string;
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
    signature: string;
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
    signature: string;
}

export interface CallableParameterEntry {
    name: string;
    nameLower: string;
    kind: "parameter";
    startOffset: number;
    endOffset: number;
    range: Range;
    signature: string;
}

export interface CallableEntry {
    name: string;
    nameLower: string;
    kind: "function" | "procedure";
    uri: string;
    nameStartOffset: number;
    nameEndOffset: number;
    nameRange: Range;
    signature: string;
    blockStartOffset: number;
    blockEndOffset: number;
    bodyStartOffset: number | null;
    params: CallableParameterEntry[];
}

export interface IndexResult {
    entities: DesignUnitEntry[];
    components: DesignUnitEntry[];
    locals: LocalDecl[];
    callables: CallableEntry[];
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
        signature: buildObjectSignature(keyword, h.name, h.detail),
    }));
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function buildObjectSignature(
    kind: PortGenericEntry["kind"] | LocalDecl["kind"] | CallableParameterEntry["kind"],
    name: string,
    detail: string
): string {
    const normalizedDetail = normalizeWhitespace(detail);
    if (normalizedDetail.length === 0) {
        return `${kind} ${name}`;
    }
    return `${kind} ${name} : ${normalizedDetail}`;
}

function previousWord(text: string, offset: number): string {
    let index = offset - 1;
    while (index >= 0 && /\s/.test(text[index])) {
        index--;
    }

    const end = index + 1;
    while (index >= 0 && /\w/.test(text[index])) {
        index--;
    }

    return text.slice(index + 1, end).toLowerCase();
}

function skipWhitespace(text: string, offset: number): number {
    let index = offset;
    while (index < text.length && /\s/.test(text[index])) {
        index++;
    }
    return index;
}

function isWordBoundary(text: string, offset: number, word: string): boolean {
    const before = offset > 0 ? text[offset - 1] : "";
    const afterOffset = offset + word.length;
    const after = afterOffset < text.length ? text[afterOffset] : "";
    const isWord = (value: string) => /\w/.test(value);

    return !isWord(before) && !isWord(after);
}

function scanCallableHeader(
    text: string,
    afterNameOffset: number
): { signatureEndOffset: number; bodyStartOffset: number | null; terminatorOffset: number } | null {
    let depth = 0;

    for (let i = afterNameOffset; i < text.length; i++) {
        const char = text[i];

        if (char === "-" && text[i + 1] === "-") {
            while (i < text.length && text[i] !== "\n") {
                i++;
            }
            continue;
        }

        if (char === "(") {
            depth++;
            continue;
        }

        if (char === ")") {
            depth = Math.max(0, depth - 1);
            continue;
        }

        if (depth !== 0) {
            continue;
        }

        if (char === ";") {
            return {
                signatureEndOffset: i,
                bodyStartOffset: null,
                terminatorOffset: i + 1,
            };
        }

        if (
            char.toLowerCase() === "i" &&
            text.slice(i, i + 2).toLowerCase() === "is" &&
            isWordBoundary(text, i, "is")
        ) {
            return {
                signatureEndOffset: i,
                bodyStartOffset: i + 2,
                terminatorOffset: i + 2,
            };
        }
    }

    return null;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findCallableBlockEnd(
    text: string,
    afterOffset: number,
    kind: CallableEntry["kind"],
    name: string
): number {
    const escapedName = escapeRegExp(name);
    const sub = text.slice(afterOffset);
    const re = new RegExp(
        `\\bend\\s+(?:${kind}\\s+${escapedName}|${kind}|${escapedName})\\s*;`,
        "im"
    );
    const match = re.exec(sub);
    if (match) {
        return afterOffset + match.index + match[0].length;
    }

    return text.length;
}

function extractCallableParams(
    doc: TextDocument,
    openParenOffset: number
): { params: CallableParameterEntry[]; closeParenOffset: number } | null {
    const text = doc.getText();
    const closeParenOffset = findMatchingParen(text, openParenOffset);
    if (closeParenOffset == null) {
        return null;
    }

    const contentStart = openParenOffset + 1;
    const block = text.slice(contentStart, closeParenOffset);
    const params: CallableParameterEntry[] = [];

    let clauseStartRel = 0;
    for (let i = 0; i <= block.length; i++) {
        const isEnd = i === block.length;
        const isSemi = !isEnd && block[i] === ";";
        if (!isEnd && !isSemi) {
            continue;
        }

        const clause = block.slice(clauseStartRel, i);
        const colon = clause.indexOf(":");
        if (colon >= 0) {
            const clauseAbsStart = contentStart + clauseStartRel;
            const detail = normalizeWhitespace(clause.slice(colon + 1));
            const namesPart = clause.slice(0, colon);
            const namesSource = namesPart.replace(/^\s*(signal|variable|constant|file)\s+/i, "");
            const rawNames = namesSource
                .split(",")
                .map((name) => name.trim())
                .filter(Boolean);

            const clauseLower = clause.toLowerCase();
            let searchFrom = 0;

            for (const name of rawNames) {
                if (!/^[a-zA-Z_]\w*$/.test(name)) {
                    continue;
                }

                const rel = clauseLower.indexOf(name.toLowerCase(), searchFrom);
                if (rel < 0) {
                    continue;
                }

                const startOffset = clauseAbsStart + rel;
                const endOffset = startOffset + name.length;
                params.push({
                    name,
                    nameLower: name.toLowerCase(),
                    kind: "parameter",
                    startOffset,
                    endOffset,
                    range: rangeFromOffsets(doc, startOffset, endOffset),
                    signature: buildObjectSignature("parameter", name, detail),
                });

                searchFrom = rel + name.length;
            }
        }

        clauseStartRel = i + 1;
    }

    return {
        closeParenOffset,
        params,
    };
}

function extractLocalDecls(doc: TextDocument, text: string): LocalDecl[] {
    const locals: LocalDecl[] = [];
    const declRe = /\b(signal|variable|constant)\s+([\s\S]*?)\s*:\s*([\s\S]*?);/gim;

    let m: RegExpExecArray | null;
    while ((m = declRe.exec(text)) !== null) {
        const kind = m[1].toLowerCase() as LocalDecl["kind"];
        const namesPart = m[2];
        const detail = normalizeWhitespace(m[3]);
        const rawNames = namesPart
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean);

        const fullMatch = m[0];
        const namesPartStart = fullMatch.indexOf(namesPart);
        if (namesPartStart < 0) continue;

        const namesPartLower = namesPart.toLowerCase();
        const namesAbsStart = m.index + namesPartStart;
        let searchFrom = 0;

        for (const name of rawNames) {
            if (!/^[a-zA-Z_]\w*$/.test(name)) continue;

            const rel = namesPartLower.indexOf(name.toLowerCase(), searchFrom);
            if (rel < 0) continue;

            const startOffset = namesAbsStart + rel;
            const endOffset = startOffset + name.length;
            locals.push({
                name,
                nameLower: name.toLowerCase(),
                kind,
                startOffset,
                endOffset,
                range: rangeFromOffsets(doc, startOffset, endOffset),
                signature: buildObjectSignature(kind, name, detail),
            });

            searchFrom = rel + name.length;
        }
    }

    return locals;
}

function extractCallables(doc: TextDocument, text: string): CallableEntry[] {
    const callables: CallableEntry[] = [];
    const callableRe = /\b(?:impure\s+|pure\s+)?(function|procedure)\s+(\w+)\b/gim;

    let match: RegExpExecArray | null;
    while ((match = callableRe.exec(text)) !== null) {
        if (previousWord(text, match.index) === "end") {
            continue;
        }

        const kind = match[1].toLowerCase() as CallableEntry["kind"];
        const name = match[2];
        const fullMatch = match[0];
        const nameStartRel = fullMatch.toLowerCase().lastIndexOf(name.toLowerCase());
        if (nameStartRel < 0) {
            continue;
        }

        const nameStartOffset = match.index + nameStartRel;
        const nameEndOffset = nameStartOffset + name.length;
        let cursor = skipWhitespace(text, nameEndOffset);
        let params: CallableParameterEntry[] = [];

        if (text[cursor] === "(") {
            const paramResult = extractCallableParams(doc, cursor);
            if (paramResult) {
                params = paramResult.params;
                cursor = paramResult.closeParenOffset + 1;
            } else {
                const closeParenOffset = findMatchingParen(text, cursor);
                if (closeParenOffset == null) {
                    continue;
                }
                cursor = closeParenOffset + 1;
            }
        }

        const header = scanCallableHeader(text, cursor);
        if (!header) {
            continue;
        }

        const blockEndOffset = header.bodyStartOffset !== null
            ? findCallableBlockEnd(text, header.bodyStartOffset, kind, name)
            : header.terminatorOffset;

        callables.push({
            name,
            nameLower: name.toLowerCase(),
            kind,
            uri: doc.uri,
            nameStartOffset,
            nameEndOffset,
            nameRange: rangeFromOffsets(doc, nameStartOffset, nameEndOffset),
            signature: normalizeWhitespace(text.slice(match.index, header.signatureEndOffset)),
            blockStartOffset: match.index,
            blockEndOffset,
            bodyStartOffset: header.bodyStartOffset,
            params,
        });
    }

    return callables;
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
            signature: `entity ${h.name}`,
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
            signature: `component ${h.name}`,
            blockStartOffset,
            blockEndOffset: blockEnd,
            blockRange: rangeFromOffsets(doc, blockStartOffset, blockEnd),
            ports: extractPortLike(doc, text, h.startOffset, blockEnd, "port"),
            generics: extractPortLike(doc, text, h.startOffset, blockEnd, "generic"),
        };
    });

    // --- local declarations ---
    const locals = extractLocalDecls(doc, text);
    const callables = extractCallables(doc, text);

    return { entities, components, locals, callables };
}