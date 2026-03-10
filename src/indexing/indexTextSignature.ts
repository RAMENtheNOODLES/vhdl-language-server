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

export interface PackageMemberEntry {
    name: string;
    nameLower: string;
    kind:
    | "constant"
    | "type"
    | "subtype"
    | "function"
    | "procedure"
    | "component"
    | "alias";
    uri: string;
    startOffset: number;
    endOffset: number;
    range: Range;
    signature: string;
    packageName: string;
    packageNameLower: string;
    visibility: "public" | "body";
}

export interface PackageEntry {
    name: string;
    nameLower: string;
    kind: "package" | "package_body";
    uri: string;
    nameStartOffset: number;
    nameEndOffset: number;
    nameRange: Range;
    signature: string;
    blockStartOffset: number;
    blockEndOffset: number;
    blockRange: Range;
    members: PackageMemberEntry[];
}

export interface LibraryClauseEntry {
    name: string;
    nameLower: string;
    uri: string;
    startOffset: number;
    endOffset: number;
    range: Range;
    clauseStartOffset: number;
    clauseEndOffset: number;
    signature: string;
}

export interface UseClauseEntry {
    uri: string;
    startOffset: number;
    endOffset: number;
    range: Range;
    clauseStartOffset: number;
    clauseEndOffset: number;
    pathSegments: string[];
    pathSegmentsLower: string[];
    libraryName: string | null;
    libraryNameLower: string | null;
    packageName: string | null;
    packageNameLower: string | null;
    memberName: string | null;
    memberNameLower: string | null;
    isAll: boolean;
    signature: string;
}

export interface TopLevelUnitEntry {
    kind: "entity" | "architecture" | "package" | "package_body";
    name: string;
    nameLower: string;
    uri: string;
    blockStartOffset: number;
    blockEndOffset: number;
    entityNameLower?: string;
}

