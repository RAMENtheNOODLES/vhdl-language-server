import { CompletionItemKind } from "vscode-languageserver/node";

import { VHDL_KEYWORDS } from "./ghdl";
import type {
    CallableEntry,
    DesignUnitEntry,
    LocalDecl,
    PortGenericEntry,
} from "./indexing/indexTextSignature";
import { pickBest } from "./workspaceIndexer";

const CONTEXT_LOOKBACK_CHARS = 2000;

type ScopeKind =
    | "architecture"
    | "component"
    | "entity"
    | "function"
    | "procedure"
    | "process";

interface Scope {
    id: string;
    kind: ScopeKind;
    startOffset: number;
    endOffset: number;
    nameLower?: string;
    entityNameLower?: string;
    callable?: CallableEntry;
    unit?: DesignUnitEntry;
}

interface PrefixInfo {
    start: number;
    end: number;
    prefix: string;
    prefixLower: string;
}

interface AssociationContext {
    associationKind: "generic" | "port";
    unitNameLower: string | null;
}

export interface CompletionSymbolIndex {
    findEntities(nameLower: string): DesignUnitEntry[];
    findComponents(nameLower: string): DesignUnitEntry[];
    getDocLocals(uri: string): LocalDecl[];
    getDocEntities(uri: string): DesignUnitEntry[];
    getDocComponents(uri: string): DesignUnitEntry[];
    getDocCallables(uri: string): CallableEntry[];
    getAllDesignUnits(): DesignUnitEntry[];
    getAllCallables(): CallableEntry[];
}

export interface ResolvedCompletion {
    label: string;
    detail?: string;
    kind: CompletionItemKind;
    sortText: string;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function getPrefixInfo(text: string, offset: number): PrefixInfo {
    const boundedOffset = Math.max(0, Math.min(offset, text.length));
    let start = boundedOffset;
    while (start > 0 && /\w/.test(text[start - 1])) {
        start--;
    }

    let end = boundedOffset;
    while (end < text.length && /\w/.test(text[end])) {
        end++;
    }

    const prefix = text.slice(start, boundedOffset);
    return {
        start,
        end,
        prefix,
        prefixLower: prefix.toLowerCase(),
    };
}

function matchesPrefix(labelLower: string, prefixLower: string): boolean {
    return prefixLower.length === 0 || labelLower.startsWith(prefixLower);
}

function makeScopeId(kind: ScopeKind, startOffset: number, endOffset: number, nameLower?: string): string {
    return `${kind}:${startOffset}:${endOffset}:${nameLower ?? ""}`;
}

function findNamedBlockEnd(
    text: string,
    afterOffset: number,
    kind: "architecture",
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

function findArchitectureScopes(text: string): Scope[] {
    const scopes: Scope[] = [];
    const re = /\barchitecture\s+(\w+)\s+of\s+(\w+)\s+is\b/gim;

    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const name = match[1];
        const entityName = match[2];
        const startOffset = match.index;
        const endOffset = findNamedBlockEnd(text, re.lastIndex, "architecture", name);
        scopes.push({
            id: makeScopeId("architecture", startOffset, endOffset, name.toLowerCase()),
            kind: "architecture",
            startOffset,
            endOffset,
            nameLower: name.toLowerCase(),
            entityNameLower: entityName.toLowerCase(),
        });
    }

    return scopes;
}

function findProcessScopes(text: string): Scope[] {
    const scopes: Scope[] = [];
    const re = /\b(?:postponed\s+)?process\b/gim;

    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        if (previousWord(text, match.index) === "end") {
            continue;
        }

        const sub = text.slice(re.lastIndex);
        const endMatch = /\bend\s+(?:postponed\s+)?process(?:\s+\w+)?\s*;/im.exec(sub);
        if (!endMatch) {
            continue;
        }

        const startOffset = match.index;
        const endOffset = re.lastIndex + endMatch.index + endMatch[0].length;
        scopes.push({
            id: makeScopeId("process", startOffset, endOffset),
            kind: "process",
            startOffset,
            endOffset,
        });
    }

    return scopes;
}

