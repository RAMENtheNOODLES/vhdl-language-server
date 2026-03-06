# VHDL Language Server

A TypeScript-based [Language Server Protocol (LSP)](https://microsoft.github.io/language-server-protocol/) implementation for VHDL, with optional [GHDL](https://github.com/ghdl/ghdl) integration for diagnostics.

## Features

- **Keyword completion** – all VHDL-2008 reserved words.
- **Hover** – identifies VHDL keywords under the cursor.
- **Diagnostics** – optional GHDL-powered analysis or a lightweight built-in checker.
- **Go to Definition** – workspace-wide Ctrl+Click navigation:
  - Clicking an instantiation target navigates to the component declaration.
  - Clicking a component declaration name navigates to the entity declaration.
  - Clicking a port-map formal name navigates to the port in the owning component/entity.
  - General identifier lookup falls back to local declarations, entity ports, and workspace-wide index.
- **Workspace indexing** – periodic background scanning of all VHDL source files to build an in-memory index of entities, components, ports, generics, and local declarations. Open document content always wins over on-disk content.
- **Windows-first** – correctly handles Windows drive-letter paths (e.g. `C:\proj\top.vhd`) in GHDL output.
- **Incremental document sync** – efficient text-change tracking.

## Requirements

- **Node.js** ≥ 16
- **GHDL** (optional) – required only when `vhdl.diagnostics.mode` is `"ghdl"` or `"both"`.

## Building

```bash
npm install
npm run build          # compiles TypeScript → dist/
```

The compiled entry point is `dist/server.js`.

## Running locally

```bash
# Start in stdio mode (the standard way for VS Code extensions)
node dist/server.js --stdio
```

The server will read LSP messages from stdin and write responses to stdout.

## Running tests

```bash
npm test
```

## Using with a VS Code extension

In your VS Code extension, start the server as a child process over stdio:

```typescript
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

export function activate(context: vscode.ExtensionContext) {
  const serverModule = context.asAbsolutePath('node_modules/vhdl-language-server/dist/server.js');

  const serverOptions: ServerOptions = {
    run:   { module: serverModule, transport: TransportKind.stdio },
    debug: { module: serverModule, transport: TransportKind.stdio },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'vhdl' }],
  };

  const client = new LanguageClient('vhdlLanguageServer', 'VHDL Language Server', serverOptions, clientOptions);
  context.subscriptions.push(client.start());
}
```

## VS Code settings (`settings.json`)

All settings live under the `vhdl` namespace:

| Setting | Type | Default | Description |
|---|---|---|---|
| `vhdl.languageStandard` | `"1987"` \| `"1993"` \| `"2002"` \| `"2008"` | `"2008"` | VHDL language standard passed to GHDL (`--std=`). |
| `vhdl.diagnostics.mode` | `"basic"` \| `"ghdl"` \| `"both"` \| `"off"` | `"both"` | Diagnostic source(s). `"basic"` uses the built-in checker; `"ghdl"` uses GHDL; `"both"` combines them; `"off"` disables all diagnostics. |
| `vhdl.ghdl.path` | string | `""` | Absolute path to the `ghdl` executable. Leave empty to use the system PATH. |
| `vhdl.ghdl.args` | string[] | `[]` | Extra arguments appended to every `ghdl -a` invocation. |
| `vhdl.ghdl.run` | `"onSave"` \| `"onType"` | `"onSave"` | When to run GHDL analysis. `"onType"` is debounced. |
| `vhdl.ghdl.debounceMs` | number | `500` | Debounce delay in milliseconds for `"onType"` mode. |
| `vhdl.workspace.sourceGlobs` | string[] | `["**/*.vhd","**/*.vhdl","**/*.vho","**/*.vht"]` | Glob patterns identifying VHDL source files used by workspace indexing and Go to Definition. |
| `vhdl.workspace.indexing.enabled` | boolean | `true` | Enable workspace-wide indexing for Go to Definition. |
| `vhdl.workspace.indexing.rescanIntervalMs` | number | `30000` | How often (in milliseconds) to re-scan workspace files for index updates. Set to `0` to disable periodic rescans. |

### Example `settings.json`

```jsonc
{
  "vhdl.languageStandard": "2008",
  "vhdl.diagnostics.mode": "ghdl",
  "vhdl.ghdl.path": "C:\\ghdl\\bin\\ghdl.exe",
  "vhdl.ghdl.args": ["-fsynopsys"],
  "vhdl.ghdl.run": "onSave",
  "vhdl.workspace.indexing.enabled": true,
  "vhdl.workspace.indexing.rescanIntervalMs": 30000
}
```

## Go to Definition

The server supports Ctrl+Click / F12 navigation for common VHDL constructs:

| Cursor position | Navigates to |
|---|---|
| Instantiation target (`label : my_comp`) | Component declaration of `my_comp` in the workspace (falls back to entity) |
| Component declaration name (`component my_comp is`) | Entity declaration of `my_comp` in the workspace |
| Port-map formal (`clk => sys_clk` — the `clk` side) | Port declaration in the owning component/entity |
| General identifier | Local signal/variable/constant, then entity port, then workspace-wide entity/component |

**Resolution tie-breakers** (best-first): same file → nearest declaration above the cursor → same directory → path proximity.

## GHDL configuration (Windows)

On Windows, GHDL writes diagnostic lines like:

```
C:\proj\top.vhd:12:3:warning: signal not used
```

The server parses these correctly by matching from the right of the line, so the drive-letter colon is never confused with a field separator.

If `ghdl` is not on the system `PATH`, set `vhdl.ghdl.path` to the full path of the executable, e.g.:

```json
"vhdl.ghdl.path": "C:\\tools\\ghdl\\bin\\ghdl.exe"
```

## Project structure

```
vhdl-language-server/
├── src/
│   ├── server.ts            # LSP server entry point
│   ├── ghdl.ts              # GHDL parsing utilities and configuration types
│   ├── workspaceIndexer.ts  # Workspace file indexer and definition resolution helpers
│   ├── symbolTypes.ts       # Shared symbol entry types
│   └── indexing/
│       ├── indexTextSignature.ts   # Single-pass VHDL text indexer
│       ├── extractHeader.ts        # Entity/component header extraction
│       ├── extractPortLikeNames.ts # Port/generic name extraction
│       ├── findMatching.ts         # Matching parenthesis finder
│       ├── patterns.ts             # Shared regular expressions
│       └── textDocUtils.ts         # TextDocument utilities
├── test/
│   └── server.test.ts
├── dist/           # compiled output (generated by `npm run build`)
├── package.json
└── tsconfig.json
```

## License

MIT
