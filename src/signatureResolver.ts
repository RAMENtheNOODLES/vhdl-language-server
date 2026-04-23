import type { SignatureHelp, SignatureInformation } from "vscode-languageserver/node";

import type {
    CallableEntry,
    PackageMemberEntry,
} from "./indexing/indexTextSignature";
import {
    resolveSemanticEntry,
    type SemanticEntry,
    type SemanticSymbolIndex,
} from "./semanticResolver";
import { pickBest } from "./workspaceIndexer";

interface SignatureCallContext {
    calleeStart: number;
    calleeEnd: number;
    calleeNameLower: string;
    activeParameterIndex: number;
    activeParameterNameLower: string | null;
}

interface ResolvedSignature {
    label: string;
    params: string[];
}

export type SignatureSymbolIndex = SemanticSymbolIndex;

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function findMatchingParenInText(text: string, openParenOffset: number): number | null {
    if (openParenOffset < 0 || openParenOffset >= text.length || text[openParenOffset] !== "(") {
        return null;
    }

    let depth = 0;
    for (let i = openParenOffset; i < text.length; i++) {
        const ch = text[i];
        if (ch === "(") {
            depth++;
        } else if (ch === ")") {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }

    return null;
}

function splitTopLevel(value: string, separator: ";" | ","): string[] {
    const items: string[] = [];
    let start = 0;
    let depth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inComment = false;

    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        const next = i + 1 < value.length ? value[i + 1] : "";

        if (inComment) {
            if (ch === "\n") {
                inComment = false;
            }
            continue;
        }

        if (!inSingleQuote && !inDoubleQuote && ch === "-" && next === "-") {
            inComment = true;
            i++;
            continue;
        }

        if (!inDoubleQuote && ch === "'") {
            if (inSingleQuote) {
                if (next === "'") {
                    i++;
                } else {
                    inSingleQuote = false;
                }
            } else {
                inSingleQuote = true;
            }
            continue;
        }

        if (!inSingleQuote && ch === '"') {
            if (inDoubleQuote) {
                if (next === '"') {
                    i++;
                } else {
                    inDoubleQuote = false;
                }
            } else {
                inDoubleQuote = true;
            }
            continue;
        }

        if (inSingleQuote || inDoubleQuote) {
            continue;
        }

        if (ch === "(") {
            depth++;
            continue;
        }
        if (ch === ")") {
            if (depth > 0) {
                depth--;
            }
            continue;
        }

        if (depth === 0 && ch === separator) {
            items.push(value.slice(start, i));
            start = i + 1;
        }
    }

    items.push(value.slice(start));
    return items;
}

function extractActiveParameterInfo(argsText: string): {
    activeParameterIndex: number;
    activeParameterNameLower: string | null;
} {
    const sections = splitTopLevel(argsText, ",");
    const activeParameterIndex = Math.max(0, sections.length - 1);
    const activeSection = sections[sections.length - 1] ?? "";
    const namedAssociation = /^\s*(\w+)\s*=>/i.exec(activeSection);

    return {
        activeParameterIndex,
        activeParameterNameLower: namedAssociation ? namedAssociation[1].toLowerCase() : null,
    };
}

function getCallContext(text: string, offset: number): SignatureCallContext | null {
    const boundedOffset = Math.max(0, Math.min(offset, text.length));
    let depth = 0;

    for (let i = boundedOffset - 1; i >= 0; i--) {
        const ch = text[i];
        if (ch === ")") {
            depth++;
            continue;
        }

        if (ch !== "(") {
            continue;
        }

        if (depth > 0) {
            depth--;
            continue;
        }

        let cursor = i - 1;
        while (cursor >= 0 && /\s/.test(text[cursor])) {
            cursor--;
        }

        const calleeEnd = cursor + 1;
        while (cursor >= 0 && /[\w.]/.test(text[cursor])) {
            cursor--;
        }
        const calleeStart = cursor + 1;
        if (calleeStart >= calleeEnd) {
            continue;
        }

        const callee = text.slice(calleeStart, calleeEnd);
        if (!/^\w+(?:\.\w+)*$/.test(callee)) {
            continue;
        }

        const segments = callee.split(".");
        const calleeName = segments[segments.length - 1];
        const calleeNameStart = calleeEnd - calleeName.length;
        const activeParameter = extractActiveParameterInfo(text.slice(i + 1, boundedOffset));

        return {
            calleeStart: calleeNameStart,
            calleeEnd,
            calleeNameLower: calleeName.toLowerCase(),
            activeParameterIndex: activeParameter.activeParameterIndex,
            activeParameterNameLower: activeParameter.activeParameterNameLower,
        };
    }

    return null;
}

function paramsFromCallableEntry(entry: CallableEntry): string[] {
    if (entry.params.length > 0) {
        return entry.params.map((param) => param.signature.replace(/^parameter\s+/i, ""));
    }

    return paramsFromSignature(entry.signature);
}

