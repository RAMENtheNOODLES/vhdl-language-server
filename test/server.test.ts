/**
 * Tests for GHDL output parsing and URI conversion utilities.
 */

import {
  parseGhdlOutputLine,
  parseGhdlOutput,
  filePathToUri,
  GhdlDiagnosticEntry,
} from "../src/ghdl";
import { DiagnosticSeverity } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { indexText } from "../src/indexing/indexTextSignature";
import { determineContext, pickBest } from "../src/workspaceIndexer";
import type { DesignUnitEntry } from "../src/indexing/indexTextSignature";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(text: string): TextDocument {
  return TextDocument.create("file:///test.vhd", "vhdl", 0, text);
}

// ---------------------------------------------------------------------------
// parseGhdlOutputLine
// ---------------------------------------------------------------------------

describe("parseGhdlOutputLine", () => {
  test("parses a POSIX error line", () => {
    const line = "/home/user/project/top.vhd:10:5:error: undefined identifier 'foo'";
    const result = parseGhdlOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe("/home/user/project/top.vhd");
    expect(result!.line).toBe(10);
    expect(result!.column).toBe(5);
    expect(result!.severity).toBe(DiagnosticSeverity.Error);
    expect(result!.message).toBe("undefined identifier 'foo'");
  });

  test("parses a Windows drive-letter error line", () => {
    const line = "C:\\proj\\top.vhd:12:3:warning: signal not used";
    const result = parseGhdlOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe("C:\\proj\\top.vhd");
    expect(result!.line).toBe(12);
    expect(result!.column).toBe(3);
    expect(result!.severity).toBe(DiagnosticSeverity.Warning);
    expect(result!.message).toBe("signal not used");
  });

  test("parses a Windows drive-letter note line", () => {
    const line = "D:\\designs\\counter.vhd:1:1:note: elaborating design";
    const result = parseGhdlOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe("D:\\designs\\counter.vhd");
    expect(result!.line).toBe(1);
    expect(result!.column).toBe(1);
    expect(result!.severity).toBe(DiagnosticSeverity.Information);
    expect(result!.message).toBe("elaborating design");
  });

  test("parses a failure severity as Error", () => {
    const line = "/src/file.vhd:5:2:failure: assertion failed";
    const result = parseGhdlOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe(DiagnosticSeverity.Error);
  });

  test("returns null for lines that do not match", () => {
    expect(parseGhdlOutputLine("")).toBeNull();
    expect(parseGhdlOutputLine("ghdl: compilation successful")).toBeNull();
    expect(parseGhdlOutputLine("just some text without colons")).toBeNull();
  });

  test("is case-insensitive for severity keyword", () => {
    const line = "/f.vhd:1:1:WARNING: something";
    const result = parseGhdlOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe(DiagnosticSeverity.Warning);
  });
});

// ---------------------------------------------------------------------------
// parseGhdlOutput (multi-line)
// ---------------------------------------------------------------------------