function collectScopes(
    text: string,
    currentUri: string,
    index: CompletionSymbolIndex
): Scope[] {
    const scopes: Scope[] = [];

    for (const unit of index.getDocEntities(currentUri)) {
        scopes.push({
            id: makeScopeId(unit.kind, unit.blockStartOffset, unit.blockEndOffset, unit.nameLower),
            kind: unit.kind,
            startOffset: unit.blockStartOffset,
            endOffset: unit.blockEndOffset,
            nameLower: unit.nameLower,
            unit,
        });
    }

    for (const unit of index.getDocComponents(currentUri)) {
        scopes.push({
            id: makeScopeId(unit.kind, unit.blockStartOffset, unit.blockEndOffset, unit.nameLower),
            kind: unit.kind,
            startOffset: unit.blockStartOffset,
            endOffset: unit.blockEndOffset,
            nameLower: unit.nameLower,
            unit,
        });
    }

    for (const architecture of findArchitectureScopes(text)) {
        scopes.push(architecture);
    }

    for (const callable of index.getDocCallables(currentUri)) {
        if (callable.bodyStartOffset == null) {
            continue;
        }

        scopes.push({
            id: makeScopeId(callable.kind, callable.blockStartOffset, callable.blockEndOffset, callable.nameLower),
            kind: callable.kind,
            startOffset: callable.blockStartOffset,
            endOffset: callable.blockEndOffset,
            nameLower: callable.nameLower,
            callable,
        });
    }

    for (const process of findProcessScopes(text)) {
        scopes.push(process);
    }

    return scopes;
}

function getContainingScopes(scopes: Scope[], offset: number): Scope[] {
    return scopes
        .filter((scope) => scope.startOffset <= offset && offset <= scope.endOffset)
        .sort((a, b) => {
            if (a.startOffset !== b.startOffset) {
                return a.startOffset - b.startOffset;
            }
            return b.endOffset - a.endOffset;
        });
}

function getInnermostScope(scopes: Scope[], offset: number): Scope | null {
    const containing = getContainingScopes(scopes, offset);
    return containing.length > 0 ? containing[containing.length - 1] : null;
}

function isEntryVisibleInScope(scopes: Scope[], currentScopeChain: Scope[], offset: number): boolean {
    const entryScope = getInnermostScope(scopes, offset);
    if (!entryScope) {
        return true;
    }

    return currentScopeChain.some((scope) => scope.id === entryScope.id);
}

function getEntryScopeDepth(scopes: Scope[], offset: number): number {
    return getContainingScopes(scopes, offset).length;
}