export interface IndexResult {
    entities: DesignUnitEntry[];
    components: DesignUnitEntry[];
    locals: LocalDecl[];
    callables: CallableEntry[];
    packages: PackageEntry[];
    packageBodies: PackageEntry[];
    libraryClauses: LibraryClauseEntry[];
    useClauses: UseClauseEntry[];
    topLevelUnits: TopLevelUnitEntry[];
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

function isOffsetWithinRanges(
    offset: number,
    ranges: Array<{ start: number; end: number }>
): boolean {
    return ranges.some((range) => range.start <= offset && offset < range.end);
}

function isRangeWithinRanges(
    startOffset: number,
    endOffset: number,
    ranges: Array<{ start: number; end: number }>
): boolean {
    return ranges.some(
        (range) => range.start <= startOffset && endOffset <= range.end
    );
}

function findNamedBlockEnd(text: string, afterOffset: number, patterns: string[]): number {
    const sub = text.slice(afterOffset);
    let bestEnd = text.length;

    for (const pattern of patterns) {
        const match = new RegExp(pattern, "im").exec(sub);
        if (!match) {
            continue;
        }

        const endOffset = afterOffset + match.index + match[0].length;
        if (endOffset < bestEnd) {
            bestEnd = endOffset;
        }
    }

    return bestEnd;
}

function findPackageBlockEnd(
    text: string,
    afterOffset: number,
    name: string,
    kind: PackageEntry["kind"]
): number {
    const escapedName = escapeRegExp(name);
    if (kind === "package_body") {
        return findNamedBlockEnd(text, afterOffset, [
            `\\bend\\s+package\\s+body\\s+${escapedName}\\s*;`,
            `\\bend\\s+package\\s+body\\s*;`,
            `\\bend\\s+body\\s+${escapedName}\\s*;`,
            `\\bend\\s+body\\s*;`,
            `\\bend\\s+${escapedName}\\s*;`,
        ]);
    }

    return findNamedBlockEnd(text, afterOffset, [
        `\\bend\\s+package\\s+${escapedName}\\s*;`,
        `\\bend\\s+package\\s*;`,
        `\\bend\\s+${escapedName}\\s*;`,
    ]);
}

function findArchitectureBlockEnd(text: string, afterOffset: number, name: string): number {
    const escapedName = escapeRegExp(name);
    return findNamedBlockEnd(text, afterOffset, [
        `\\bend\\s+architecture\\s+${escapedName}\\s*;`,
        `\\bend\\s+architecture\\s*;`,
        `\\bend\\s+${escapedName}\\s*;`,
    ]);
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

function extractLibraryClauses(doc: TextDocument, text: string): LibraryClauseEntry[] {
    const libraries: LibraryClauseEntry[] = [];
    const libraryRe = /\blibrary\s+([\s\S]*?);/gim;

    let match: RegExpExecArray | null;
    while ((match = libraryRe.exec(text)) !== null) {
        const namesPart = match[1];
        const namesPartLower = namesPart.toLowerCase();
        const clauseStartOffset = match.index;
        const clauseEndOffset = match.index + match[0].length;
        const rawNames = namesPart
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean);

        const namesPartStart = match[0].toLowerCase().indexOf(namesPartLower);
        if (namesPartStart < 0) {
            continue;
        }

        const namesAbsStart = match.index + namesPartStart;
        let searchFrom = 0;

        for (const name of rawNames) {
            if (!/^[a-zA-Z_]\w*$/.test(name)) {
                continue;
            }

            const rel = namesPartLower.indexOf(name.toLowerCase(), searchFrom);
            if (rel < 0) {
                continue;
            }

            const startOffset = namesAbsStart + rel;
            const endOffset = startOffset + name.length;
            libraries.push({
                name,
                nameLower: name.toLowerCase(),
                uri: doc.uri,
                startOffset,
                endOffset,
                range: rangeFromOffsets(doc, startOffset, endOffset),
                clauseStartOffset,
                clauseEndOffset,
                signature: `library ${name}`,
            });
            searchFrom = rel + name.length;
        }
    }

    return libraries;
}

function parseUseClauseItem(value: string): Omit<
    UseClauseEntry,
    "uri" | "startOffset" | "endOffset" | "range" | "clauseStartOffset" | "clauseEndOffset" | "signature"
> | null {
    const pathSegments = value
        .split(".")
        .map((segment) => segment.trim())
        .filter(Boolean);
    if (pathSegments.length === 0) {
        return null;
    }

    const pathSegmentsLower = pathSegments.map((segment) => segment.toLowerCase());
    const lastSegmentLower = pathSegmentsLower[pathSegmentsLower.length - 1];
    const isAll = lastSegmentLower === "all";

    let libraryName: string | null = null;
    let packageName: string | null = null;
    let memberName: string | null = null;

    if (isAll) {
        if (pathSegments.length >= 3) {
            libraryName = pathSegments[0];
            packageName = pathSegments[1];
        } else {
            packageName = pathSegments[0];
        }
    } else if (pathSegments.length >= 3) {
        libraryName = pathSegments[0];
        packageName = pathSegments[1];
        memberName = pathSegments[2];
    } else if (pathSegments.length === 2) {
        packageName = pathSegments[0];
        memberName = pathSegments[1];
    } else {
        packageName = pathSegments[0];
    }

    return {
        pathSegments,
        pathSegmentsLower,
        libraryName,
        libraryNameLower: libraryName ? libraryName.toLowerCase() : null,
        packageName,
        packageNameLower: packageName ? packageName.toLowerCase() : null,
        memberName,
        memberNameLower: memberName ? memberName.toLowerCase() : null,
        isAll,
    };
}

function extractUseClauses(doc: TextDocument, text: string): UseClauseEntry[] {
    const uses: UseClauseEntry[] = [];
    const useRe = /\buse\s+([\s\S]*?);/gim;

    let match: RegExpExecArray | null;
    while ((match = useRe.exec(text)) !== null) {
        const namesPart = match[1];
        const namesPartLower = namesPart.toLowerCase();
        const clauseStartOffset = match.index;
        const clauseEndOffset = match.index + match[0].length;
        const rawItems = namesPart
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);

        const namesPartStart = match[0].toLowerCase().indexOf(namesPartLower);
        if (namesPartStart < 0) {
            continue;
        }

        const namesAbsStart = match.index + namesPartStart;
        let searchFrom = 0;

        for (const item of rawItems) {
            const parsed = parseUseClauseItem(item);
            if (!parsed) {
                continue;
            }

            const rel = namesPartLower.indexOf(item.toLowerCase(), searchFrom);
            if (rel < 0) {
                continue;
            }

            const startOffset = namesAbsStart + rel;
            const endOffset = startOffset + item.length;
            uses.push({
                uri: doc.uri,
                startOffset,
                endOffset,
                range: rangeFromOffsets(doc, startOffset, endOffset),
                clauseStartOffset,
                clauseEndOffset,
                signature: `use ${normalizeWhitespace(item)}`,
                ...parsed,
            });
            searchFrom = rel + item.length;
        }
    }

