import fg from "fast-glob";
import * as fs from "fs";
import * as path from "path";

import {
    Connection,
    InitializeParams,
    TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";

import { VhdlConfig } from "./ghdl";
import {
    CallableEntry,
    DesignUnitEntry,
    IndexResult,
    LibraryClauseEntry,
    LocalDecl,
    PackageEntry,
    TopLevelUnitEntry,
    UseClauseEntry,
    indexText,
} from "./indexing/indexTextSignature";
import { makeTextDocument } from "./indexing/textDocUtils";

// ---------------------------------------------------------------------------
// Internal per-document index record
// ---------------------------------------------------------------------------

interface DocIndex {
    result: IndexResult;
    source: "workspace-scan" | "open-document";
}

// ---------------------------------------------------------------------------
// WorkspaceIndexer
// ---------------------------------------------------------------------------

export class WorkspaceIndexer {
    readonly conn: Connection;
    readonly docs: TextDocuments<TextDocument>;
    vConfig: VhdlConfig;

    /** Per-URI index results */
    private docIndex: Map<string, DocIndex> = new Map();

    /** Global entity lookup: nameLower → DesignUnitEntry[] */
    private entityIndex: Map<string, DesignUnitEntry[]> = new Map();

    /** Global component lookup: nameLower → DesignUnitEntry[] */
    private componentIndex: Map<string, DesignUnitEntry[]> = new Map();

    /** Global callable lookup: nameLower → CallableEntry[] */
    private callableIndex: Map<string, CallableEntry[]> = new Map();

    /** Global package declaration lookup: nameLower → PackageEntry[] */
    private packageIndex: Map<string, PackageEntry[]> = new Map();

    /** Global package body lookup: nameLower → PackageEntry[] */
    private packageBodyIndex: Map<string, PackageEntry[]> = new Map();

    /** mtime cache for incremental reads */
    private mtimeCache: Map<string, number> = new Map();

    /** Workspace root folders (set on start) */
    private workspaceRoots: string[] = [];

    /** Periodic rescan timer handle */
    private rescanTimer: ReturnType<typeof setInterval> | null = null;

    /** Guards against overlapping scans */
    private scanInProgress = false;

    constructor(
        connection: Connection,
        docs: TextDocuments<TextDocument>,
        vhdlConfig: VhdlConfig
    ) {
        this.conn = connection;
        this.docs = docs;
        this.vConfig = vhdlConfig;
        this.conn.console.log("[indexer] constructed");
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    updateConfig(vhdlConfig: VhdlConfig): void {
        this.vConfig = vhdlConfig;
    }

    /**
     * Start the indexer: perform an initial scan and schedule periodic rescans.
     */
    start(initParams: InitializeParams): void {
        this.workspaceRoots = getWorkspaceRoots(initParams);
        this.conn.console.log(
            `[indexer] start – roots: ${JSON.stringify(this.workspaceRoots)}`
        );

        // Initial scan (fire-and-forget; errors are logged inside)
        void this.triggerRescan();

        // Periodic rescan
        const { enabled, rescanIntervalMs } = this.vConfig.workspace.indexing;
        if (enabled && rescanIntervalMs > 0) {
            this.rescanTimer = setInterval(
                () => void this.triggerRescan(),
                rescanIntervalMs
            );
        }
    }

    /** Stop periodic rescans (call on server shutdown or config reload). */
    stop(): void {
        if (this.rescanTimer !== null) {
            clearInterval(this.rescanTimer);
            this.rescanTimer = null;
        }
    }

    /** Manually trigger a workspace rescan (skips if already in progress). */
    async triggerRescan(): Promise<void> {
        if (this.scanInProgress) {
            this.conn.console.log("[indexer] rescan skipped – already in progress");
            return;
        }
        this.scanInProgress = true;
        try {
            await this.performScan();
        } catch (e) {
            this.conn.console.error(`[indexer] scan error: ${String(e)}`);
        } finally {
            this.scanInProgress = false;
        }
    }

    /**
     * Re-index an open document immediately (open document content wins over
     * on-disk content).
     */
    updateOpenDocument(doc: TextDocument): void {
        this.indexOneDocument(doc, "open-document");
    }

    // -----------------------------------------------------------------------
    // Query API (used by definition resolution in server.ts)
    // -----------------------------------------------------------------------

    findEntities(nameLower: string): DesignUnitEntry[] {
        return this.entityIndex.get(nameLower) ?? [];
    }

    findComponents(nameLower: string): DesignUnitEntry[] {
        return this.componentIndex.get(nameLower) ?? [];
    }

    findCallables(nameLower: string): CallableEntry[] {
        return this.callableIndex.get(nameLower) ?? [];
    }

    findPackages(nameLower: string): PackageEntry[] {
        return this.packageIndex.get(nameLower) ?? [];
    }

    findPackageBodies(nameLower: string): PackageEntry[] {
        return this.packageBodyIndex.get(nameLower) ?? [];
    }

    getDocLocals(uri: string): LocalDecl[] {
        return this.docIndex.get(uri)?.result.locals ?? [];
    }

    getDocEntities(uri: string): DesignUnitEntry[] {
        return this.docIndex.get(uri)?.result.entities ?? [];
    }

    getDocComponents(uri: string): DesignUnitEntry[] {
        return this.docIndex.get(uri)?.result.components ?? [];
    }

    getDocCallables(uri: string): CallableEntry[] {
        return this.docIndex.get(uri)?.result.callables ?? [];
    }

    getDocPackages(uri: string): PackageEntry[] {
        return this.docIndex.get(uri)?.result.packages ?? [];
    }

    getDocPackageBodies(uri: string): PackageEntry[] {
        return this.docIndex.get(uri)?.result.packageBodies ?? [];
    }

    getDocLibraryClauses(uri: string): LibraryClauseEntry[] {
        return this.docIndex.get(uri)?.result.libraryClauses ?? [];
    }

    getDocUseClauses(uri: string): UseClauseEntry[] {
        return this.docIndex.get(uri)?.result.useClauses ?? [];
    }

    getDocTopLevelUnits(uri: string): TopLevelUnitEntry[] {
        return this.docIndex.get(uri)?.result.topLevelUnits ?? [];
    }

    /** Return every entity and component entry currently in the global indexes. */
    getAllDesignUnits(): DesignUnitEntry[] {
        const result: DesignUnitEntry[] = [];
        for (const entries of this.entityIndex.values()) {
            result.push(...entries);
        }
        for (const entries of this.componentIndex.values()) {
            result.push(...entries);
        }
        return result;
    }

    getAllCallables(): CallableEntry[] {
        const result: CallableEntry[] = [];
        for (const entries of this.callableIndex.values()) {
            result.push(...entries);
        }
        return result;
    }

    getAllPackages(): PackageEntry[] {
        const result: PackageEntry[] = [];
        for (const entries of this.packageIndex.values()) {
            result.push(...entries);
        }
        return result;
    }

    getAllPackageBodies(): PackageEntry[] {
        const result: PackageEntry[] = [];
        for (const entries of this.packageBodyIndex.values()) {
            result.push(...entries);
        }
        return result;
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    private async performScan(): Promise<void> {
        if (this.workspaceRoots.length === 0) {
            this.conn.console.log("[indexer] no workspace roots – scan skipped");
            return;
        }

        const globs = this.vConfig.workspace.sourceGlobs;
        const filePaths: string[] = [];

        for (const root of this.workspaceRoots) {
            try {
                const found = await fg(globs, {
                    cwd: root,
                    absolute: true,
                    onlyFiles: true,
                    suppressErrors: true,
                });
                filePaths.push(...found);
            } catch (e) {
                this.conn.console.error(
                    `[indexer] glob error in ${root}: ${String(e)}`
                );
            }
        }

        this.conn.console.log(
            `[indexer] scan start – ${filePaths.length} candidate files`
        );

        let indexed = 0;
        let skipped = 0;
        let errors = 0;

        for (const filePath of filePaths) {
            const uri = URI.file(filePath).toString();

            // Open document content wins
            const openDoc = this.docs.get(uri);
            if (openDoc) {
                this.indexOneDocument(openDoc, "open-document");
                indexed++;
                continue;
            }

            // mtime-based incremental read
            try {
                const stat = fs.statSync(filePath);
                const mtime = stat.mtimeMs;
                if (this.mtimeCache.get(uri) === mtime) {
                    skipped++;
                    continue;
                }
                const text = fs.readFileSync(filePath, "utf8");
                const doc = makeTextDocument(uri, text);
                this.indexOneDocument(doc, "workspace-scan");
                this.mtimeCache.set(uri, mtime);
                indexed++;
            } catch (e) {
                this.conn.console.error(
                    `[indexer] read error ${filePath}: ${String(e)}`
                );
                errors++;
            }
        }

        this.conn.console.log(
            `[indexer] scan done – indexed=${indexed} skipped=${skipped} errors=${errors}`
        );
    }

    private indexOneDocument(
        doc: TextDocument,
        source: "workspace-scan" | "open-document"
    ): void {
        const uri = doc.uri;
        try {
            const result = indexText(doc);

            // Remove stale entries for this URI from global indexes
            this.removeFromGlobalIndexes(uri);

            // Store new per-doc index
            this.docIndex.set(uri, { result, source });

            // Add to global indexes
            for (const e of result.entities) {
                const list = this.entityIndex.get(e.nameLower) ?? [];
                list.push(e);
                this.entityIndex.set(e.nameLower, list);
            }
            for (const c of result.components) {
                const list = this.componentIndex.get(c.nameLower) ?? [];
                list.push(c);
                this.componentIndex.set(c.nameLower, list);
            }
            for (const callable of result.callables) {
                const list = this.callableIndex.get(callable.nameLower) ?? [];
                list.push(callable);
                this.callableIndex.set(callable.nameLower, list);
            }
            for (const pkg of result.packages) {
                const list = this.packageIndex.get(pkg.nameLower) ?? [];
                list.push(pkg);
                this.packageIndex.set(pkg.nameLower, list);
            }
            for (const pkgBody of result.packageBodies) {
                const list = this.packageBodyIndex.get(pkgBody.nameLower) ?? [];
                list.push(pkgBody);
                this.packageBodyIndex.set(pkgBody.nameLower, list);
            }
        } catch (e) {
            this.conn.console.error(
                `[indexer] indexText error for ${uri}: ${String(e)}`
            );
        }
    }

    private removeFromGlobalIndexes(uri: string): void {
        for (const [key, entries] of this.entityIndex) {
            const filtered = entries.filter((e) => e.uri !== uri);
            if (filtered.length === 0) {
                this.entityIndex.delete(key);
            } else {
                this.entityIndex.set(key, filtered);
            }
        }
        for (const [key, entries] of this.componentIndex) {
            const filtered = entries.filter((e) => e.uri !== uri);
            if (filtered.length === 0) {
                this.componentIndex.delete(key);
            } else {
                this.componentIndex.set(key, filtered);
            }
        }
        for (const [key, entries] of this.callableIndex) {
            const filtered = entries.filter((entry) => entry.uri !== uri);
            if (filtered.length === 0) {
                this.callableIndex.delete(key);
            } else {
                this.callableIndex.set(key, filtered);
            }
        }
        for (const [key, entries] of this.packageIndex) {
            const filtered = entries.filter((entry) => entry.uri !== uri);
            if (filtered.length === 0) {
                this.packageIndex.delete(key);
            } else {
                this.packageIndex.set(key, filtered);
            }
        }
        for (const [key, entries] of this.packageBodyIndex) {
            const filtered = entries.filter((entry) => entry.uri !== uri);
            if (filtered.length === 0) {
                this.packageBodyIndex.delete(key);
            } else {
                this.packageBodyIndex.set(key, filtered);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWorkspaceRoots(initParams: InitializeParams): string[] {
    const roots: string[] = [];
    if (initParams.workspaceFolders && initParams.workspaceFolders.length > 0) {
        for (const folder of initParams.workspaceFolders) {
            try {
                roots.push(URI.parse(folder.uri).fsPath);
            } catch {
                /* ignore invalid URIs */
            }
        }
    } else if (initParams.rootUri) {
        try {
            roots.push(URI.parse(initParams.rootUri).fsPath);
        } catch {
            /* ignore */
        }
    } else if (initParams.rootPath) {
        roots.push(initParams.rootPath);
    }
    return roots.filter((r) => r && r.length > 0);
}

// ---------------------------------------------------------------------------
// Context-determination look-around distances
// ---------------------------------------------------------------------------

/** How many characters to look behind the cursor for context detection.
 *  Large enough to span a typical instantiation label and component name. */
const CONTEXT_LOOKBACK_CHARS = 400;

/** How many characters to look ahead for the `=>` that marks a port-map formal. */
const CONTEXT_LOOKAHEAD_CHARS = 200;

// ---------------------------------------------------------------------------
// Definition resolution helpers (exported for use in server.ts)
// ---------------------------------------------------------------------------

export type DefinitionContext =
    | "port_map_formal"
    | "component_decl_name"
    | "instantiation_target"
    | "general";

/**
 * Determine the VHDL context of the identifier at [wordStart, wordEnd) by
 * inspecting the surrounding text.
 */
export function determineContext(
    text: string,
    wordStart: number,
    wordEnd: number
): DefinitionContext {
    const before = text
        .slice(Math.max(0, wordStart - CONTEXT_LOOKBACK_CHARS), wordStart)
        .toLowerCase();
    const after = text
        .slice(wordEnd, Math.min(text.length, wordEnd + CONTEXT_LOOKAHEAD_CHARS))
        .toLowerCase();

    // Formal side of a port/generic map association: word =>
    if (/^\s*=>/.test(after)) {
        return "port_map_formal";
    }

    // Component declaration name: component <cursor>
    if (/\bcomponent\s+$/.test(before)) {
        return "component_decl_name";
    }

    // Instantiation target: label : <cursor>  (possibly 'entity' keyword before)
    // Handles: inst1 : my_comp  and  inst1 : entity work.my_comp
    const statementBoundary = Math.max(before.lastIndexOf(";"), before.lastIndexOf("\n"));
    const statementFragment = before.slice(statementBoundary + 1);
    if (/^\s*(signal|variable|constant|alias|subtype|type|file)\b/.test(statementFragment)) {
        return "general";
    }

    if (/^\s*\w+\s*:\s*(?:entity\s+\w+\.)?$/.test(statementFragment)) {
        return "instantiation_target";
    }

    return "general";
}

/**
 * Pick the best candidate(s) for definition navigation using tie-breakers:
 * 1. Same file
 * 2. If same file, nearest above cursor
 * 3. Same directory
 * 4. Path proximity (shorter common prefix)
 *
 * Returns all candidates sorted best-first; callers can take [0] or [:N].
 */
export function pickBest<T extends { uri: string; nameStartOffset: number }>(
    candidates: T[],
    currentUri: string,
    currentOffset: number
): T[] {
    if (candidates.length <= 1) return candidates.slice();

    const currentFsPath = tryFsPath(currentUri);
    const currentDir = currentFsPath
        ? path.dirname(currentFsPath)
        : "";

    return [...candidates].sort((a, b) => {
        const aIsSameFile = a.uri === currentUri;
        const bIsSameFile = b.uri === currentUri;

        // Same-file entries come first
        if (aIsSameFile !== bIsSameFile) return aIsSameFile ? -1 : 1;

        if (aIsSameFile && bIsSameFile) {
            // Within same file: prefer nearest above cursor
            const aAbove = a.nameStartOffset <= currentOffset;
            const bAbove = b.nameStartOffset <= currentOffset;
            if (aAbove !== bAbove) return aAbove ? -1 : 1;
            if (aAbove && bAbove) {
                // Both above: prefer the one closer (larger offset)
                return b.nameStartOffset - a.nameStartOffset;
            }
            // Both below: prefer closer (smaller offset)
            return a.nameStartOffset - b.nameStartOffset;
        }

        // Different files: prefer same directory
        const aFsPath = tryFsPath(a.uri) ?? "";
        const bFsPath = tryFsPath(b.uri) ?? "";
        const aDir = path.dirname(aFsPath);
        const bDir = path.dirname(bFsPath);
        const aIsSameDir = aDir === currentDir;
        const bIsSameDir = bDir === currentDir;
        if (aIsSameDir !== bIsSameDir) return aIsSameDir ? -1 : 1;

        // Path proximity: longer common prefix = more related
        const aCommon = commonPrefixLength(currentFsPath ?? "", aFsPath);
        const bCommon = commonPrefixLength(currentFsPath ?? "", bFsPath);
        return bCommon - aCommon;
    });
}

function tryFsPath(uri: string): string | undefined {
    try {
        return URI.parse(uri).fsPath;
    } catch {
        return undefined;
    }
}

function commonPrefixLength(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
}