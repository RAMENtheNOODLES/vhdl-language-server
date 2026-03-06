import type {
    DesignUnitEntry,
    LocalDecl,
    PortGenericEntry,
} from "./indexing/indexTextSignature";
import { determineContext, pickBest } from "./workspaceIndexer";

export interface HoverSymbolIndex {
    findEntities(nameLower: string): DesignUnitEntry[];
    findComponents(nameLower: string): DesignUnitEntry[];
    getDocLocals(uri: string): LocalDecl[];
    getDocEntities(uri: string): DesignUnitEntry[];
    getDocComponents(uri: string): DesignUnitEntry[];
    getAllDesignUnits(): DesignUnitEntry[];
}

export type HoverEntry = DesignUnitEntry | LocalDecl | PortGenericEntry;

const PORT_MAP_SEARCH_DISTANCE = 2000;

export function resolveHoverEntry(
    text: string,
    wordStart: number,
    wordEnd: number,
    currentUri: string,
    index: HoverSymbolIndex
): HoverEntry | null {
    const wordLower = text.slice(wordStart, wordEnd).toLowerCase();
    if (wordLower.length === 0) {
        return null;
    }

    const ctx = determineContext(text, wordStart, wordEnd);
    if (ctx === "port_map_formal") {
        return resolvePortFormalHover(text, wordStart, wordEnd, wordLower, currentUri, index);
    }

    if (ctx === "component_decl_name") {
        const comps = pickBest(index.findComponents(wordLower), currentUri, wordStart);
        if (comps.length > 0) return comps[0];

        const entities = pickBest(index.findEntities(wordLower), currentUri, wordStart);
        return entities[0] ?? null;
    }

    if (ctx === "instantiation_target") {
        const comps = pickBest(index.findComponents(wordLower), currentUri, wordStart);
        if (comps.length > 0) return comps[0];

        const entities = pickBest(index.findEntities(wordLower), currentUri, wordStart);
        return entities[0] ?? null;
    }

    return resolveHoverGeneral(wordStart, wordEnd, wordLower, currentUri, index);
}

export function formatHoverMarkdown(entry: HoverEntry): string {
    return ["```vhdl", entry.signature, "```"].join("\n");
}

function resolvePortFormalHover(
    text: string,
    wordStart: number,
    wordEnd: number,
    wordLower: string,
    currentUri: string,
    index: HoverSymbolIndex
): HoverEntry | null {
    const before = text.slice(Math.max(0, wordStart - PORT_MAP_SEARCH_DISTANCE), wordStart);
    const instPattern = /\b(\w+)\s*:\s*(?:entity\s+\w+\.)?(\w+)\s*(?:generic\s+map\s*\(.*\)\s*)?(?:port\s+map\s*\()?/gim;

    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = instPattern.exec(before)) !== null) {
        lastMatch = m;
    }

    if (lastMatch) {
        const unitNameLower = lastMatch[2].toLowerCase();
        const hit = findPortOrGenericInNamedUnit(unitNameLower, wordLower, currentUri, wordStart, wordEnd, index);
        if (hit) return hit;
    }

    return findPortOrGenericGlobal(wordLower, currentUri, wordStart, wordEnd, index);
}

function resolveHoverGeneral(
    wordStart: number,
    wordEnd: number,
    wordLower: string,
    currentUri: string,
    index: HoverSymbolIndex
): HoverEntry | null {
    const localHit = pickBestLocal(index.getDocLocals(currentUri), wordLower, wordStart, wordEnd);
    if (localHit) return localHit;

    const exactDesignUnit = findExactDocDesignUnit(index, currentUri, wordLower, wordStart, wordEnd);
    if (exactDesignUnit) return exactDesignUnit;

    const docUnits = [
        ...index.getDocEntities(currentUri),
        ...index.getDocComponents(currentUri),
    ];
    const scopedPortLike = findPortOrGenericInUnits(docUnits, wordLower, wordStart, wordEnd);
    if (scopedPortLike) return scopedPortLike;

    const globalPortLike = findPortOrGenericGlobal(wordLower, currentUri, wordStart, wordEnd, index);
    if (globalPortLike) return globalPortLike;

    const entities = pickBest(index.findEntities(wordLower), currentUri, wordStart);
    if (entities.length > 0) return entities[0];

    const components = pickBest(index.findComponents(wordLower), currentUri, wordStart);
    return components[0] ?? null;
}

function pickBestLocal(
    locals: LocalDecl[],
    wordLower: string,
    wordStart: number,
    wordEnd: number
): LocalDecl | null {
    const hits = locals.filter((entry) => entry.nameLower === wordLower);
    if (hits.length === 0) return null;

    const exact = hits.find(
        (entry) => entry.startOffset <= wordStart && wordEnd <= entry.endOffset
    );
    if (exact) return exact;

    const above = hits.filter((entry) => entry.endOffset <= wordStart);
    if (above.length > 0) {
        return above.reduce((best, entry) =>
            entry.endOffset > best.endOffset ? entry : best
        );
    }

    return hits[0];
}

function findExactDocDesignUnit(
    index: HoverSymbolIndex,
    currentUri: string,
    wordLower: string,
    wordStart: number,
    wordEnd: number
): DesignUnitEntry | null {
    const docUnits = [
        ...index.getDocEntities(currentUri),
        ...index.getDocComponents(currentUri),
    ];

    return (
        docUnits.find(
            (unit) =>
                unit.nameLower === wordLower &&
                unit.nameStartOffset <= wordStart &&
                wordEnd <= unit.nameEndOffset
        ) ?? null
    );
}

function findPortOrGenericInNamedUnit(
    unitNameLower: string,
    wordLower: string,
    currentUri: string,
    wordStart: number,
    wordEnd: number,
    index: HoverSymbolIndex
): PortGenericEntry | null {
    const comps = pickBest(index.findComponents(unitNameLower), currentUri, wordStart);
    const compHit = findPortOrGenericInUnits(comps, wordLower, wordStart, wordEnd);
    if (compHit) return compHit;

    const entities = pickBest(index.findEntities(unitNameLower), currentUri, wordStart);
    return findPortOrGenericInUnits(entities, wordLower, wordStart, wordEnd);
}

function findPortOrGenericGlobal(
    wordLower: string,
    currentUri: string,
    wordStart: number,
    wordEnd: number,
    index: HoverSymbolIndex
): PortGenericEntry | null {
    const units = pickBest(index.getAllDesignUnits(), currentUri, wordStart);
    return findPortOrGenericInUnits(units, wordLower, wordStart, wordEnd);
}

function findPortOrGenericInUnits(
    units: DesignUnitEntry[],
    wordLower: string,
    wordStart: number,
    wordEnd: number
): PortGenericEntry | null {
    for (const unit of units) {
        const exact = findMatchingPortLike(unit, wordLower).find(
            (entry) => entry.startOffset <= wordStart && wordEnd <= entry.endOffset
        );
        if (exact) return exact;
    }

    for (const unit of units) {
        if (unit.blockStartOffset <= wordStart && wordStart <= unit.blockEndOffset) {
            const scoped = findMatchingPortLike(unit, wordLower)[0];
            if (scoped) return scoped;
        }
    }

    for (const unit of units) {
        const hit = findMatchingPortLike(unit, wordLower)[0];
        if (hit) return hit;
    }

    return null;
}

function findMatchingPortLike(
    unit: DesignUnitEntry,
    wordLower: string
): PortGenericEntry[] {
    return [...unit.ports, ...unit.generics].filter(
        (entry) => entry.nameLower === wordLower
    );
}