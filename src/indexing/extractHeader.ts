import type { TextDocument } from "vscode-languageserver-textdocument";
import type { Range } from "vscode-languageserver/node";
import { RE_COMPONENT_HEADER, RE_ENTITY_HEADER } from "./patterns";

export interface HeaderHit {
    name: string;
    startOffset: number;
    endOffset: number;
    range: Range;
}

function rangeFromOffsets(doc: TextDocument, startOffset: number, endOffset: number): Range {
    return { start: doc.positionAt(startOffset), end: doc.positionAt(endOffset) };
}

export function findComponentHeaders(doc: TextDocument): HeaderHit[] {
    const text = doc.getText();
    const hits: HeaderHit[] = [];
    RE_COMPONENT_HEADER.lastIndex = 0;

    let m: RegExpExecArray | null;
    while ((m = RE_COMPONENT_HEADER.exec(text))) {
        const full = m[0];
        const name = m[1];

        const nameOffsetInFull = full.toLowerCase().indexOf(name.toLowerCase());
        if (nameOffsetInFull < 0) continue;

        const startOffset = m.index + nameOffsetInFull;
        const endOffset = startOffset + name.length;

        hits.push({ name, startOffset, endOffset, range: rangeFromOffsets(doc, startOffset, endOffset) });
    }

    return hits;
}

export function findEntityHeaders(doc: TextDocument): HeaderHit[] {
    const text = doc.getText();
    const hits: HeaderHit[] = [];
    RE_ENTITY_HEADER.lastIndex = 0;

    let m: RegExpExecArray | null;
    while ((m = RE_ENTITY_HEADER.exec(text))) {
        const full = m[0];
        const name = m[1];

        const nameOffsetInFull = full.toLowerCase().indexOf(name.toLowerCase());
        if (nameOffsetInFull < 0) continue;

        const startOffset = m.index + nameOffsetInFull;
        const endOffset = startOffset + name.length;

        hits.push({ name, startOffset, endOffset, range: rangeFromOffsets(doc, startOffset, endOffset) });
    }

    return hits;
}