    return uses;
}

function findArchitectureUnits(text: string, uri: string): TopLevelUnitEntry[] {
    const units: TopLevelUnitEntry[] = [];
    const architectureRe = /\barchitecture\s+(\w+)\s+of\s+(\w+)\s+is\b/gim;

    let match: RegExpExecArray | null;
    while ((match = architectureRe.exec(text)) !== null) {
        const name = match[1];
        units.push({
            kind: "architecture",
            name,
            nameLower: name.toLowerCase(),
            uri,
            blockStartOffset: match.index,
            blockEndOffset: findArchitectureBlockEnd(text, architectureRe.lastIndex, name),
            entityNameLower: match[2].toLowerCase(),
        });
    }

    return units;
}

function findPackageHeaders(
    doc: TextDocument,
    text: string,
    kind: PackageEntry["kind"]
): Array<{ name: string; startOffset: number; endOffset: number; range: Range; blockStartOffset: number }> {
    const hits: Array<{ name: string; startOffset: number; endOffset: number; range: Range; blockStartOffset: number }> = [];
    const re = kind === "package_body"
        ? /\bpackage\s+body\s+(\w+)\s+is\b/gim
        : /\bpackage\s+(?!body\b)(\w+)\s+is\b/gim;

    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const full = match[0];
        const name = match[1];
        const nameStartRel = full.toLowerCase().lastIndexOf(name.toLowerCase());
        if (nameStartRel < 0) {
            continue;
        }

        const startOffset = match.index + nameStartRel;
        const endOffset = startOffset + name.length;
        hits.push({
            name,
            startOffset,
            endOffset,
            range: rangeFromOffsets(doc, startOffset, endOffset),
            blockStartOffset: match.index,
        });
    }

    return hits;
}

function filterTopLevelCallables(entries: CallableEntry[]): CallableEntry[] {
    return entries.filter(
        (entry) =>
            !entries.some(
                (other) =>
                    other !== entry &&
                    other.bodyStartOffset !== null &&
                    other.blockStartOffset < entry.blockStartOffset &&
                    entry.blockEndOffset <= other.blockEndOffset
            )
    );
}

function makePackageMemberEntry(
    doc: TextDocument,
    packageName: string,
    visibility: PackageMemberEntry["visibility"],
    kind: PackageMemberEntry["kind"],
    name: string,
    startOffset: number,
    endOffset: number,
    signature: string
): PackageMemberEntry {
    return {
        name,
        nameLower: name.toLowerCase(),
        kind,
        uri: doc.uri,
        startOffset,
        endOffset,
        range: rangeFromOffsets(doc, startOffset, endOffset),
        signature,
        packageName,
        packageNameLower: packageName.toLowerCase(),
        visibility,
    };
}

