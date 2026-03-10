#!/usr/bin/env node
/**
 * VHDL Language Server
 * Implements the Language Server Protocol (LSP) for VHDL with optional GHDL integration.
 */

console.log = () => {};

import { readFileSync } from "fs";

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  CompletionItem,
  TextDocumentPositionParams,
  Hover,
  MarkupKind,
  DocumentSymbolParams,
  SymbolInformation,
  DefinitionParams,
  Location,
  WorkspaceSymbolParams,
  Diagnostic,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  TextDocumentChangeEvent,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";

import {
  VhdlConfig,
  defaultConfig,
  mergeConfig,
  debounce,
  runGhdl,
  inferDiagnosticCharacterRange,
  VHDL_KEYWORDS,
} from "./ghdl";
import {
  WorkspaceIndexer,
  determineContext,
  pickBest,
} from "./workspaceIndexer";
import {
  formatHoverMarkdown,
  resolveHoverEntry,
} from "./hoverResolver";
import { resolveCompletionItems } from "./completionResolver";
import type { DesignUnitEntry } from "./indexing/indexTextSignature";

// ---------------------------------------------------------------------------
// LSP server setup
// ---------------------------------------------------------------------------

let initParams: InitializeParams|undefined;

const connection = createConnection(ProposedFeatures.all);

process.on('uncaughtException', (err) => {
  connection.console.error(`[fatal] uncaughtException: ${err?.stack ?? String(err)}`);
});

process.on('unhandledRejection', (reason) => {
  connection.console.error(`[fatal] unhandledRejection: ${String(reason)}`);
});

const documents = new TextDocuments(TextDocument);

let vhdlConfig: VhdlConfig = { ...defaultConfig };

// Workspace indexer (initialised after configuration is loaded)
let indexer: WorkspaceIndexer = new WorkspaceIndexer(connection, documents, vhdlConfig);

// Debounced diagnostic publisher (rebuilt when config changes)
let debouncedDiagnostics: ((uri: string, fsPath: string) => void) | null = null;

function buildDebouncedDiagnostics(): void {
  debouncedDiagnostics = debounce((uri: string, fsPath: string) => {
    publishDiagnostics(uri, fsPath);
  }, vhdlConfig.ghdl.debounceMs);
}

buildDebouncedDiagnostics();

// ---------------------------------------------------------------------------
// Diagnostic publishing
// ---------------------------------------------------------------------------

function basicDiagnostics(_uri: string, document: TextDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const text = document.getText();
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    // Flag lines that start with `--!` as hints (example placeholder check)
    if (lines[i].trimStart().startsWith("--!")) {
      diagnostics.push({
        range: {
          start: { line: i, character: 0 },
          end: { line: i, character: lines[i].length },
        },
        severity: DiagnosticSeverity.Hint,
        source: "vhdl-ls",
        message: "Annotation comment detected.",
      });
    }
  }

  return diagnostics;
}

function getDiagnosticLines(
  uri: string,
  cache: Map<string, string[] | null>
): string[] | undefined {
  if (!cache.has(uri)) {
    const openDocument = documents.get(uri);
    if (openDocument) {
      cache.set(uri, openDocument.getText().split(/\r?\n/));
    } else {
      try {
        const fsPath = URI.parse(uri).fsPath;
        cache.set(uri, readFileSync(fsPath, "utf8").split(/\r?\n/));
      } catch {
        cache.set(uri, null);
      }
    }
  }

  return cache.get(uri) ?? undefined;
}

function ghdlDiagnosticsFor(uri: string, fsPath: string): Map<string, Diagnostic[]> {
  const byUri = new Map<string, Diagnostic[]>();
  const lineCache = new Map<string, string[] | null>();

  try {
    const entries = runGhdl(fsPath, vhdlConfig);
    for (const [entryUri, entryList] of entries) {
      const lineText = getDiagnosticLines(entryUri, lineCache);
      const diags: Diagnostic[] = entryList.map((e) => {
        const range = inferDiagnosticCharacterRange(
          lineText?.[Math.max(0, e.line - 1)],
          e.column,
          e.message
        );

        return {
          range: {
            start: {
              line: Math.max(0, e.line - 1),
              character: range.startCharacter,
            },
            end: {
              line: Math.max(0, e.line - 1),
              character: range.endCharacter,
            },
          },
          severity: e.severity,
          source: 'ghdl',
          message: e.message,
        };
      });
      byUri.set(entryUri, diags);
    }
  } catch (e) {
    console.error(`runGhdl failed: ${String(e)}`);
    byUri.set(uri, []);
  }

  if (!byUri.has(uri)) byUri.set(uri, []);
  return byUri;
}