function resolveAssociationContext(text: string, offset: number): AssociationContext | null {
    const before = text.slice(Math.max(0, offset - CONTEXT_LOOKBACK_CHARS), offset);
    const mapRe = /\b(generic|port)\s+map\s*\(/gim;

    let lastMapMatch: RegExpExecArray | null = null;
    let mapMatch: RegExpExecArray | null;
    while ((mapMatch = mapRe.exec(before)) !== null) {
        lastMapMatch = mapMatch;
    }

    if (!lastMapMatch) {
        return null;
    }

    const openParenOffset = lastMapMatch.index + lastMapMatch[0].length - 1;
    const sinceOpenParen = before.slice(openParenOffset + 1);
    const lastComma = sinceOpenParen.lastIndexOf(",");
    const currentAssociation = sinceOpenParen.slice(lastComma + 1);
    if (currentAssociation.includes("=>")) {
        return null;
    }

    const beforeMap = before.slice(0, lastMapMatch.index);
    const instRe = /\b(\w+)\s*:\s*(?:entity\s+\w+\.)?(\w+)\b/gim;
    let lastInstantiation: RegExpExecArray | null = null;
    let instMatch: RegExpExecArray | null;
    while ((instMatch = instRe.exec(beforeMap)) !== null) {
        lastInstantiation = instMatch;
    }

    return {
        associationKind: lastMapMatch[1].toLowerCase() as AssociationContext["associationKind"],
        unitNameLower: lastInstantiation ? lastInstantiation[2].toLowerCase() : null,
    };
}

function getStatementFragmentBefore(text: string, offset: number): string {
    const before = text.slice(Math.max(0, offset - 400), offset);
    const boundary = Math.max(before.lastIndexOf(";"), before.lastIndexOf("\n"));
    return before.slice(boundary + 1);
}

function isComponentDeclarationNameContext(text: string, offset: number): boolean {
    return /^\s*component\s+\w*$/i.test(getStatementFragmentBefore(text, offset));
}

function isInstantiationTargetContext(text: string, offset: number): boolean {
    const fragment = getStatementFragmentBefore(text, offset);
    return /^\s*\w+\s*:\s*(?:entity\s+\w+\.)?\w*$/i.test(fragment);
}

function resolveCurrentUnitEntries(
    scopes: Scope[],
    currentScopeChain: Scope[],
    currentUri: string,
    offset: number,
    index: CompletionSymbolIndex
): PortGenericEntry[] {
    const innermost = currentScopeChain[currentScopeChain.length - 1];
    if (innermost?.unit) {
        return [...innermost.unit.ports, ...innermost.unit.generics];
    }

    const architecture = [...currentScopeChain]
        .reverse()
        .find((scope) => scope.kind === "architecture" && scope.entityNameLower);
    if (!architecture?.entityNameLower) {
        return [];
    }

    const entities = pickBest(
        index.findEntities(architecture.entityNameLower),
        currentUri,
        offset
    );
    return entities.length > 0 ? [...entities[0].ports, ...entities[0].generics] : [];
}

function sortByScopeAndOffset<T>(
    entries: T[],
    scopes: Scope[],
    currentOffset: number,
    getOffset: (entry: T) => number
): T[] {
    return [...entries].sort((a, b) => {
        const aOffset = getOffset(a);
        const bOffset = getOffset(b);
        const scopeDepthDelta = getEntryScopeDepth(scopes, bOffset) - getEntryScopeDepth(scopes, aOffset);
        if (scopeDepthDelta !== 0) {
            return scopeDepthDelta;
        }

        const aDistance = currentOffset - aOffset;
        const bDistance = currentOffset - bOffset;
        return aDistance - bDistance;
    });
}

function addCompletion(
    results: ResolvedCompletion[],
    seen: Set<string>,
    group: "callable" | "designunit" | "keyword" | "value",
    label: string,
    kind: CompletionItemKind,
    sortGroup: string,
    prefixLower: string,
    detail?: string
): void {
    const labelLower = label.toLowerCase();
    if (!matchesPrefix(labelLower, prefixLower)) {
        return;
    }

    const key = `${group}:${labelLower}`;
    if (seen.has(key)) {
        return;
    }

    seen.add(key);
    results.push({
        label,
        detail,
        kind,
        sortText: `${sortGroup}_${labelLower}`,
    });
}

function addPortLikeEntries(
    entries: PortGenericEntry[],
    results: ResolvedCompletion[],
    seen: Set<string>,
    prefixLower: string,
    sortGroup: string
): void {
    for (const entry of entries) {
        addCompletion(
            results,
            seen,
            "value",
            entry.name,
            CompletionItemKind.Field,
            sortGroup,
            prefixLower,
            entry.signature
        );
    }
}

function addCallableEntries(
    entries: CallableEntry[],
    results: ResolvedCompletion[],
    seen: Set<string>,
    prefixLower: string,
    sortGroup: string
): void {
    for (const entry of entries) {
        addCompletion(
            results,
            seen,
            "callable",
            entry.name,
            CompletionItemKind.Function,
            sortGroup,
            prefixLower,
            entry.signature
        );
    }
}

function addDesignUnits(
    entries: DesignUnitEntry[],
    results: ResolvedCompletion[],
    seen: Set<string>,
    prefixLower: string,
    sortGroup: string
): void {
    for (const entry of entries) {
        addCompletion(
            results,
            seen,
            "designunit",
            entry.name,
            CompletionItemKind.Module,
            sortGroup,
            prefixLower,
            entry.signature
        );
    }
}

function addKeywords(
    results: ResolvedCompletion[],
    seen: Set<string>,
    prefixLower: string
): void {
    for (const keyword of VHDL_KEYWORDS) {
        addCompletion(
            results,
            seen,
            "keyword",
            keyword,
            CompletionItemKind.Keyword,
            "90",
            prefixLower
        );
    }
}

function resolveAssociationCompletions(
    context: AssociationContext,
    currentUri: string,
    offset: number,
    index: CompletionSymbolIndex,
    prefixLower: string
): ResolvedCompletion[] {
    const results: ResolvedCompletion[] = [];
    const seen = new Set<string>();

    if (!context.unitNameLower) {
        return results;
    }

    const components = pickBest(index.findComponents(context.unitNameLower), currentUri, offset);
    const entities = pickBest(index.findEntities(context.unitNameLower), currentUri, offset);
    const units = [...components, ...entities];

    for (const unit of units) {
        const entries = context.associationKind === "generic" ? unit.generics : unit.ports;
        addPortLikeEntries(entries, results, seen, prefixLower, "00");
    }

    return results;
}

function resolveComponentDeclarationCompletions(
    currentUri: string,
    offset: number,
    index: CompletionSymbolIndex,
    prefixLower: string
): ResolvedCompletion[] {
    const results: ResolvedCompletion[] = [];
    const seen = new Set<string>();
    const entities = pickBest(
        index.getAllDesignUnits().filter((entry) => entry.kind === "entity"),
        currentUri,
        offset
    );
    addDesignUnits(entities, results, seen, prefixLower, "00");
    return results;
}

function resolveInstantiationTargetCompletions(
    currentUri: string,
    offset: number,
    index: CompletionSymbolIndex,
    prefixLower: string
): ResolvedCompletion[] {
    const results: ResolvedCompletion[] = [];
    const seen = new Set<string>();
    const allUnits = index.getAllDesignUnits();

    addDesignUnits(
        pickBest(allUnits.filter((entry) => entry.kind === "component"), currentUri, offset),
        results,
        seen,
        prefixLower,
        "00"
    );
    addDesignUnits(
        pickBest(allUnits.filter((entry) => entry.kind === "entity"), currentUri, offset),
        results,
        seen,
        prefixLower,
        "01"
    );

    return results;
}

function resolveGeneralCompletions(
    text: string,
    currentUri: string,
    offset: number,
    index: CompletionSymbolIndex,
    prefixLower: string
): ResolvedCompletion[] {
    const results: ResolvedCompletion[] = [];
    const seen = new Set<string>();
    const scopes = collectScopes(text, currentUri, index);
    const currentScopeChain = getContainingScopes(scopes, offset);
    const visibleLocals = sortByScopeAndOffset(
        index
            .getDocLocals(currentUri)
            .filter((entry) => entry.startOffset <= offset)
            .filter((entry) => isEntryVisibleInScope(scopes, currentScopeChain, entry.startOffset)),
        scopes,
        offset,
        (entry) => entry.startOffset
    );

    const activeCallables = [...currentScopeChain]
        .reverse()
        .filter((scope) => scope.callable)
        .map((scope) => scope.callable as CallableEntry);

    for (const callable of activeCallables) {
        for (const param of callable.params) {
            addCompletion(
                results,
                seen,
                "value",
                param.name,
                CompletionItemKind.Variable,
                "00",
                prefixLower,
                param.signature
            );
        }
    }

    for (const entry of visibleLocals) {
        addCompletion(
            results,
            seen,
            "value",
            entry.name,
            entry.kind === "constant" ? CompletionItemKind.Constant : CompletionItemKind.Variable,
            "01",
            prefixLower,
            entry.signature
        );
    }

    addPortLikeEntries(
        resolveCurrentUnitEntries(scopes, currentScopeChain, currentUri, offset, index),
        results,
        seen,
        prefixLower,
        "02"
    );

    const visibleDocCallables = sortByScopeAndOffset(
        index
            .getDocCallables(currentUri)
            .filter((entry) => entry.nameStartOffset <= offset)
            .filter((entry) => isEntryVisibleInScope(
                scopes,
                currentScopeChain,
                Math.max(0, entry.blockStartOffset - 1)
            )),
        scopes,
        offset,
        (entry) => entry.blockStartOffset
    );
    addCallableEntries(visibleDocCallables, results, seen, prefixLower, "03");

    if (prefixLower.length > 0) {
        const workspaceCallables = index
            .getAllCallables()
            .filter((entry) => entry.uri !== currentUri)
            .sort((a, b) => a.nameLower.localeCompare(b.nameLower));
        addCallableEntries(workspaceCallables, results, seen, prefixLower, "04");

        addDesignUnits(
            pickBest(index.getAllDesignUnits(), currentUri, offset),
            results,
            seen,
            prefixLower,
            "05"
        );

        addKeywords(results, seen, prefixLower);
    }

    return results;
}

export function resolveCompletionItems(
    text: string,
    offset: number,
    currentUri: string,
    index: CompletionSymbolIndex
): ResolvedCompletion[] {
    const prefix = getPrefixInfo(text, offset);
    const associationContext = resolveAssociationContext(text, prefix.start);
    if (associationContext) {
        return resolveAssociationCompletions(
            associationContext,
            currentUri,
            offset,
            index,
            prefix.prefixLower
        );
    }

    if (isComponentDeclarationNameContext(text, prefix.start)) {
        return resolveComponentDeclarationCompletions(
            currentUri,
            offset,
            index,
            prefix.prefixLower
        );
    }

    if (isInstantiationTargetContext(text, prefix.start)) {
        return resolveInstantiationTargetCompletions(
            currentUri,
            offset,
            index,
            prefix.prefixLower
        );
    }

    return resolveGeneralCompletions(
        text,
        currentUri,
        offset,
        index,
        prefix.prefixLower
    );
}