function extractPackageConstantMembers(
    doc: TextDocument,
    text: string,
    blockStart: number,
    blockEnd: number,
    packageName: string,
    visibility: PackageMemberEntry["visibility"],
    excludedRanges: Array<{ start: number; end: number }>
): PackageMemberEntry[] {
    const members: PackageMemberEntry[] = [];
    const block = text.slice(blockStart, blockEnd);
    const declRe = /\bconstant\s+([\s\S]*?)\s*:\s*([\s\S]*?);/gim;

    let match: RegExpExecArray | null;
    while ((match = declRe.exec(block)) !== null) {
        const absMatchStart = blockStart + match.index;
        if (isOffsetWithinRanges(absMatchStart, excludedRanges)) {
            continue;
        }

        const namesPart = match[1];
        const detail = normalizeWhitespace(match[2]);
        const rawNames = namesPart
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean);
        const namesPartStart = match[0].indexOf(namesPart);
        if (namesPartStart < 0) {
            continue;
        }

        const namesAbsStart = absMatchStart + namesPartStart;
        const namesPartLower = namesPart.toLowerCase();
        let searchFrom = 0;

        for (const name of rawNames) {
            if (!/^[a-zA-Z_]\w*$/.test(name)) {
                continue;
            }

            const rel = namesPartLower.indexOf(name.toLowerCase(), searchFrom);
            if (rel < 0) {
                continue;
            }

            const startOffset = namesAbsStart + rel;
            const endOffset = startOffset + name.length;
            members.push(
                makePackageMemberEntry(
                    doc,
                    packageName,
                    visibility,
                    "constant",
                    name,
                    startOffset,
                    endOffset,
                    buildObjectSignature("constant", name, detail)
                )
            );
            searchFrom = rel + name.length;
        }
    }

    return members;
}

function extractSimpleNamedMembers(
    doc: TextDocument,
    text: string,
    blockStart: number,
    blockEnd: number,
    packageName: string,
    visibility: PackageMemberEntry["visibility"],
    excludedRanges: Array<{ start: number; end: number }>,
    re: RegExp,
    kind: Extract<PackageMemberEntry["kind"], "subtype" | "alias">
): PackageMemberEntry[] {
    const members: PackageMemberEntry[] = [];
    const block = text.slice(blockStart, blockEnd);

    let match: RegExpExecArray | null;
    while ((match = re.exec(block)) !== null) {
        const absMatchStart = blockStart + match.index;
        if (isOffsetWithinRanges(absMatchStart, excludedRanges)) {
            continue;
        }

        const name = match[1];
        const nameStartRel = match[0].toLowerCase().indexOf(name.toLowerCase());
        if (nameStartRel < 0) {
            continue;
        }

        const startOffset = absMatchStart + nameStartRel;
        const endOffset = startOffset + name.length;
        members.push(
            makePackageMemberEntry(
                doc,
                packageName,
                visibility,
                kind,
                name,
                startOffset,
                endOffset,
                normalizeWhitespace(match[0].slice(0, -1))
            )
        );
    }

    return members;
}

function findTypeDeclarationEnd(text: string, startOffset: number, blockEnd: number): number {
    const tail = text.slice(startOffset, blockEnd);
    const recordEnd = /\bend\s+record\b\s*;/im.exec(tail);
    if (/\bis\s+record\b/im.test(tail) && recordEnd) {
        return startOffset + recordEnd.index + recordEnd[0].length;
    }

    const protectedEnd = /\bend\s+protected(?:\s+body)?\b\s*;/im.exec(tail);
    if (/\bis\s+protected(?:\s+body)?\b/im.test(tail) && protectedEnd) {
        return startOffset + protectedEnd.index + protectedEnd[0].length;
    }

    const semicolonRel = tail.indexOf(";");
    return semicolonRel >= 0 ? startOffset + semicolonRel + 1 : blockEnd;
}

