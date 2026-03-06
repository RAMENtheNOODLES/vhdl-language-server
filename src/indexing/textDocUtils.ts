import { TextDocument } from "vscode-languageserver-textdocument";
import type { Range } from "vscode-languageserver/node";

export function makeTextDocument(uri: string, text: string): TextDocument {
    // languageId is informational here; version can be 0 for indexing.
    return TextDocument.create(uri, "vhdl", 0, text);
}

export function rangeFromOffsets(
    doc: TextDocument,
    startOffset: number,
    endOffset: number
): Range {
    return {
        start: doc.positionAt(startOffset),
        end: doc.positionAt(endOffset),
    };
}