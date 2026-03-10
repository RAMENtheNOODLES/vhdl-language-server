import type { Range } from "vscode-languageserver/node";

import type {
    CallableEntry,
    CallableParameterEntry,
    DesignUnitEntry,
    LibraryClauseEntry,
    LocalDecl,
    PackageEntry,
    PackageMemberEntry,
    PortGenericEntry,
    TopLevelUnitEntry,
    UseClauseEntry,
} from "./indexing/indexTextSignature";
import { determineContext, pickBest } from "./workspaceIndexer";

export interface SemanticSymbolIndex {
    findEntities(nameLower: string): DesignUnitEntry[];
    findComponents(nameLower: string): DesignUnitEntry[];
    findPackages(nameLower: string): PackageEntry[];
    findPackageBodies(nameLower: string): PackageEntry[];
    getDocLocals(uri: string): LocalDecl[];
    getDocEntities(uri: string): DesignUnitEntry[];
    getDocComponents(uri: string): DesignUnitEntry[];
    getDocCallables(uri: string): CallableEntry[];
    getDocPackages(uri: string): PackageEntry[];
    getDocPackageBodies(uri: string): PackageEntry[];
    getDocLibraryClauses(uri: string): LibraryClauseEntry[];
    getDocUseClauses(uri: string): UseClauseEntry[];
    getDocTopLevelUnits(uri: string): TopLevelUnitEntry[];
    getAllDesignUnits(): DesignUnitEntry[];
    getAllCallables(): CallableEntry[];
    getAllPackages(): PackageEntry[];
    getAllPackageBodies(): PackageEntry[];
}

export type SemanticEntry =
    | CallableParameterEntry
    | DesignUnitEntry
    | LocalDecl
    | PackageEntry
    | PackageMemberEntry
    | PortGenericEntry;

export interface SemanticResolution {
    entry: SemanticEntry | null;
    ambiguous: boolean;
}

export interface PackageMemberGroup {
    name: string;
    nameLower: string;
    members: PackageMemberEntry[];
    ambiguous: boolean;
}

export interface SelectedNameCompletionScope {
    kind: "packages" | "members";
    packages: PackageEntry[];
    partial: string;
    partialLower: string;
    inUseClause: boolean;
}

interface SelectedNameInfo {
    segments: string[];
    segmentsLower: string[];
    segmentIndex: number;
}

interface SelectedNamePrefixInfo {
    prefixSegments: string[];
    prefixSegmentsLower: string[];
    partial: string;
    partialLower: string;
    startOffset: number;
}

interface DocState {
    locals: LocalDecl[];
    entities: DesignUnitEntry[];
    components: DesignUnitEntry[];
    callables: CallableEntry[];
    packages: PackageEntry[];
    packageBodies: PackageEntry[];
    libraryClauses: LibraryClauseEntry[];
    useClauses: UseClauseEntry[];
    topLevelUnits: TopLevelUnitEntry[];
}

interface ActiveContext {
    libraries: LibraryClauseEntry[];
    uses: UseClauseEntry[];
    containingUnit: TopLevelUnitEntry | null;
}

const PORT_MAP_SEARCH_DISTANCE = 2000;

function resolved(entry: SemanticEntry): SemanticResolution {
    return { entry, ambiguous: false };
}

function unresolved(ambiguous = false): SemanticResolution {
    return { entry: null, ambiguous };
}

function getDocState(currentUri: string, index: SemanticSymbolIndex): DocState {
    return {
        locals: index.getDocLocals(currentUri),
        entities: index.getDocEntities(currentUri),
        components: index.getDocComponents(currentUri),
        callables: index.getDocCallables(currentUri),
        packages: index.getDocPackages(currentUri),
        packageBodies: index.getDocPackageBodies(currentUri),
        libraryClauses: index.getDocLibraryClauses(currentUri),
        useClauses: index.getDocUseClauses(currentUri),
        topLevelUnits: index.getDocTopLevelUnits(currentUri),
    };
}