describe("parseGhdlOutput", () => {
  test("parses multiple lines, skipping non-matching ones", () => {
    const output = [
      "ghdl: analyzing /src/top.vhd",
      "/src/top.vhd:10:5:error: undefined identifier",
      "/src/top.vhd:20:1:warning: unused signal",
      "ghdl: compilation failed",
    ].join("\n");

    const results = parseGhdlOutput(output);
    expect(results).toHaveLength(2);
    expect(results[0].line).toBe(10);
    expect(results[1].line).toBe(20);
  });

  test("handles CRLF line endings (Windows)", () => {
    const output = "C:\\top.vhd:1:1:error: bad\r\nC:\\top.vhd:2:1:warning: warn\r\n";
    const results = parseGhdlOutput(output);
    expect(results).toHaveLength(2);
  });

  test("returns empty array for empty string", () => {
    expect(parseGhdlOutput("")).toHaveLength(0);
  });

  test("returns empty array when no lines match", () => {
    expect(parseGhdlOutput("no matches here\nnor here")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// filePathToUri
// ---------------------------------------------------------------------------

describe("filePathToUri", () => {
  test("converts a POSIX path to a file URI", () => {
    const uri = filePathToUri("/home/user/top.vhd");
    expect(uri).toBe("file:///home/user/top.vhd");
  });

  test("converts a Windows path to a file URI", () => {
    // vscode-uri normalizes drive letters to lowercase
    const uri = filePathToUri("C:\\proj\\top.vhd");
    expect(uri.startsWith("file:///")).toBe(true);
    expect(uri.toLowerCase()).toContain("proj");
    expect(uri.toLowerCase()).toContain("top.vhd");
  });
});

// ---------------------------------------------------------------------------
// indexText – entity extraction
// ---------------------------------------------------------------------------

describe("indexText – entity extraction", () => {
  const vhdl = `
library ieee;
use ieee.std_logic_1164.all;

entity my_counter is
  generic (
    WIDTH : integer := 8;
    RESET_VAL : integer := 0
  );
  port (
    clk   : in  std_logic;
    rst   : in  std_logic;
    count : out std_logic_vector(WIDTH-1 downto 0)
  );
end entity my_counter;
`;

  test("extracts entity name", () => {
    const result = indexText(makeDoc(vhdl));
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe("my_counter");
    expect(result.entities[0].nameLower).toBe("my_counter");
  });

  test("extracts entity port names", () => {
    const result = indexText(makeDoc(vhdl));
    const portNames = result.entities[0].ports.map((p) => p.nameLower);
    expect(portNames).toContain("clk");
    expect(portNames).toContain("rst");
    expect(portNames).toContain("count");
  });

  test("extracts entity generic names", () => {
    const result = indexText(makeDoc(vhdl));
    const genNames = result.entities[0].generics.map((g) => g.nameLower);
    expect(genNames).toContain("width");
    expect(genNames).toContain("reset_val");
  });

  test("entity name range is inside the text", () => {
    const doc = makeDoc(vhdl);
    const result = indexText(doc);
    const ent = result.entities[0];
    const nameText = vhdl.slice(ent.nameStartOffset, ent.nameEndOffset);
    expect(nameText.toLowerCase()).toBe("my_counter");
  });
});

// ---------------------------------------------------------------------------
// indexText – component extraction
// ---------------------------------------------------------------------------

describe("indexText – component extraction", () => {
  const vhdl = `
architecture rtl of top is
  component my_comp is
    port (
      a : in  std_logic;
      b : out std_logic
    );
  end component my_comp;
begin
end architecture rtl;
`;

  test("extracts component name", () => {
    const result = indexText(makeDoc(vhdl));
    expect(result.components).toHaveLength(1);
    expect(result.components[0].nameLower).toBe("my_comp");
  });

  test("extracts component port names", () => {
    const result = indexText(makeDoc(vhdl));
    const portNames = result.components[0].ports.map((p) => p.nameLower);
    expect(portNames).toContain("a");
    expect(portNames).toContain("b");
  });

  test("component name range is inside the text", () => {
    const doc = makeDoc(vhdl);
    const result = indexText(doc);
    const comp = result.components[0];
    const nameText = vhdl.slice(comp.nameStartOffset, comp.nameEndOffset);
    expect(nameText.toLowerCase()).toBe("my_comp");
  });
});

// ---------------------------------------------------------------------------
// indexText – local declaration extraction
// ---------------------------------------------------------------------------

describe("indexText – local declaration extraction", () => {
  const vhdl = `
architecture rtl of top is
  signal   my_sig  : std_logic;
  variable my_var  : integer;
  constant MY_CONST : integer := 42;
begin
end architecture rtl;
`;

  test("extracts signal names", () => {
    const result = indexText(makeDoc(vhdl));
    const sigs = result.locals.filter((l) => l.kind === "signal");
    expect(sigs.map((s) => s.nameLower)).toContain("my_sig");
  });

  test("extracts variable names", () => {
    const result = indexText(makeDoc(vhdl));
    const vars = result.locals.filter((l) => l.kind === "variable");
    expect(vars.map((v) => v.nameLower)).toContain("my_var");
  });

  test("extracts constant names", () => {
    const result = indexText(makeDoc(vhdl));
    const consts = result.locals.filter((l) => l.kind === "constant");
    expect(consts.map((c) => c.nameLower)).toContain("my_const");
  });
});

// ---------------------------------------------------------------------------
// indexText – multiple entities in one file
// ---------------------------------------------------------------------------

describe("indexText – multiple entities", () => {
  const vhdl = `
entity ent_a is
  port ( a : in std_logic );
end entity ent_a;

entity ent_b is
  port ( b : out std_logic );
end entity ent_b;
`;

  test("finds both entities", () => {
    const result = indexText(makeDoc(vhdl));
    const names = result.entities.map((e) => e.nameLower);
    expect(names).toContain("ent_a");
    expect(names).toContain("ent_b");
  });
});

// ---------------------------------------------------------------------------
// determineContext
// ---------------------------------------------------------------------------

describe("determineContext", () => {
  function ctxAt(text: string, word: string): string {
    const idx = text.indexOf(word);
    return determineContext(text, idx, idx + word.length);
  }

  test("detects port_map_formal (word =>)", () => {
    const text = "inst1 : my_comp port map ( clk => sys_clk );";
    const idx = text.indexOf("clk");
    const ctx = determineContext(text, idx, idx + 3);
    expect(ctx).toBe("port_map_formal");
  });

  test("detects component_decl_name", () => {
    const text = "component my_comp is";
    const idx = text.indexOf("my_comp");
    expect(determineContext(text, idx, idx + 7)).toBe("component_decl_name");
  });

  test("detects instantiation_target (label : comp)", () => {
    const text = "u1 : my_comp\n  port map ( a => b );";
    const idx = text.indexOf("my_comp");
    expect(determineContext(text, idx, idx + 7)).toBe("instantiation_target");
  });

  test("returns general for unrecognised context", () => {
    const text = "signal my_sig : std_logic;";
    const idx = text.indexOf("my_sig");
    expect(determineContext(text, idx, idx + 6)).toBe("general");
  });

  test("detects port_map_formal even with spaces before =>", () => {
    const text = "port map ( rst  =>  n_rst )";
    const idx = text.indexOf("rst");
    expect(determineContext(text, idx, idx + 3)).toBe("port_map_formal");
  });
});

// ---------------------------------------------------------------------------
// pickBest
// ---------------------------------------------------------------------------

describe("pickBest", () => {
  function makeEntry(uri: string, offset: number): DesignUnitEntry {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    return {
      name: "foo",
      nameLower: "foo",
      kind: "entity",
      uri,
      nameStartOffset: offset,
      nameEndOffset: offset + 3,
      nameRange: range,
      blockStartOffset: offset,
      blockEndOffset: offset + 100,
      blockRange: range,
      ports: [],
      generics: [],
    };
  }

  test("returns same-file entries first", () => {
    const current = "file:///proj/top.vhd";
    const entries = [
      makeEntry("file:///proj/other.vhd", 0),
      makeEntry(current, 100),
    ];
    const sorted = pickBest(entries, current, 200);
    expect(sorted[0].uri).toBe(current);
  });

  test("returns all candidates when only one", () => {
    const e = makeEntry("file:///a.vhd", 0);
    expect(pickBest([e], "file:///b.vhd", 0)).toHaveLength(1);
  });

  test("within same file, prefers nearest above cursor", () => {
    const uri = "file:///a.vhd";
    const entries = [
      makeEntry(uri, 500),  // below cursor
      makeEntry(uri, 50),   // above cursor, farther
      makeEntry(uri, 180),  // above cursor, closer
    ];
    const sorted = pickBest(entries, uri, 200);
    expect(sorted[0].nameStartOffset).toBe(180);
  });
});