function publishDiagnostics(uri: string, fsPath: string): void {
  const mode = vhdlConfig.diagnostics.mode;
  if (mode === "off") {
    connection.sendDiagnostics({ uri, diagnostics: [] });
    return;
  }

  const document = documents.get(uri);

  const combined = new Map<string, Diagnostic[]>();

  if ((mode === "basic" || mode === "both") && document) {
    const basic = basicDiagnostics(uri, document);
    combined.set(uri, basic);
  }

  if (mode === "ghdl" || mode === "both") {
    const ghdlMap = ghdlDiagnosticsFor(uri, fsPath);
    for (const [u, diags] of ghdlMap) {
      const existing = combined.get(u) ?? [];
      combined.set(u, [...existing, ...diags]);
    }
  }

  connection.console.log(`publishDiagnostics: ${uri} mode=${vhdlConfig.diagnostics.mode}`);

  for (const [u, diags] of combined) {
    connection.console.log(`sendDiagnostics: uri=${u} count=${diags.length}`);
    connection.sendDiagnostics({ uri: u, diagnostics: diags });
  }
}

// ---------------------------------------------------------------------------
// Configuration loading
// ---------------------------------------------------------------------------

async function loadConfiguration(): Promise<void> {
  try {
    const settings = await connection.workspace.getConfiguration({
      section: "vhdl",
    });
    if (settings && typeof settings === "object") {
      vhdlConfig = mergeConfig(defaultConfig, settings as Partial<VhdlConfig>);
    }
  } catch {
    // Client may not support workspace/configuration — keep defaults
  }
  buildDebouncedDiagnostics();
  indexer.updateConfig(vhdlConfig);
}

// ---------------------------------------------------------------------------
// LSP lifecycle handlers
// ---------------------------------------------------------------------------

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  initParams = _params;
  connection.console.log(`initialize: rootUri=${_params.rootUri ?? ''}`);
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ["(", ",", ":", "."],
      },
      documentSymbolProvider: true,
      definitionProvider: true,
      workspaceSymbolProvider: true,
    },
    serverInfo: {
      name: "vhdl-language-server",
      version: "0.3.0",
    },
  };
});

connection.onInitialized(async () => {
  connection.console.log('initialized');

  try {
    connection.console.log('onInitialized: before loadConfiguration');
    await loadConfiguration();
    connection.console.log('onInitialized: after loadConfiguration');
  } catch (e) {
    connection.console.error(`onInitialized: loadConfiguration failed: ${String(e)}`);
  }

  // Start workspace indexer (uses initParams set during onInitialize)
  if (initParams && vhdlConfig.workspace.indexing.enabled) {
    indexer.start(initParams);
  }

  try {
    const caps = initParams?.capabilities;
    const supportsDidChangeConfig =
      !!caps?.workspace?.didChangeConfiguration?.dynamicRegistration;

    connection.console.log(
      `onInitialized: supports didChangeConfiguration dynamicRegistration = ${supportsDidChangeConfig}`
    );

    if (supportsDidChangeConfig) {
      connection.console.log('onInitialized: before client.register(didChangeConfiguration)');
      await connection.client.register(DidChangeConfigurationNotification.type, {
        section: 'vhdl',
      });
      connection.console.log('onInitialized: after client.register(didChangeConfiguration)');
    }
  } catch (e) {
    connection.console.error(`onInitialized: client.register failed: ${String(e)}`);
  }

  connection.console.log('onInitialized: done');
});

connection.onDidChangeConfiguration(async () => {
  await loadConfiguration();

  // Restart indexer with updated config
  indexer.stop();
  if (initParams && vhdlConfig.workspace.indexing.enabled) {
    indexer.start(initParams);
  }

  // Re-publish diagnostics for all open documents after config change
  for (const document of documents.all()) {
    const fsPath = URI.parse(document.uri).fsPath;
    publishDiagnostics(document.uri, fsPath);
  }
});

// ---------------------------------------------------------------------------
// Text document event handlers
// ---------------------------------------------------------------------------

documents.onDidOpen((event: TextDocumentChangeEvent<TextDocument>) => {
  const { uri } = event.document;
  const fsPath = URI.parse(uri).fsPath;
  connection.console.log(`didOpen: ${event.document.uri}`);
  indexer.updateOpenDocument(event.document);
  publishDiagnostics(uri, fsPath);
});

documents.onDidSave((event: TextDocumentChangeEvent<TextDocument>) => {
  const uri = event.document.uri;
  const fsPath = URI.parse(uri).fsPath;
  connection.console.log(`didChange: ${event.document.uri}`);
  indexer.updateOpenDocument(event.document);
  publishDiagnostics(uri, fsPath);
});

documents.onDidChangeContent((event: TextDocumentChangeEvent<TextDocument>) => {
  const { uri } = event.document;
  const fsPath = URI.parse(uri).fsPath;
  indexer.updateOpenDocument(event.document);
  if (vhdlConfig.ghdl.run === "onType" && debouncedDiagnostics) {
    debouncedDiagnostics(uri, fsPath);
  }
});