function paramsFromSignature(signature: string): string[] {
    const openParenOffset = signature.indexOf("(");
    if (openParenOffset < 0) {
        return [];
    }

    const closeParenOffset = findMatchingParenInText(signature, openParenOffset);
    if (closeParenOffset == null) {
        return [];
    }

    const paramBlock = signature.slice(openParenOffset + 1, closeParenOffset);
    const clauses = splitTopLevel(paramBlock, ";")
        .map((clause) => clause.trim())
        .filter((clause) => clause.length > 0);

    const params: string[] = [];
    for (const clause of clauses) {
        const colonIndex = clause.indexOf(":");
        if (colonIndex < 0) {
            continue;
        }

        const namesPart = clause
            .slice(0, colonIndex)
            .replace(/^\s*(signal|variable|constant|file)\s+/i, "")
            .trim();
        const detail = normalizeWhitespace(clause.slice(colonIndex + 1));
        if (namesPart.length === 0 || detail.length === 0) {
            continue;
        }

        const names = splitTopLevel(namesPart, ",")
            .map((name) => name.trim())
            .filter((name) => /^[a-zA-Z_]\w*$/.test(name));

        for (const name of names) {
            params.push(`${name} : ${detail}`);
        }
    }

    return params;
}

function signatureFromCallableEntry(entry: CallableEntry): ResolvedSignature {
    return {
        label: entry.signature,
        params: paramsFromCallableEntry(entry),
    };
}

function signatureFromPackageMember(entry: PackageMemberEntry): ResolvedSignature {
    return {
        label: entry.signature,
        params: paramsFromSignature(entry.signature),
    };
}

function isCallableEntry(entry: SemanticEntry): entry is CallableEntry {
    return (
        (entry.kind === "function" || entry.kind === "procedure")
        && "params" in entry
    );
}

function isCallablePackageMember(entry: SemanticEntry): entry is PackageMemberEntry {
    return (
        (entry.kind === "function" || entry.kind === "procedure")
        && "packageNameLower" in entry
    );
}

function findNamedParameterIndex(signature: ResolvedSignature, paramNameLower: string): number {
    for (let i = 0; i < signature.params.length; i++) {
        const match = /^\s*(\w+)\s*:/.exec(signature.params[i]);
        if (match && match[1].toLowerCase() === paramNameLower) {
            return i;
        }
    }

    return -1;
}

function dedupeSignatures(signatures: ResolvedSignature[]): ResolvedSignature[] {
    const seen = new Set<string>();
    const result: ResolvedSignature[] = [];

    for (const signature of signatures) {
        const key = signature.label.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(signature);
    }

    return result;
}

function collectCallableSignatures(
    text: string,
    currentUri: string,
    offset: number,
    context: SignatureCallContext,
    index: SignatureSymbolIndex
): ResolvedSignature[] {
    const signatures: ResolvedSignature[] = [];

    const semanticResolution = resolveSemanticEntry(
        text,
        context.calleeStart,
        context.calleeEnd,
        currentUri,
        index
    );

    if (semanticResolution.entry && isCallableEntry(semanticResolution.entry)) {
        signatures.push(signatureFromCallableEntry(semanticResolution.entry));
    } else if (semanticResolution.entry && isCallablePackageMember(semanticResolution.entry)) {
        signatures.push(signatureFromPackageMember(semanticResolution.entry));
    }

    const callablesByName = index.getAllCallables().filter(
        (entry) => entry.nameLower === context.calleeNameLower
    );
    const sortedByRelevance = pickBest(callablesByName, currentUri, offset);
    signatures.push(...sortedByRelevance.map(signatureFromCallableEntry));

    return dedupeSignatures(signatures);
}

export function resolveSignatureHelp(
    text: string,
    offset: number,
    currentUri: string,
    index: SignatureSymbolIndex
): SignatureHelp | null {
    const context = getCallContext(text, offset);
    if (!context) {
        return null;
    }

    const signatures = collectCallableSignatures(text, currentUri, offset, context, index);
    if (signatures.length === 0) {
        return null;
    }

    let activeSignatureIndex = 0;
    if (context.activeParameterNameLower) {
        const byName = signatures.findIndex(
            (signature) => findNamedParameterIndex(signature, context.activeParameterNameLower!) >= 0
        );
        if (byName >= 0) {
            activeSignatureIndex = byName;
        }
    }

    const lspSignatures: SignatureInformation[] = signatures.map((signature) => ({
        label: signature.label,
        parameters: signature.params.map((param) => ({ label: param })),
    }));

    const activeSignature = signatures[activeSignatureIndex];
    const resolvedActiveParam = context.activeParameterNameLower
        ? (() => {
            const named = findNamedParameterIndex(activeSignature, context.activeParameterNameLower);
            if (named >= 0) {
                return named;
            }
            return context.activeParameterIndex;
        })()
        : context.activeParameterIndex;

    const activeParameter = activeSignature.params.length > 0
        ? Math.min(resolvedActiveParam, activeSignature.params.length - 1)
        : undefined;

    return {
        signatures: lspSignatures,
        activeSignature: activeSignatureIndex,
        activeParameter,
    };
}