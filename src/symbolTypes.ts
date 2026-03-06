import type { Range } from "vscode-languageserver/node";

export interface SymbolEntry {
    name: string;
    nameLower: string;
    kind:
    | "entity"
    | "component"
    | "package"
    | "signal"
    | "variable"
    | "constant"
    | "port"
    | "generic";

    uri: string;

    // identifier token location
    startOffset: number; // inclusive
    endOffset: number;   // exclusive
    range: Range;

    // container/scope info (optional but very useful)
    containerKind?: "entity" | "architecture" | "component" | "package";
    containerName?: string;
    containerNameLower?: string;
    containerStartOffset?: number;
    containerEndOffset?: number;
    containerRange?: Range;

    source?: "workspace-scan" | "open-document";
    detail?: string;
}