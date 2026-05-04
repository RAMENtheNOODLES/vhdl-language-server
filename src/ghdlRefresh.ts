import fg from "fast-glob";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { DiagnosticSeverity } from "vscode-languageserver/node";

import { indexText, type IndexResult } from "./indexing/indexTextSignature";
import { parseGhdlOutput, type VhdlConfig } from "./ghdl";

export interface GhdlRefreshIssue {
  filePath: string;
  message: string;
}

export interface GhdlRefreshResult {
  filesDiscovered: number;
  filesProcessed: number;
  filesSucceeded: number;
  cacheFilesCleared: number;
  issues: GhdlRefreshIssue[];
}

interface AnalysisRecord {
  filePath: string;
  result: IndexResult;
  dependencies: Set<string>;
}

export async function findWorkspaceVhdlFiles(workspaceRoots: string[]): Promise<string[]> {
  const patterns = ["**/*.vhd", "**/*.vhdl"];
  const files = new Set<string>();

  for (const root of workspaceRoots) {
    if (!root) {
      continue;
    }

    try {
      const found = await fg(patterns, {
        cwd: root,
        absolute: true,
        onlyFiles: true,
        suppressErrors: true,
      });

      for (const filePath of found) {
        files.add(path.normalize(filePath));
      }
    } catch {
      continue;
    }
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

export async function findGhdlCacheFiles(workspaceRoots: string[]): Promise<string[]> {
  const files = new Set<string>();

  for (const root of workspaceRoots) {
    if (!root) {
      continue;
    }

    try {
      const found = await fg(["**/work-obj*.cf"], {
        cwd: root,
        absolute: true,
        onlyFiles: true,
        suppressErrors: true,
      });

      for (const filePath of found) {
        files.add(path.normalize(filePath));
      }
    } catch {
      continue;
    }
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

export async function clearGhdlCacheFiles(cacheFiles: string[]): Promise<number> {
  let cleared = 0;

  for (const filePath of cacheFiles) {
    try {
      fs.unlinkSync(filePath);
      cleared++;
    } catch {
      try {
        const contents = fs.readFileSync(filePath, "utf8");
        const firstLine = contents.split(/\r?\n/, 1)[0]?.trim() ?? "";
        if (firstLine.toLowerCase().startsWith("v 4")) {
          fs.writeFileSync(filePath, `${firstLine}${os.EOL}`);
        } else {
          fs.truncateSync(filePath, 0);
        }
        cleared++;
      } catch {
        continue;
      }
    }
  }

  return cleared;
}

export function buildGhdlCompilationOrder(filePaths: string[]): string[] {
  const analyses = new Map<string, AnalysisRecord>();
  const packageProviders = new Map<string, Set<string>>();
  const entityProviders = new Map<string, Set<string>>();

  for (const filePath of filePaths) {
    const text = fs.readFileSync(filePath, "utf8");
    const document = TextDocument.create(URI.file(filePath).toString(), "vhdl", 0, text);
    const result = indexText(document);
    const record: AnalysisRecord = {
      filePath,
      result,
      dependencies: new Set<string>(),
    };

    analyses.set(filePath, record);

    for (const pkg of result.packages) {
      const providers = packageProviders.get(pkg.nameLower) ?? new Set<string>();
      providers.add(filePath);
      packageProviders.set(pkg.nameLower, providers);
    }

    for (const entity of result.entities) {
      const providers = entityProviders.get(entity.nameLower) ?? new Set<string>();
      providers.add(filePath);
      entityProviders.set(entity.nameLower, providers);
    }
  }

  for (const record of analyses.values()) {
    for (const body of record.result.packageBodies) {
      addDependencies(record.dependencies, packageProviders.get(body.nameLower), record.filePath);
    }

    for (const clause of record.result.useClauses) {
      if (clause.packageNameLower) {
        addDependencies(record.dependencies, packageProviders.get(clause.packageNameLower), record.filePath);
      }
    }

    for (const unit of record.result.topLevelUnits) {
      if (unit.kind === "architecture" && unit.entityNameLower) {
        addDependencies(record.dependencies, entityProviders.get(unit.entityNameLower), record.filePath);
      }
    }
  }

  const incomingCounts = new Map<string, number>();
  const outgoing = new Map<string, Set<string>>();

  for (const filePath of analyses.keys()) {
    incomingCounts.set(filePath, 0);
    outgoing.set(filePath, new Set<string>());
  }

  for (const record of analyses.values()) {
    for (const dependency of record.dependencies) {
      if (!analyses.has(dependency)) {
        continue;
      }

      const dependents = outgoing.get(dependency);
      if (dependents && !dependents.has(record.filePath)) {
        dependents.add(record.filePath);
        incomingCounts.set(record.filePath, (incomingCounts.get(record.filePath) ?? 0) + 1);
      }
    }
  }

  const ready = [...incomingCounts.entries()]
    .filter(([, count]) => count === 0)
    .map(([filePath]) => filePath)
    .sort((left, right) => left.localeCompare(right));

  const ordered: string[] = [];
  while (ready.length > 0) {
    const filePath = ready.shift()!;
    ordered.push(filePath);

    for (const dependent of outgoing.get(filePath) ?? []) {
      const nextCount = (incomingCounts.get(dependent) ?? 0) - 1;
      incomingCounts.set(dependent, nextCount);
      if (nextCount === 0) {
        ready.push(dependent);
        ready.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  if (ordered.length !== analyses.size) {
    const remaining = [...analyses.keys()]
      .filter((filePath) => !ordered.includes(filePath))
      .sort((left, right) => left.localeCompare(right));
    ordered.push(...remaining);
  }

  return ordered;
}

export function compileFilesWithGhdl(
  filePaths: string[],
  config: VhdlConfig,
  cwd: string
): GhdlRefreshResult {
  const issues: GhdlRefreshIssue[] = [];
  let filesSucceeded = 0;

  for (const filePath of filePaths) {
    const args = ["-a", `--std=${config.languageStandard}`, ...config.ghdl.args, filePath];
    const result = spawnSync(config.ghdl.path || "ghdl", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const parsed = parseGhdlOutput(output);
    const hasErrorDiagnostic = parsed.some((entry) => entry.severity === DiagnosticSeverity.Error);
    if (result.status === 0 && !hasErrorDiagnostic) {
      filesSucceeded++;
      continue;
    }

    const message =
      parsed.length > 0
        ? parsed.map((entry) => `${entry.filePath}:${entry.line}:${entry.column}: ${entry.message}`).join("; ")
        : result.error
          ? String(result.error)
          : `ghdl exited with status ${result.status ?? "unknown"}`;

    issues.push({ filePath, message });
  }

  return {
    filesDiscovered: filePaths.length,
    filesProcessed: filePaths.length,
    filesSucceeded,
    cacheFilesCleared: 0,
    issues,
  };
}

export async function refreshWorkspaceGhdlCache(
  workspaceRoots: string[],
  config: VhdlConfig
): Promise<GhdlRefreshResult> {
  const files = await findWorkspaceVhdlFiles(workspaceRoots);
  const cacheFiles = await findGhdlCacheFiles(workspaceRoots);
  const cacheFilesCleared = await clearGhdlCacheFiles(cacheFiles);
  const orderedFiles = buildGhdlCompilationOrder(files);
  const compileRoot = workspaceRoots.find((root) => root.length > 0) ?? (orderedFiles[0] ? path.dirname(orderedFiles[0]) : process.cwd());
  const compileResult = compileFilesWithGhdl(orderedFiles, config, compileRoot);

  return {
    ...compileResult,
    cacheFilesCleared,
  };
}

function addDependencies(
  dependencies: Set<string>,
  providers: Set<string> | undefined,
  selfPath: string
): void {
  if (!providers) {
    return;
  }

  for (const provider of providers) {
    if (provider !== selfPath) {
      dependencies.add(provider);
    }
  }
}