function extractTypeMembers(
    doc: TextDocument,
    text: string,
    blockStart: number,
    blockEnd: number,
    packageName: string,
    visibility: PackageMemberEntry["visibility"],
    excludedRanges: Array<{ start: number; end: number }>
): PackageMemberEntry[] {
    const members: PackageMemberEntry[] = [];
    const block = text.slice(blockStart, blockEnd);
    const typeRe = /\btype\s+(\w+)\b/gim;

    let match: RegExpExecArray | null;
    while ((match = typeRe.exec(block)) !== null) {
        const absMatchStart = blockStart + match.index;
        if (isOffsetWithinRanges(absMatchStart, excludedRanges)) {
            continue;
        }

        const name = match[1];
        const nameStartRel = match[0].toLowerCase().lastIndexOf(name.toLowerCase());
        if (nameStartRel < 0) {
            continue;
        }

        const startOffset = absMatchStart + nameStartRel;
        const endOffset = startOffset + name.length;
        const declarationEnd = findTypeDeclarationEnd(text, absMatchStart, blockEnd);
        members.push(
            makePackageMemberEntry(
                doc,
                packageName,
                visibility,
                "type",
                name,
                startOffset,
                endOffset,
                normalizeWhitespace(text.slice(absMatchStart, Math.max(absMatchStart, declarationEnd - 1)))
            )
        );
    }

    return members;
}

function extractPackageMembers(
    doc: TextDocument,
    text: string,
    blockStart: number,
    blockEnd: number,
    packageName: string,
    visibility: PackageMemberEntry["visibility"],
    allCallables: CallableEntry[],
    allComponentHeaders: ReturnType<typeof findComponentHeaders>
): PackageMemberEntry[] {
    const callablesInBlock = filterTopLevelCallables(
        allCallables.filter(
            (entry) => blockStart <= entry.blockStartOffset && entry.blockEndOffset <= blockEnd
        )
    );
    const callableBodyRanges = callablesInBlock
        .filter((entry) => entry.bodyStartOffset !== null)
        .map((entry) => ({ start: entry.blockStartOffset, end: entry.blockEndOffset }));
    const componentMembers = allComponentHeaders
        .filter((header) => blockStart <= header.startOffset && header.endOffset <= blockEnd)
        .filter((header) => !isOffsetWithinRanges(header.startOffset, callableBodyRanges))
        .map((header) => {
            const componentBlockEnd = findBlockEnd(text, header.startOffset, "component");
            return {
                entry: makePackageMemberEntry(
                    doc,
                    packageName,
                    visibility,
                    "component",
                    header.name,
                    header.startOffset,
                    header.endOffset,
                    `component ${header.name}`
                ),
                blockStartOffset: header.startOffset,
                blockEndOffset: componentBlockEnd,
            };
        });
    const excludedRanges = [
        ...callableBodyRanges,
        ...componentMembers.map((member) => ({
            start: member.blockStartOffset,
            end: member.blockEndOffset,
        })),
    ];
    const members: PackageMemberEntry[] = [];

    members.push(
        ...callablesInBlock.map((entry) =>
            makePackageMemberEntry(
                doc,
                packageName,
                visibility,
                entry.kind,
                entry.name,
                entry.nameStartOffset,
                entry.nameEndOffset,
                entry.signature
            )
        )
    );
    members.push(...componentMembers.map((member) => member.entry));
    members.push(
        ...extractPackageConstantMembers(
            doc,
            text,
            blockStart,
            blockEnd,
            packageName,
            visibility,
            excludedRanges
        )
    );
    members.push(
        ...extractTypeMembers(
            doc,
            text,
            blockStart,
            blockEnd,
            packageName,
            visibility,
            excludedRanges
        )
    );
    members.push(
        ...extractSimpleNamedMembers(
            doc,
            text,
            blockStart,
            blockEnd,
            packageName,
            visibility,
            excludedRanges,
            /\bsubtype\s+(\w+)\s+is\s+[\s\S]*?;/gim,
            "subtype"
        )
    );
    members.push(
        ...extractSimpleNamedMembers(
            doc,
            text,
            blockStart,
            blockEnd,
            packageName,
            visibility,
            excludedRanges,
            /\balias\s+(\w+)\b[\s\S]*?;/gim,
            "alias"
        )
    );

    return members.sort((a, b) => {
        if (a.startOffset !== b.startOffset) {
            return a.startOffset - b.startOffset;
        }
        return a.nameLower.localeCompare(b.nameLower);
    });
}

