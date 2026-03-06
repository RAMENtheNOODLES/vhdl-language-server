import {
    async,
    Entry,
    Pattern,
} from "fast-glob"

import {
    Connection,
    TextDocuments,
} from "vscode-languageserver/node"

import { VhdlConfig } from "./ghdl";

import { TextDocument } from "vscode-languageserver-textdocument";

export class WorkspaceIndexer {
    readonly conn: Connection;
    docs: TextDocuments<TextDocument>;
    vConfig: VhdlConfig;

    constructor(connection: Connection, docs: TextDocuments<TextDocument>, vhdlConfig: VhdlConfig) {
        this.docs = docs;
        this.conn = connection;
        this.vConfig = vhdlConfig;

        this.conn.console.log("[WORKSPACE-INDEXER] DONE CONSTRUCTING");
    }

    updateConfig(vhdlConfig: VhdlConfig): void {
        this.vConfig = vhdlConfig;
    }


};