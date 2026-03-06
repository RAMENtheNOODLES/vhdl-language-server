/**
 * GHDL output parsing utilities and URI helpers.
 * Pure functions — no side effects, no LSP connection required.
 */

import { DiagnosticSeverity } from "vscode-languageserver/node";
import { URI } from "vscode-uri";
import { spawnSync } from "child_process";
import * as path from "path";

// ---------------------------------------------------------------------------
// Configuration types (exported so server.ts and tests can share them)
// ---------------------------------------------------------------------------

export interface VhdlGhdlConfig {
  path: string;
  args: string[];
  run: "onSave" | "onType";
  debounceMs: number;
}

export interface VhdlWorkspaceIndexingConfig {
  enabled: boolean;
  rescanIntervalMs: number;
}

export interface VhdlWorkspaceConfig {
  sourceGlobs: string[];
  indexing: VhdlWorkspaceIndexingConfig;
}

export interface VhdlDiagnosticsConfig {
  mode: "basic" | "ghdl" | "both" | "off";
}

export interface VhdlConfig {
  languageStandard: "87" | "93" | "02" | "08" | "19";
  diagnostics: VhdlDiagnosticsConfig;
  ghdl: VhdlGhdlConfig;
  workspace: VhdlWorkspaceConfig;
}

export const defaultConfig: VhdlConfig = {
  languageStandard: "08",
  diagnostics: { mode: "both" },
  ghdl: {
    path: "",
    args: [],
    run: "onSave",
    debounceMs: 500,
  },
  workspace: {
    sourceGlobs: ["**/*.vhd", "**/*.vhdl", "**/*.vho", "**/*.vht"],
    indexing: {
      enabled: true,
      rescanIntervalMs: 30000,
    },
  },
};

// ---------------------------------------------------------------------------
// GHDL diagnostic parsing
// ---------------------------------------------------------------------------

/**
 * Represents a single parsed GHDL diagnostic message.
 */
export interface GhdlDiagnosticEntry {
  filePath: string;
  line: number;
  column: number;
  message: string;
  severity: DiagnosticSeverity;
}

export interface DiagnosticCharacterRange {
  startCharacter: number;
  endCharacter: number;
}