function extractPackages(
    doc: TextDocument,
    text: string,
    allCallables: CallableEntry[],
    allComponentHeaders: ReturnType<typeof findComponentHeaders>
): { packages: PackageEntry[]; packageBodies: PackageEntry[] } {
    const buildEntries = (kind: PackageEntry["kind"], visibility: PackageMemberEntry["visibility"]): PackageEntry[] =>
        findPackageHeaders(doc, text, kind).map((header) => {
            const blockEndOffset = findPackageBlockEnd(text, header.blockStartOffset, header.name, kind);
            return {
                name: header.name,
                nameLower: header.name.toLowerCase(),
                kind,
                uri: doc.uri,
                nameStartOffset: header.startOffset,
                nameEndOffset: header.endOffset,
                nameRange: header.range,
                signature: kind === "package_body" ? `package body ${header.name}` : `package ${header.name}`,
                blockStartOffset: header.blockStartOffset,
                blockEndOffset,
                blockRange: rangeFromOffsets(doc, header.blockStartOffset, blockEndOffset),
                members: extractPackageMembers(
                    doc,
                    text,
                    header.blockStartOffset,
                    blockEndOffset,
                    header.name,
                    visibility,
                    allCallables,
                    allComponentHeaders
                ),
            };
        });

    return {
        packages: buildEntries("package", "public"),
        packageBodies: buildEntries("package_body", "body"),
    };
}

// ---------------------------------------------------------------------------
// Main indexText function
// ---------------------------------------------------------------------------

export function indexText(doc: TextDocument): IndexResult {
    const text = doc.getText();
    const uri = doc.uri;
    const allCallables = extractCallables(doc, text);
    const allComponentHeaders = findComponentHeaders(doc);
    const { packages, packageBodies } = extractPackages(doc, text, allCallables, allComponentHeaders);
    const packageBlockRanges = [...packages, ...packageBodies].map((entry) => ({
        start: entry.blockStartOffset,
        end: entry.blockEndOffset,
    }));

    // --- entities ---
    const entityHeaders = findEntityHeaders(doc).filter(
        (header) => !isRangeWithinRanges(header.startOffset, header.endOffset, packageBlockRanges)
    );
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
    const componentHeaders = allComponentHeaders.filter(
        (header) => !isRangeWithinRanges(header.startOffset, header.endOffset, packageBlockRanges)
    );
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
    const locals = extractLocalDecls(doc, text).filter(
        (entry) => !isRangeWithinRanges(entry.startOffset, entry.endOffset, packageBlockRanges)
    );
    const callables = allCallables.filter(
        (entry) => !isRangeWithinRanges(entry.blockStartOffset, entry.blockEndOffset, packageBlockRanges)
    );
    const libraryClauses = extractLibraryClauses(doc, text);
    const useClauses = extractUseClauses(doc, text);
    const topLevelUnits: TopLevelUnitEntry[] = [
        ...entities.map((entry) => ({
            kind: "entity" as const,
            name: entry.name,
            nameLower: entry.nameLower,
            uri,
            blockStartOffset: entry.blockStartOffset,
            blockEndOffset: entry.blockEndOffset,
        })),
        ...packages.map((entry) => ({
            kind: "package" as const,
            name: entry.name,
            nameLower: entry.nameLower,
            uri,
            blockStartOffset: entry.blockStartOffset,
            blockEndOffset: entry.blockEndOffset,
        })),
        ...packageBodies.map((entry) => ({
            kind: "package_body" as const,
            name: entry.name,
            nameLower: entry.nameLower,
            uri,
            blockStartOffset: entry.blockStartOffset,
            blockEndOffset: entry.blockEndOffset,
        })),
        ...findArchitectureUnits(text, uri),
    ].sort((a, b) => a.blockStartOffset - b.blockStartOffset);

    return {
        entities,
        components,
        locals,
        callables,
        packages,
        packageBodies,
        libraryClauses,
        useClauses,
        topLevelUnits,
    };
}