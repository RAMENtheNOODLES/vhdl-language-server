#!/usr/bin/env node
/**
 * VHDL Language Server
 * Implements the Language Server Protocol (LSP) for VHDL with optional GHDL integration.
 */

console.log = () => {};

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  CompletionItem,
  CompletionItemKind,
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
  VHDL_KEYWORDS,
} from "./ghdl";

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

function ghdlDiagnosticsFor(uri: string, fsPath: string): Map<string, Diagnostic[]> {
  const byUri = new Map<string, Diagnostic[]>();

  try {
    const entries = runGhdl(fsPath, vhdlConfig);
    for (const [entryUri, entryList] of entries) {
      const diags: Diagnostic[] = entryList.map((e) => ({
        range: {
          start: { line: Math.max(0, e.line - 1), character: Math.max(0, e.column - 1) },
          end: { line: Math.max(0, e.line - 1), character: Math.max(0, e.column) },
        },
        severity: e.severity,
        source: 'ghdl',
        message: e.message,
      }));
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
        triggerCharacters: [],
      },
      documentSymbolProvider: true,
      definitionProvider: true,
      workspaceSymbolProvider: true,
    },
    serverInfo: {
      name: "vhdl-language-server",
      version: "0.2.0",
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
  publishDiagnostics(uri, fsPath);
});

documents.onDidSave((event: TextDocumentChangeEvent<TextDocument>) => {
  const uri = event.document.uri;
  const fsPath = URI.parse(uri).fsPath;
  connection.console.log(`didChange: ${event.document.uri}`);
  publishDiagnostics(uri, fsPath);
});

documents.onDidChangeContent((event: TextDocumentChangeEvent<TextDocument>) => {
  const { uri } = event.document;
  const fsPath = URI.parse(uri).fsPath;
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
  (_params: TextDocumentPositionParams): CompletionItem[] => {
    return VHDL_KEYWORDS.map((keyword) => ({
      label: keyword,
      kind: CompletionItemKind.Keyword,
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
// Definition provider (stub)
// ---------------------------------------------------------------------------

connection.onDefinition((_params: DefinitionParams): Location[] => {
  return [];
});

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