function isWordCharacter(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function isPunctuationCharacter(char: string): boolean {
  return char.length > 0 && !isWhitespace(char) && !isWordCharacter(char);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function findDiagnosticAnchor(lineText: string, column: number): number {
  if (lineText.length === 0) {
    return 0;
  }

  let anchor = clamp(column - 1, 0, lineText.length - 1);
  if (!isWhitespace(lineText[anchor])) {
    return anchor;
  }

  let right = anchor;
  while (right < lineText.length && isWhitespace(lineText[right])) {
    right++;
  }
  if (right < lineText.length) {
    return right;
  }

  let left = anchor;
  while (left > 0 && isWhitespace(lineText[left])) {
    left--;
  }
  return left;
}

function extractDiagnosticMessageCandidates(message: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /"([^"\r\n]+)"/g,
    /'([^'\r\n]+)'/g,
    /`([^`\r\n]+)`/g,
  ];

  const addCandidate = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      return;
    }

    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    candidates.push(trimmed);
  };

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(message)) !== null) {
      addCandidate(match[0]);
      addCandidate(match[1]);
    }
  }

  return candidates;
}

function findAllCaseInsensitiveOccurrences(text: string, search: string): number[] {
  const haystack = text.toLowerCase();
  const needle = search.toLowerCase();
  const hits: number[] = [];

  let index = haystack.indexOf(needle);
  while (index !== -1) {
    hits.push(index);
    index = haystack.indexOf(needle, index + 1);
  }

  return hits;
}

function findCandidateRange(
  lineText: string,
  anchor: number,
  candidate: string
): DiagnosticCharacterRange | null {
  const hits = findAllCaseInsensitiveOccurrences(lineText, candidate);
  if (hits.length === 0) {
    return null;
  }

  const exactStart = hits.find((hit) => hit === anchor);
  if (exactStart !== undefined) {
    return {
      startCharacter: exactStart,
      endCharacter: exactStart + candidate.length,
    };
  }

  const containing = hits.find(
    (hit) => hit <= anchor && anchor < hit + candidate.length
  );
  if (containing !== undefined) {
    return {
      startCharacter: containing,
      endCharacter: containing + candidate.length,
    };
  }

  const nearest = hits.reduce((best, hit) => {
    if (best === null) {
      return hit;
    }

    const bestDistance = Math.abs(best - anchor);
    const currentDistance = Math.abs(hit - anchor);
    if (currentDistance < bestDistance) {
      return hit;
    }

    if (currentDistance === bestDistance && hit > best) {
      return hit;
    }

    return best;
  }, null as number | null);

  if (nearest === null) {
    return null;
  }

  return {
    startCharacter: nearest,
    endCharacter: nearest + candidate.length,
  };
}

function expandTokenRange(lineText: string, anchor: number): DiagnosticCharacterRange {
  const currentChar = lineText[anchor];

  if (currentChar === '"' || currentChar === "'") {
    let end = anchor + 1;
    while (end < lineText.length) {
      if (lineText[end] === currentChar) {
        end++;
        break;
      }
      end++;
    }

    return {
      startCharacter: anchor,
      endCharacter: Math.max(anchor + 1, end),
    };
  }

  if (isWordCharacter(currentChar)) {
    let start = anchor;
    while (start > 0 && isWordCharacter(lineText[start - 1])) {
      start--;
    }

    let end = anchor + 1;
    while (end < lineText.length && isWordCharacter(lineText[end])) {
      end++;
    }

    return { startCharacter: start, endCharacter: end };
  }

  let start = anchor;
  while (start > 0 && isPunctuationCharacter(lineText[start - 1])) {
    start--;
  }

  let end = anchor + 1;
  while (end < lineText.length && isPunctuationCharacter(lineText[end])) {
    end++;
  }

  return { startCharacter: start, endCharacter: end };
}

/**
 * Infer a diagnostic character range from a GHDL line/column location.
 *
 * GHDL reports only a starting column. This expands that location to the
 * quoted symbol from the message when possible, otherwise to the token-like
 * fragment at the reported column.
 */
export function inferDiagnosticCharacterRange(
  lineText: string | undefined,
  column: number,
  message: string
): DiagnosticCharacterRange {
  const startCharacter = Math.max(0, column - 1);

  if (!lineText || lineText.length === 0) {
    return {
      startCharacter,
      endCharacter: startCharacter + 1,
    };
  }

  const anchor = findDiagnosticAnchor(lineText, column);

  for (const candidate of extractDiagnosticMessageCandidates(message)) {
    const candidateRange = findCandidateRange(lineText, anchor, candidate);
    if (candidateRange) {
      return candidateRange;
    }
  }

  return expandTokenRange(lineText, anchor);
}

/**
 * Parse a single line of GHDL output into a diagnostic entry.
 *
 * GHDL output format (with Windows drive-letter support):
 *   <filepath>:<line>:<col>:<kind>: <message>
 *
 * On Windows, file paths may start with a drive letter, e.g.:
 *   C:\proj\top.vhd:12:3:warning: undefined identifier
 *
 * Strategy: match from the right so the drive-letter colon is not confused
 * with the field separator.  The regex anchors on the numeric line/column
 * and the severity word so the file-path fragment is captured as everything
 * that comes before.
 *
 * @param line - A single line of GHDL stderr/stdout output.
 * @returns A parsed entry, or `null` if the line does not match.
 */
export function parseGhdlOutputLine(line: string): GhdlDiagnosticEntry | null {
  // Match: <anything>:<digits>:<digits>:<severity>: <rest>
  // The file path is captured lazily so drive-letter colons are preserved.
  const match = line.match(
    /^(.*):(\d+):(\d+):(error|warning|note|failure):\s*(.*)$/i
  );
  if (!match) {
    return null;
  }

  const [, filePath, lineStr, colStr, severityStr, message] = match;
  const lineNum = parseInt(lineStr, 10);
  const colNum = parseInt(colStr, 10);

  let severity: DiagnosticSeverity;
  switch (severityStr.toLowerCase()) {
    case "error":
    case "failure":
      severity = DiagnosticSeverity.Error;
      break;
    case "warning":
      severity = DiagnosticSeverity.Warning;
      break;
    case "note":
    default:
      severity = DiagnosticSeverity.Information;
      break;
  }

  return {
    filePath: filePath.trim(),
    line: lineNum,
    column: colNum,
    message: message.trim(),
    severity,
  };
}

/**
 * Parse all lines of GHDL output and return diagnostic entries.
 */
export function parseGhdlOutput(output: string): GhdlDiagnosticEntry[] {
  return output
    .split(/\r?\n/)
    .map(parseGhdlOutputLine)
    .filter((e): e is GhdlDiagnosticEntry => e !== null);
}

/**
 * Convert a file-system path to a `file://` URI string.
 * Works correctly on both Windows and POSIX systems.
 */
export function filePathToUri(filePath: string): string {
  return URI.file(filePath).toString();
}

// ---------------------------------------------------------------------------
// GHDL runner
// ---------------------------------------------------------------------------

