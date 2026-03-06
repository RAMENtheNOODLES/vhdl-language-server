import type { TextDocument } from "vscode-languageserver-textdocument";

export interface IndexResult {
    // symbols, entities, components, etc.
}

export function indexText(doc: TextDocument): IndexResult {
    const text = doc.getText();
    // regex scan text, compute offsets, use doc.positionAt for ranges
    return { /* ... */ } as IndexResult;
}