documents.onDidClose((event: TextDocumentChangeEvent<TextDocument>) => {
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

// ---------------------------------------------------------------------------
// Hover provider
// ---------------------------------------------------------------------------

connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const text = document.getText();
  const offset = document.offsetAt(params.position);

  // Extract the word under the cursor
  const wordRange = getWordRangeAtOffset(text, offset);
  if (!wordRange) {
    return null;
  }

  const word = text.slice(wordRange.start, wordRange.end).toLowerCase();

  if (VHDL_KEYWORDS.includes(word)) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**\`${word}\`** — VHDL keyword`,
      },
    };
  }

  const hoverEntry = resolveHoverEntry(
    text,
    wordRange.start,
    wordRange.end,
    params.textDocument.uri,
    indexer
  );
  if (!hoverEntry) {
    return null;
  }

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: formatHoverMarkdown(hoverEntry),
    },
    range: {
      start: document.positionAt(wordRange.start),
      end: document.positionAt(wordRange.end),
    },
  };

  return null;
});

function getWordRangeAtOffset(
  text: string,
  offset: number
): { start: number; end: number } | null {
  if (offset < 0 || offset >= text.length) {
    return null;
  }

  const wordChars = /\w/;
  if (!wordChars.test(text[offset])) {
    return null;
  }

  let start = offset;
  while (start > 0 && wordChars.test(text[start - 1])) {
    start--;
  }

  let end = offset;
  while (end < text.length && wordChars.test(text[end])) {
    end++;
  }

  return { start, end };
}

// ---------------------------------------------------------------------------
// Completion provider
// ---------------------------------------------------------------------------

connection.onCompletion(
  (params: TextDocumentPositionParams): CompletionItem[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
      return [];
    }

    const text = document.getText();
    const offset = document.offsetAt(params.position);

    return resolveCompletionItems(text, offset, params.textDocument.uri, indexer).map((item) => ({
      label: item.label,
      kind: item.kind,
      detail: item.detail,
      sortText: item.sortText,
    }));
  }
);

// ---------------------------------------------------------------------------
// Document symbol provider (stub)
// ---------------------------------------------------------------------------

connection.onDocumentSymbol(
  (_params: DocumentSymbolParams): SymbolInformation[] => {
    return [];
  }
);

// ---------------------------------------------------------------------------
// Definition provider
// ---------------------------------------------------------------------------

connection.onDefinition((params: DefinitionParams): Location[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const text = doc.getText();
  const offset = doc.offsetAt(params.position);

  // Extract the identifier under cursor
  const wordRange = getWordRangeAtOffset(text, offset);
  if (!wordRange) return [];

  const word = text.slice(wordRange.start, wordRange.end);
  const wordLower = word.toLowerCase();

  // Skip VHDL keywords
  if (VHDL_KEYWORDS.includes(wordLower)) return [];

  const ctx = determineContext(text, wordRange.start, wordRange.end);
  const currentUri = params.textDocument.uri;

  // --- Context: formal side of port/generic map  (word =>)  ---
  if (ctx === "port_map_formal") {
    return resolvePortFormal(text, wordRange.start, wordLower, currentUri);
  }

  // --- Context: component declaration name  (component <cursor>)  ---
  if (ctx === "component_decl_name") {
    const entities = pickBest(
      indexer.findEntities(wordLower),
      currentUri,
      offset
    );
    return toLocations(entities.slice(0, 1));
  }

  // --- Context: instantiation target  (label : <cursor>)  ---
  if (ctx === "instantiation_target") {
    // Prefer component declaration; fall back to entity
    const comps = pickBest(
      indexer.findComponents(wordLower),
      currentUri,
      offset
    );
    if (comps.length > 0) return toLocations(comps.slice(0, 1));

    const entities = pickBest(
      indexer.findEntities(wordLower),
      currentUri,
      offset
    );
    return toLocations(entities.slice(0, 1));
  }

  // --- General: local decls → entity ports → global fallback ---
  return resolveGeneral(text, offset, wordLower, currentUri);
});

/** Convert DesignUnitEntry[] to Location[] (using the name-identifier range). */
function toLocations(entries: DesignUnitEntry[]): Location[] {
  return entries.map((e) => ({ uri: e.uri, range: e.nameRange }));
}

/**
 * How far backwards (in characters) to search for an instantiation pattern
 * when resolving a port-map formal.  Large enough to span a typical
 * instantiation statement with generic map and multi-line port associations.
 */
const PORT_MAP_SEARCH_DISTANCE = 2000;