/**
 * Run GHDL analyze on the given file and return parsed diagnostics grouped
 * by document URI.
 */
export function runGhdl(
  filePath: string,
  config: VhdlConfig
): Map<string, GhdlDiagnosticEntry[]> {
  const ghdlBin = config.ghdl.path || "ghdl";
  const stdFlag = `--std=${config.languageStandard}`;
  const args = ["-a", stdFlag, ...config.ghdl.args, filePath];

  const result = spawnSync(ghdlBin, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  console.error(`[vhdl-ls] ghdlBin=${ghdlBin}`);
  console.error(`[vhdl-ls] args=${JSON.stringify(args)}`);
  console.error(`[vhdl-ls] status=${result.status} signal=${result.signal} error=${result.error ? String(result.error) : ''}`);
  console.error(`[vhdl-ls] stdoutLen=${(result.stdout ?? '').length} stderrLen=${(result.stderr ?? '').length}`);

  if (result.error) {
    throw result.error;
  }

  const output = (result.stdout || "") + (result.stderr || "");
  const entries = parseGhdlOutput(output);

  console.error(`[vhdl-ls] parsedEntries=${entries.length}`);

  if (entries.length === 0 && output.trim().length > 0) {
    const sample = output.split(/\r?\n/).slice(0, 5).join('\n');
    console.error(`[vhdl-ls] parse produced 0 entries; first lines:\n${sample}`);
  }

  const byUri = new Map<string, GhdlDiagnosticEntry[]>();
  for (const entry of entries) {
    // Resolve relative paths against the directory of the analyzed file
    const resolvedPath = path.isAbsolute(entry.filePath)
      ? entry.filePath
      : path.resolve(path.dirname(filePath), entry.filePath);

    const uri = filePathToUri(resolvedPath);
    if (!byUri.has(uri)) {
      byUri.set(uri, []);
    }
    byUri.get(uri)!.push(entry);
  }

  return byUri;
}

// ---------------------------------------------------------------------------
// Config merge helper
// ---------------------------------------------------------------------------

export function mergeConfig(
  base: VhdlConfig,
  override: Partial<VhdlConfig>
): VhdlConfig {
  return {
    languageStandard: override.languageStandard ?? base.languageStandard,
    diagnostics: {
      mode: override.diagnostics?.mode ?? base.diagnostics.mode,
    },
    ghdl: {
      path: override.ghdl?.path ?? base.ghdl.path,
      args: override.ghdl?.args ?? base.ghdl.args,
      run: override.ghdl?.run ?? base.ghdl.run,
      debounceMs: override.ghdl?.debounceMs ?? base.ghdl.debounceMs,
    },
    workspace: {
      sourceGlobs: override.workspace?.sourceGlobs ?? base.workspace.sourceGlobs,
      indexing: {
        enabled: override.workspace?.indexing?.enabled ?? base.workspace.indexing.enabled,
        rescanIntervalMs:
          override.workspace?.indexing?.rescanIntervalMs ??
          base.workspace.indexing.rescanIntervalMs,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

export function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  delayMs: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      fn(...args);
    }, delayMs);
  };
}

// ---------------------------------------------------------------------------
// VHDL keywords
// ---------------------------------------------------------------------------

export const VHDL_KEYWORDS: string[] = [
  "abs",
  "access",
  "after",
  "alias",
  "all",
  "and",
  "architecture",
  "array",
  "assert",
  "attribute",
  "begin",
  "block",
  "body",
  "buffer",
  "bus",
  "case",
  "component",
  "configuration",
  "constant",
  "disconnect",
  "downto",
  "else",
  "elsif",
  "end",
  "entity",
  "exit",
  "file",
  "for",
  "function",
  "generate",
  "generic",
  "group",
  "guarded",
  "if",
  "impure",
  "in",
  "inertial",
  "inout",
  "is",
  "label",
  "library",
  "linkage",
  "literal",
  "loop",
  "map",
  "mod",
  "nand",
  "new",
  "next",
  "nor",
  "not",
  "null",
  "of",
  "on",
  "open",
  "or",
  "others",
  "out",
  "package",
  "port",
  "postponed",
  "procedure",
  "process",
  "pure",
  "range",
  "record",
  "register",
  "reject",
  "rem",
  "report",
  "return",
  "rol",
  "ror",
  "select",
  "severity",
  "shared",
  "signal",
  "sla",
  "sll",
  "sra",
  "srl",
  "subtype",
  "then",
  "to",
  "transport",
  "type",
  "unaffected",
  "units",
  "until",
  "use",
  "variable",
  "wait",
  "when",
  "while",
  "with",
  "xnor",
  "xor",
];