function getContainingTopLevelUnit(units: TopLevelUnitEntry[], offset: number): TopLevelUnitEntry | null {
    return (
        units.find((unit) => unit.blockStartOffset <= offset && offset <= unit.blockEndOffset) ?? null
    );
}

function getActiveContext(docState: DocState, offset: number): ActiveContext {
    const containingUnit = getContainingTopLevelUnit(docState.topLevelUnits, offset);
    const libraries = docState.libraryClauses.filter(
        (entry) => entry.clauseStartOffset <= offset
    );
    const uses = docState.useClauses.filter(
        (entry) => entry.clauseStartOffset <= offset
    );

    return {
        libraries: dedupeClauses(libraries),
        uses: dedupeClauses(uses),
        containingUnit,
    };
}

function dedupeClauses<T extends { clauseStartOffset: number; clauseEndOffset: number; startOffset: number; endOffset: number }>(entries: T[]): T[] {
    const seen = new Set<string>();
    const result: T[] = [];

    for (const entry of entries) {
        const key = `${entry.clauseStartOffset}:${entry.clauseEndOffset}:${entry.startOffset}:${entry.endOffset}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(entry);
    }

    return result;
}

function isLibraryLikeName(
    nameLower: string,
    currentUri: string,
    offset: number,
    index: SemanticSymbolIndex,
    docState?: DocState
): boolean {
    if (nameLower === "work") {
        return true;
    }

    const activeContext = getActiveContext(docState ?? getDocState(currentUri, index), offset);
    return activeContext.libraries.some((entry) => entry.nameLower === nameLower);
}

function getSelectedNameInfo(text: string, wordStart: number, wordEnd: number): SelectedNameInfo | null {
    let start = wordStart;
    while (start > 0 && /[\w.]/.test(text[start - 1])) {
        start--;
    }

    let end = wordEnd;
    while (end < text.length && /[\w.]/.test(text[end])) {
        end++;
    }

    const fragment = text.slice(start, end);
    if (!fragment.includes(".") || !/^\w+(?:\.\w+)+$/.test(fragment)) {
        return null;
    }

    const segments = fragment.split(".");
    const segmentsLower = segments.map((segment) => segment.toLowerCase());
    let cursor = start;
    for (let i = 0; i < segments.length; i++) {
        const segmentEnd = cursor + segments[i].length;
        if (cursor <= wordStart && wordEnd <= segmentEnd) {
            return { segments, segmentsLower, segmentIndex: i };
        }
        cursor = segmentEnd + 1;
    }

    return null;
}

function getSelectedNamePrefixInfo(text: string, offset: number): SelectedNamePrefixInfo | null {
    let start = offset;
    while (start > 0 && /[\w.]/.test(text[start - 1])) {
        start--;
    }

    const fragment = text.slice(start, offset);
    if (!fragment.includes(".")) {
        return null;
    }

    if (!/^\w+(?:\.\w+)*\.?\w*$/.test(fragment)) {
        return null;
    }

    const parts = fragment.split(".");
    if (parts.length < 2 || parts.slice(0, -1).some((part) => part.length === 0)) {
        return null;
    }

    const partial = parts[parts.length - 1] ?? "";
    const prefixSegments = parts.slice(0, -1).filter(Boolean);
    if (prefixSegments.length === 0) {
        return null;
    }

    return {
        prefixSegments,
        prefixSegmentsLower: prefixSegments.map((segment) => segment.toLowerCase()),
        partial,
        partialLower: partial.toLowerCase(),
        startOffset: start,
    };
}

function getStatementFragmentBefore(text: string, offset: number): string {
    const before = text.slice(Math.max(0, offset - 400), offset);
    const boundary = Math.max(before.lastIndexOf(";"), before.lastIndexOf("\n"));
    return before.slice(boundary + 1);
}

function isUseClauseContext(text: string, offset: number): boolean {
    return /^\s*use\s+[\w.]*$/i.test(getStatementFragmentBefore(text, offset));
}

function getMemberKey(entry: PackageMemberEntry): string {
    return `${entry.uri}:${entry.packageNameLower}:${entry.kind}:${entry.startOffset}:${entry.endOffset}`;
}

function sortMembers(entries: PackageMemberEntry[]): PackageMemberEntry[] {
    return [...entries].sort((a, b) => {
        if (a.packageNameLower !== b.packageNameLower) {
            return a.packageNameLower.localeCompare(b.packageNameLower);
        }
        if (a.uri !== b.uri) {
            return a.uri.localeCompare(b.uri);
        }
        return a.startOffset - b.startOffset;
    });
}

function groupPackageMembers(entries: PackageMemberEntry[]): PackageMemberGroup[] {
    const grouped = new Map<string, Map<string, PackageMemberEntry>>();

    for (const entry of entries) {
        const byMember = grouped.get(entry.nameLower) ?? new Map<string, PackageMemberEntry>();
        byMember.set(getMemberKey(entry), entry);
        grouped.set(entry.nameLower, byMember);
    }

    return [...grouped.entries()]
        .map(([nameLower, byMember]) => {
            const members = sortMembers([...byMember.values()]);
            return {
                name: members[0].name,
                nameLower,
                members,
                ambiguous: members.length > 1,
            };
        })
        .sort((a, b) => a.nameLower.localeCompare(b.nameLower));
}

function resolveGroupByName(nameLower: string, groups: PackageMemberGroup[]): SemanticResolution {
    const group = groups.find((entry) => entry.nameLower === nameLower);
    if (!group) {
        return unresolved();
    }

    if (group.ambiguous) {
        return unresolved(true);
    }

    return resolved(group.members[0]);
}

function resolveUseClauseTargetPackages(
    useClause: UseClauseEntry,
    index: SemanticSymbolIndex
): PackageEntry[] {
    if (!useClause.packageNameLower) {
        return [];
    }

    const candidates = index.findPackages(useClause.packageNameLower);
    if (!useClause.libraryNameLower || useClause.libraryNameLower === "work") {
        return candidates;
    }

    return candidates.length <= 1 ? candidates : [];
}

function getCurrentPackageBody(
    docState: DocState,
    offset: number
): PackageEntry | null {
    return (
        docState.packageBodies.find(
            (entry) => entry.blockStartOffset <= offset && offset <= entry.blockEndOffset
        ) ?? null
    );
}

export function collectPackageMemberGroupsForPackages(
    packages: PackageEntry[],
    currentUri: string,
    offset: number,
    index: SemanticSymbolIndex,
    docState?: DocState
): PackageMemberGroup[] {
    const state = docState ?? getDocState(currentUri, index);
    const members = packages.flatMap((entry) => entry.members);
    const currentBody = getCurrentPackageBody(state, offset);
    if (currentBody) {
        const bodyMatchesReference = packages.some(
            (entry) => entry.nameLower === currentBody.nameLower
        );
        if (bodyMatchesReference) {
            members.push(
                ...currentBody.members.filter((entry) => entry.startOffset <= offset)
            );
        }
    }

    return groupPackageMembers(members);
}

export function collectVisibleImportedMemberGroups(
    currentUri: string,
    offset: number,
    index: SemanticSymbolIndex
): PackageMemberGroup[] {
    const docState = getDocState(currentUri, index);
    const activeUses = getActiveContext(docState, offset).uses;
    const members: PackageMemberEntry[] = [];

    for (const useClause of activeUses) {
        const packages = resolveUseClauseTargetPackages(useClause, index);
        if (packages.length === 0) {
            continue;
        }

        if (useClause.isAll) {
            members.push(...packages.flatMap((entry) => entry.members));
            continue;
        }

        if (!useClause.memberNameLower) {
            continue;
        }

        members.push(
            ...packages.flatMap((entry) =>
                entry.members.filter((member) => member.nameLower === useClause.memberNameLower)
            )
        );
    }

    return groupPackageMembers(members);
}

function resolveImportedSimpleName(
    nameLower: string,
    currentUri: string,
    offset: number,
    index: SemanticSymbolIndex
): SemanticResolution {
    return resolveGroupByName(nameLower, collectVisibleImportedMemberGroups(currentUri, offset, index));
}

function pickBestLocal(
    locals: LocalDecl[],
    wordLower: string,
    wordStart: number,
    wordEnd: number
): LocalDecl | null {
    const hits = locals.filter((entry) => entry.nameLower === wordLower);
    if (hits.length === 0) {
        return null;
    }

    const exact = hits.find(
        (entry) => entry.startOffset <= wordStart && wordEnd <= entry.endOffset
    );
    if (exact) {
        return exact;
    }

    const above = hits.filter((entry) => entry.endOffset <= wordStart);
    if (above.length > 0) {
        return above.reduce((best, entry) =>
            entry.endOffset > best.endOffset ? entry : best
        );
    }

    return hits[0];
}

function resolveCallableParameter(
    callables: CallableEntry[],
    wordLower: string,
    offset: number
): CallableParameterEntry | null {
    const containing = callables
        .filter(
            (entry) =>
                entry.bodyStartOffset !== null &&
                entry.blockStartOffset <= offset &&
                offset <= entry.blockEndOffset
        )
        .sort((a, b) => b.blockStartOffset - a.blockStartOffset);

    for (const callable of containing) {
        const param = callable.params.find((entry) => entry.nameLower === wordLower);
        if (param) {
            return param;
        }
    }

    return null;
}

function resolveExactDocPackage(
    packages: PackageEntry[],
    wordLower: string,
    wordStart: number,
    wordEnd: number
): PackageEntry | null {
    return (
        packages.find(
            (entry) =>
                entry.nameLower === wordLower &&
                entry.nameStartOffset <= wordStart &&
                wordEnd <= entry.nameEndOffset
        ) ?? null
    );
}

function resolveExactPackageMember(
    packages: PackageEntry[],
    wordLower: string,
    wordStart: number,
    wordEnd: number
): PackageMemberEntry | null {
    for (const pkg of packages) {
        const hit = pkg.members.find(
            (entry) => entry.nameLower === wordLower && entry.startOffset <= wordStart && wordEnd <= entry.endOffset
        );
        if (hit) {
            return hit;
        }
    }

    return null;
}

function resolveCurrentPackageScopeMember(
    docState: DocState,
    wordLower: string,
    offset: number
): SemanticResolution {
    const currentBody = getCurrentPackageBody(docState, offset);
    if (currentBody) {
        const publicMatches = groupPackageMembers(
            docState.packages
                .filter((entry) => entry.nameLower === currentBody.nameLower)
                .flatMap((entry) => entry.members.filter((member) => member.nameLower === wordLower))
        );
        const publicResolution = resolveGroupByName(wordLower, publicMatches);
        if (publicResolution.entry || publicResolution.ambiguous) {
            return publicResolution;
        }

        const bodyMatches = groupPackageMembers(
            currentBody.members.filter(
                (entry) => entry.nameLower === wordLower && entry.startOffset <= offset
            )
        );
        const bodyResolution = resolveGroupByName(wordLower, bodyMatches);
        if (bodyResolution.entry || bodyResolution.ambiguous) {
            return bodyResolution;
        }
    }

    const currentPackage = docState.packages.find(
        (entry) => entry.blockStartOffset <= offset && offset <= entry.blockEndOffset
    );
    if (!currentPackage) {
        return unresolved();
    }

    return resolveGroupByName(
        wordLower,
        groupPackageMembers(
            currentPackage.members.filter((entry) => entry.startOffset <= offset)
        )
    );
}

function findMatchingPortLike(unit: DesignUnitEntry, wordLower: string): PortGenericEntry[] {
    return [...unit.ports, ...unit.generics].filter((entry) => entry.nameLower === wordLower);
}

function findPortOrGenericInUnits(
    units: DesignUnitEntry[],
    wordLower: string,
    offset: number
): PortGenericEntry | null {
    for (const unit of units) {
        if (unit.blockStartOffset <= offset && offset <= unit.blockEndOffset) {
            const scoped = findMatchingPortLike(unit, wordLower)[0];
            if (scoped) {
                return scoped;
            }
        }
    }

    for (const unit of units) {
        const hit = findMatchingPortLike(unit, wordLower)[0];
        if (hit) {
            return hit;
        }
    }

    return null;
}

function resolveCurrentPortLike(
    currentUri: string,
    offset: number,
    wordLower: string,
    index: SemanticSymbolIndex,
    docState: DocState
): PortGenericEntry | null {
    const docUnitHit = findPortOrGenericInUnits(
        [...docState.entities, ...docState.components],
        wordLower,
        offset
    );
    if (docUnitHit) {
        return docUnitHit;
    }

    const architecture = getContainingTopLevelUnit(docState.topLevelUnits, offset);
    if (architecture?.kind !== "architecture" || !architecture.entityNameLower) {
        return null;
    }

    const entities = pickBest(
        index.findEntities(architecture.entityNameLower),
        currentUri,
        offset
    );
    if (entities.length === 0) {
        return null;
    }

    return [...entities[0].ports, ...entities[0].generics].find(
        (entry) => entry.nameLower === wordLower
    ) ?? null;
}

function resolvePortFormalEntry(
    text: string,
    wordStart: number,
    wordLower: string,
    currentUri: string,
    index: SemanticSymbolIndex
): SemanticResolution {
    const before = text.slice(Math.max(0, wordStart - PORT_MAP_SEARCH_DISTANCE), wordStart);
    const instPattern = /\b(\w+)\s*:\s*(?:entity\s+\w+\.)?(\w+)\s*(?:generic\s+map\s*\(.*\)\s*)?(?:port\s+map\s*\()?/gim;

    let lastMatch: RegExpExecArray | null = null;
    let match: RegExpExecArray | null;
    while ((match = instPattern.exec(before)) !== null) {
        lastMatch = match;
    }

    if (lastMatch) {
        const unitNameLower = lastMatch[2].toLowerCase();
        const components = pickBest(index.findComponents(unitNameLower), currentUri, wordStart);
        const componentHit = findPortOrGenericInUnits(components, wordLower, wordStart);
        if (componentHit) {
            return resolved(componentHit);
        }

        const entities = pickBest(index.findEntities(unitNameLower), currentUri, wordStart);
        const entityHit = findPortOrGenericInUnits(entities, wordLower, wordStart);
        if (entityHit) {
            return resolved(entityHit);
        }
    }

    return unresolved();
}

function resolvePackageReference(
    packageNameLower: string,
    currentUri: string,
    offset: number,
    index: SemanticSymbolIndex,
    libraryNameLower?: string | null
): PackageEntry | null {
    const candidates = libraryNameLower && libraryNameLower !== "work"
        ? (index.findPackages(packageNameLower).length <= 1
            ? index.findPackages(packageNameLower)
            : [])
        : index.findPackages(packageNameLower);

    return pickBest(candidates, currentUri, offset)[0] ?? null;
}

function shouldTreatTwoSegmentAsLibraryPackage(
    firstSegmentLower: string,
    secondSegmentLower: string,
    currentUri: string,
    offset: number,
    index: SemanticSymbolIndex,
    docState: DocState
): boolean {
    if (isLibraryLikeName(firstSegmentLower, currentUri, offset, index, docState)) {
        return true;
    }

    return (
        index.findPackages(firstSegmentLower).length === 0 &&
        index.findPackages(secondSegmentLower).length > 0
    );
}

function resolvePackageMemberReference(
    packageNameLower: string,
    memberNameLower: string,
    currentUri: string,
    offset: number,
    index: SemanticSymbolIndex,
    docState: DocState,
    libraryNameLower?: string | null
): SemanticResolution {
    const packageCandidates = libraryNameLower && libraryNameLower !== "work"
        ? (index.findPackages(packageNameLower).length <= 1
            ? index.findPackages(packageNameLower)
            : [])
        : index.findPackages(packageNameLower);
    if (packageCandidates.length === 0) {
        return unresolved();
    }

    return resolveGroupByName(
        memberNameLower,
        collectPackageMemberGroupsForPackages(
            packageCandidates,
            currentUri,
            offset,
            index,
            docState
        )
    );
}

function resolveSelectedNameEntry(
    selectedName: SelectedNameInfo,
    currentUri: string,
    offset: number,
    index: SemanticSymbolIndex,
    docState: DocState
): SemanticResolution {
    const { segmentsLower, segmentIndex } = selectedName;

    if (segmentsLower.length === 2) {
        const [firstSegmentLower, secondSegmentLower] = segmentsLower;
        const libraryPackage = shouldTreatTwoSegmentAsLibraryPackage(
            firstSegmentLower,
            secondSegmentLower,
            currentUri,
            offset,
            index,
            docState
        );

        if (segmentIndex === 0) {
            if (libraryPackage) {
                return unresolved();
            }

            const pkg = resolvePackageReference(firstSegmentLower, currentUri, offset, index);
            return pkg ? resolved(pkg) : unresolved();
        }

        if (libraryPackage) {
            const pkg = resolvePackageReference(
                secondSegmentLower,
                currentUri,
                offset,
                index,
                firstSegmentLower
            );
            return pkg ? resolved(pkg) : unresolved();
        }

        return resolvePackageMemberReference(
            firstSegmentLower,
            secondSegmentLower,
            currentUri,
            offset,
            index,
            docState
        );
    }

    if (segmentsLower.length === 3) {
        const [libraryNameLower, packageNameLower, memberNameLower] = segmentsLower;
        if (segmentIndex === 0) {
            return unresolved();
        }

        if (segmentIndex === 1) {
            const pkg = resolvePackageReference(
                packageNameLower,
                currentUri,
                offset,
                index,
                libraryNameLower
            );
            return pkg ? resolved(pkg) : unresolved();
        }

        return resolvePackageMemberReference(
            packageNameLower,
            memberNameLower,
            currentUri,
            offset,
            index,
            docState,
            libraryNameLower
        );
    }

    return unresolved();
}

function resolveSimpleName(
    text: string,
    wordStart: number,
    wordEnd: number,
    wordLower: string,
    currentUri: string,
    index: SemanticSymbolIndex
): SemanticResolution {
    const docState = getDocState(currentUri, index);
    const paramHit = resolveCallableParameter(docState.callables, wordLower, wordStart);
    if (paramHit) {
        return resolved(paramHit);
    }

    const localHit = pickBestLocal(docState.locals, wordLower, wordStart, wordEnd);
    if (localHit) {
        return resolved(localHit);
    }

    const exactPackageMember = resolveExactPackageMember(
        [...docState.packages, ...docState.packageBodies],
        wordLower,
        wordStart,
        wordEnd
    );
    if (exactPackageMember) {
        return resolved(exactPackageMember);
    }

    const currentPackageMember = resolveCurrentPackageScopeMember(docState, wordLower, wordStart);
    if (currentPackageMember.entry || currentPackageMember.ambiguous) {
        return currentPackageMember;
    }

    const exactPackage = resolveExactDocPackage(
        [...docState.packages, ...docState.packageBodies],
        wordLower,
        wordStart,
        wordEnd
    );
    if (exactPackage) {
        return resolved(exactPackage);
    }

    const exactDesignUnit = [...docState.entities, ...docState.components].find(
        (entry) =>
            entry.nameLower === wordLower &&
            entry.nameStartOffset <= wordStart &&
            wordEnd <= entry.nameEndOffset
    );
    if (exactDesignUnit) {
        return resolved(exactDesignUnit);
    }

    const portLike = resolveCurrentPortLike(currentUri, wordStart, wordLower, index, docState);
    if (portLike) {
        return resolved(portLike);
    }

    const imported = resolveImportedSimpleName(wordLower, currentUri, wordStart, index);
    if (imported.entry || imported.ambiguous) {
        return imported;
    }

    const pkg = resolvePackageReference(wordLower, currentUri, wordStart, index);
    if (pkg) {
        return resolved(pkg);
    }

    const entities = pickBest(index.findEntities(wordLower), currentUri, wordStart);
    if (entities.length > 0) {
        return resolved(entities[0]);
    }

    const components = pickBest(index.findComponents(wordLower), currentUri, wordStart);
    if (components.length > 0) {
        return resolved(components[0]);
    }

    return unresolved();
}

export function resolveSemanticEntry(
    text: string,
    wordStart: number,
    wordEnd: number,
    currentUri: string,
    index: SemanticSymbolIndex
): SemanticResolution {
    const wordLower = text.slice(wordStart, wordEnd).toLowerCase();
    if (wordLower.length === 0) {
        return unresolved();
    }

    const ctx = determineContext(text, wordStart, wordEnd);
    if (ctx === "port_map_formal") {
        return resolvePortFormalEntry(text, wordStart, wordLower, currentUri, index);
    }

    if (ctx === "component_decl_name") {
        const components = pickBest(index.findComponents(wordLower), currentUri, wordStart);
        if (components.length > 0) {
            return resolved(components[0]);
        }

        const entities = pickBest(index.findEntities(wordLower), currentUri, wordStart);
        return entities.length > 0 ? resolved(entities[0]) : unresolved();
    }

    if (ctx === "instantiation_target") {
        const components = pickBest(index.findComponents(wordLower), currentUri, wordStart);
        if (components.length > 0) {
            return resolved(components[0]);
        }

        const entities = pickBest(index.findEntities(wordLower), currentUri, wordStart);
        return entities.length > 0 ? resolved(entities[0]) : unresolved();
    }

    const docState = getDocState(currentUri, index);
    const selectedName = getSelectedNameInfo(text, wordStart, wordEnd);
    if (selectedName) {
        const selectedResolution = resolveSelectedNameEntry(
            selectedName,
            currentUri,
            wordStart,
            index,
            docState
        );
        if (selectedResolution.entry || selectedResolution.ambiguous) {
            return selectedResolution;
        }
    }

    return resolveSimpleName(text, wordStart, wordEnd, wordLower, currentUri, index);
}

export function resolveSelectedNameCompletionScope(
    text: string,
    offset: number,
    currentUri: string,
    index: SemanticSymbolIndex
): SelectedNameCompletionScope | null {
    const prefixInfo = getSelectedNamePrefixInfo(text, offset);
    if (!prefixInfo) {
        return null;
    }

    const docState = getDocState(currentUri, index);
    const inUseClause = isUseClauseContext(text, offset);
    const [firstSegmentLower, secondSegmentLower] = prefixInfo.prefixSegmentsLower;
    if (prefixInfo.prefixSegmentsLower.length === 1) {
        if (isLibraryLikeName(firstSegmentLower, currentUri, offset, index, docState)) {
            return {
                kind: "packages",
                packages: pickBest(index.getAllPackages(), currentUri, offset),
                partial: prefixInfo.partial,
                partialLower: prefixInfo.partialLower,
                inUseClause,
            };
        }

        const packageCandidates = index.findPackages(firstSegmentLower);
        if (packageCandidates.length > 0) {
            return {
                kind: "members",
                packages: packageCandidates,
                partial: prefixInfo.partial,
                partialLower: prefixInfo.partialLower,
                inUseClause,
            };
        }

        return {
            kind: "packages",
            packages: pickBest(index.getAllPackages(), currentUri, offset),
            partial: prefixInfo.partial,
            partialLower: prefixInfo.partialLower,
            inUseClause,
        };
    }

    if (prefixInfo.prefixSegmentsLower.length === 2) {
        const packageCandidates = secondSegmentLower
            ? (index.findPackages(secondSegmentLower).length <= 1 || firstSegmentLower === "work"
                ? index.findPackages(secondSegmentLower)
                : [])
            : [];
        return {
            kind: "members",
            packages: packageCandidates,
            partial: prefixInfo.partial,
            partialLower: prefixInfo.partialLower,
            inUseClause,
        };
    }

    return null;
}

export function getSemanticEntryRange(entry: SemanticEntry): Range {
    if ("nameRange" in entry) {
        return entry.nameRange;
    }

    return entry.range;
}

export function getSemanticEntryUri(entry: SemanticEntry, currentUri: string): string {
    return "uri" in entry ? entry.uri : currentUri;
}