/**
 * Resolve the formal side of a port/generic map association.
 * Walks backwards from wordStart to find which component/entity is being
 * instantiated, then locates the matching port/generic.
 */
function resolvePortFormal(
  text: string,
  wordStart: number,
  wordLower: string,
  currentUri: string
): Location[] {
  // Search backwards for an instantiation label + component name
  const before = text.slice(Math.max(0, wordStart - PORT_MAP_SEARCH_DISTANCE), wordStart);

  // Try to find:  label : [entity work.]comp_name  [generic map (...)] port map (
  // We look for the last occurrence of a pattern like:  identifier : [entity word.] identifier
  const instPattern = /\b(\w+)\s*:\s*(?:entity\s+\w+\.)?(\w+)\s*(?:generic\s+map\s*\(.*\)\s*)?(?:port\s+map\s*\()?/gim;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = instPattern.exec(before)) !== null) {
    lastMatch = m;
  }

  if (lastMatch) {
    const compNameLower = lastMatch[2].toLowerCase();

    // Search the component's ports in all indexed docs
    const candidates = findPortOrGenericInUnit(compNameLower, wordLower, currentUri);
    if (candidates.length > 0) return candidates;
  }

  // Fallback: search all entities/components for the port name
  return findPortOrGenericGlobal(wordLower, currentUri);
}

/**
 * Find a port/generic named `portNameLower` in the component or entity
 * named `unitNameLower`.
 */
function findPortOrGenericInUnit(
  unitNameLower: string,
  portNameLower: string,
  currentUri: string
): Location[] {
  // Try component first
  const compCandidates = pickBest(
    indexer.findComponents(unitNameLower),
    currentUri,
    0
  );
  for (const comp of compCandidates) {
    const hit = [...comp.ports, ...comp.generics].find(
      (p) => p.nameLower === portNameLower
    );
    if (hit) return [{ uri: comp.uri, range: hit.range }];
  }

  // Then entity
  const entCandidates = pickBest(
    indexer.findEntities(unitNameLower),
    currentUri,
    0
  );
  for (const ent of entCandidates) {
    const hit = [...ent.ports, ...ent.generics].find(
      (p) => p.nameLower === portNameLower
    );
    if (hit) return [{ uri: ent.uri, range: hit.range }];
  }

  return [];
}

/**
 * Scan all indexed entities/components for a port/generic with the given name.
 */
function findPortOrGenericGlobal(
  portNameLower: string,
  currentUri: string
): Location[] {
  const results: Location[] = [];
  for (const unit of indexer.getAllDesignUnits()) {
    const hit = [...unit.ports, ...unit.generics].find(
      (p) => p.nameLower === portNameLower
    );
    if (hit) results.push({ uri: unit.uri, range: hit.range });
  }
  // Sort: same-file first
  results.sort((a, b) => {
    const aLocal = a.uri === currentUri ? -1 : 1;
    const bLocal = b.uri === currentUri ? -1 : 1;
    return aLocal - bLocal;
  });
  return results.slice(0, 1);
}

/**
 * General resolution: local declarations → entity ports/generics in current
 * doc → global entity/component index.
 */
function resolveGeneral(
  text: string,
  offset: number,
  wordLower: string,
  currentUri: string
): Location[] {
  const doc = documents.get(currentUri);

  // 1. Local declarations in the current document
  const locals = indexer.getDocLocals(currentUri);
  const localHits = locals.filter((l) => l.nameLower === wordLower);
  if (localHits.length > 0) {
    // Pick the nearest declaration above cursor
    const above = localHits.filter((l) => l.endOffset <= offset);
    const best = above.length > 0
      ? above.reduce((a, b) => (a.endOffset > b.endOffset ? a : b))
      : localHits[0];
    if (doc) {
      return [{ uri: currentUri, range: best.range }];
    }
  }

  // 2. Ports/generics of entities declared in the current document
  const docEntities = indexer.getDocEntities(currentUri);
  for (const ent of docEntities) {
    const hit = [...ent.ports, ...ent.generics].find(
      (p) => p.nameLower === wordLower
    );
    if (hit) return [{ uri: currentUri, range: hit.range }];
  }

  // 3. Global entity/component index
  const entities = pickBest(
    indexer.findEntities(wordLower),
    currentUri,
    offset
  );
  if (entities.length > 0) return toLocations(entities.slice(0, 1));

  const comps = pickBest(
    indexer.findComponents(wordLower),
    currentUri,
    offset
  );
  if (comps.length > 0) return toLocations(comps.slice(0, 1));

  return [];
}

// ---------------------------------------------------------------------------
// Workspace symbol provider (stub)
// ---------------------------------------------------------------------------

connection.onWorkspaceSymbol(
  (_params: WorkspaceSymbolParams): SymbolInformation[] => {
    return [];
  }
);

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

documents.listen(connection);
connection.listen();
