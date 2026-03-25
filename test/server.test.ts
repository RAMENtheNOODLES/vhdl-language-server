/**
 * Tests for GHDL output parsing and URI conversion utilities.
 */

import * as path from "path";

import {
  getGhdlStandardLibrarySourceGlobs,
  inferGhdlLibraryNameFromSourcePath,
  parseGhdlOutputLine,
  parseGhdlOutput,
  filePathToUri,
  GhdlDiagnosticEntry,
  inferDiagnosticCharacterRange,
} from "../src/ghdl";
import { DiagnosticSeverity } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { indexText } from "../src/indexing/indexTextSignature";
import {
  formatHoverMarkdown,
  resolveHoverEntry,
  type HoverSymbolIndex,
} from "../src/hoverResolver";
import {
  resolveCompletionItems,
  type CompletionSymbolIndex,
} from "../src/completionResolver";
import { determineContext, pickBest } from "../src/workspaceIndexer";
import type {
  CallableEntry,
  DesignUnitEntry,
  PackageEntry,
} from "../src/indexing/indexTextSignature";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(text: string): TextDocument {
  return TextDocument.create("file:///test.vhd", "vhdl", 0, text);
}

function makeHoverIndex(
  docs: Array<{ uri: string; text: string }>
): HoverSymbolIndex & CompletionSymbolIndex {
  const byUri = new Map<string, ReturnType<typeof indexText>>();
  const entities: DesignUnitEntry[] = [];
  const components: DesignUnitEntry[] = [];
  const callables: CallableEntry[] = [];
  const packages: PackageEntry[] = [];
  const packageBodies: PackageEntry[] = [];

  for (const { uri, text } of docs) {
    const result = indexText(TextDocument.create(uri, "vhdl", 0, text));
    byUri.set(uri, result);
    entities.push(...result.entities);
    components.push(...result.components);
    callables.push(...result.callables);
    packages.push(...result.packages);
    packageBodies.push(...result.packageBodies);
  }

  return {
    findEntities(nameLower: string): DesignUnitEntry[] {
      return entities.filter((entry) => entry.nameLower === nameLower);
    },
    findComponents(nameLower: string): DesignUnitEntry[] {
      return components.filter((entry) => entry.nameLower === nameLower);
    },
    findPackages(nameLower: string): PackageEntry[] {
      return packages.filter((entry) => entry.nameLower === nameLower);
    },
    findPackageBodies(nameLower: string): PackageEntry[] {
      return packageBodies.filter((entry) => entry.nameLower === nameLower);
    },
    getDocLocals(uri: string) {
      return byUri.get(uri)?.locals ?? [];
    },
    getDocEntities(uri: string) {
      return byUri.get(uri)?.entities ?? [];
    },
    getDocComponents(uri: string) {
      return byUri.get(uri)?.components ?? [];
    },
    getDocCallables(uri: string) {
      return byUri.get(uri)?.callables ?? [];
    },
    getDocPackages(uri: string) {
      return byUri.get(uri)?.packages ?? [];
    },
    getDocPackageBodies(uri: string) {
      return byUri.get(uri)?.packageBodies ?? [];
    },
    getDocLibraryClauses(uri: string) {
      return byUri.get(uri)?.libraryClauses ?? [];
    },
    getDocUseClauses(uri: string) {
      return byUri.get(uri)?.useClauses ?? [];
    },
    getDocTopLevelUnits(uri: string) {
      return byUri.get(uri)?.topLevelUnits ?? [];
    },
    getAllDesignUnits(): DesignUnitEntry[] {
      return [...entities, ...components];
    },
    getAllCallables(): CallableEntry[] {
      return [...callables];
    },
    getAllPackages(): PackageEntry[] {
      return [...packages];
    },
    getAllPackageBodies(): PackageEntry[] {
      return [...packageBodies];
    },
  };
}

function wordRange(
  text: string,
  word: string,
  occurrence: "first" | "last" = "first"
): [number, number] {
  const start = occurrence === "last" ? text.lastIndexOf(word) : text.indexOf(word);
  if (start < 0) {
    throw new Error(`Word not found: ${word}`);
  }
  return [start, start + word.length];
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
// inferDiagnosticCharacterRange
// ---------------------------------------------------------------------------

describe("inferDiagnosticCharacterRange", () => {
  test("expands an identifier to the full name", () => {
    const line = "  foo <= bar;";
    const range = inferDiagnosticCharacterRange(
      line,
      line.indexOf("foo") + 1,
      'no declaration for "foo"'
    );

    expect(range).toEqual({
      startCharacter: line.indexOf("foo"),
      endCharacter: line.indexOf("foo") + "foo".length,
    });
  });

  test("expands an operator token when the message has no quoted symbol", () => {
    const line = "  a <= b;";
    const range = inferDiagnosticCharacterRange(
      line,
      line.indexOf("<=") + 1,
      "unexpected token"
    );

    expect(range).toEqual({
      startCharacter: line.indexOf("<="),
      endCharacter: line.indexOf("<=") + "<=".length,
    });
  });

  test("prefers the quoted literal from the diagnostic message", () => {
    const line = "  if x = '0' then";
    const range = inferDiagnosticCharacterRange(
      line,
      line.indexOf("'0'") + 1,
      "can't match '0' with type integer"
    );

    expect(range).toEqual({
      startCharacter: line.indexOf("'0'"),
      endCharacter: line.indexOf("'0'") + "'0'".length,
    });
  });

  test("falls back to a single character when no source line is available", () => {
    const range = inferDiagnosticCharacterRange(undefined, 7, "unexpected token");

    expect(range).toEqual({
      startCharacter: 6,
      endCharacter: 7,
    });
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

describe("GHDL standard library helpers", () => {
  test("builds the expected VHDL-2008 source globs", () => {
    const prefix = path.join("ghdl-root", "lib", "ghdl");
    const globs = getGhdlStandardLibrarySourceGlobs(prefix, "08");

    expect(globs).toEqual(expect.arrayContaining([
      path.join(prefix, "src", "ieee2008", "*.{vhd,vhdl,vho,vht}").replace(/\\/g, "/"),
      path.join(prefix, "src", "std", "*.{vhd,vhdl,vho,vht}").replace(/\\/g, "/"),
      path.join(prefix, "src", "std", "v08", "*.{vhd,vhdl,vho,vht}").replace(/\\/g, "/"),
    ]));
  });

  test("infers ieee from ieee2008 source paths", () => {
    const sourceRoot = path.join("ghdl-root", "lib", "ghdl", "src");
    const filePath = path.join(sourceRoot, "ieee2008", "std_logic_1164.vhdl");

    expect(inferGhdlLibraryNameFromSourcePath(filePath, sourceRoot)).toBe("ieee");
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

  test("stores the declaration signature for hover text", () => {
    const result = indexText(makeDoc(vhdl));
    const sig = result.locals.find((l) => l.nameLower === "my_sig");
    expect(sig?.signature).toBe("signal my_sig : std_logic");
  });
});

// ---------------------------------------------------------------------------
// indexText – callable extraction
// ---------------------------------------------------------------------------

describe("indexText – callable extraction", () => {
  const vhdl = `
architecture rtl of top is
  function add_one(value_in : integer) return integer is
  begin
    return value_in + 1;
  end function add_one;

  procedure reset_counter(signal clk : in std_logic) is
  begin
    null;
  end procedure reset_counter;
begin
end architecture rtl;
`;

  test("extracts functions and procedures", () => {
    const result = indexText(makeDoc(vhdl));
    const callableNames = result.callables.map((entry) => entry.nameLower);

    expect(callableNames).toContain("add_one");
    expect(callableNames).toContain("reset_counter");
  });

  test("extracts callable parameters and signatures", () => {
    const result = indexText(makeDoc(vhdl));
    const addOne = result.callables.find((entry) => entry.nameLower === "add_one");
    const resetCounter = result.callables.find((entry) => entry.nameLower === "reset_counter");

    expect(addOne?.signature).toBe("function add_one(value_in : integer) return integer");
    expect(addOne?.params.map((param) => param.nameLower)).toContain("value_in");
    expect(resetCounter?.params.map((param) => param.nameLower)).toContain("clk");
  });
});

// ---------------------------------------------------------------------------
// resolveHoverEntry
// ---------------------------------------------------------------------------

describe("resolveHoverEntry", () => {
  test("returns the declaration signature for a local signal usage", () => {
    const uri = "file:///top.vhd";
    const text = `
architecture rtl of top is
  signal my_sig : std_logic;
begin
  my_sig <= '1';
end architecture rtl;
`;

    const index = makeHoverIndex([{ uri, text }]);
    const [start, end] = wordRange(text, "my_sig", "last");
    const entry = resolveHoverEntry(text, start, end, uri, index);

    expect(entry?.kind).toBe("signal");
    expect(entry?.signature).toBe("signal my_sig : std_logic");
  });

  test("returns the owning port declaration for a port-map formal", () => {
    const uri = "file:///top.vhd";
    const text = `
architecture rtl of top is
  component my_comp is
    port (
      clk : in std_logic;
      rst : in std_logic
    );
  end component my_comp;
begin
  u1 : my_comp port map ( clk => sys_clk, rst => sys_rst );
end architecture rtl;
`;

    const index = makeHoverIndex([{ uri, text }]);
    const [start, end] = wordRange(text, "clk", "last");
    const entry = resolveHoverEntry(text, start, end, uri, index);

    expect(entry?.kind).toBe("port");
    expect(entry?.signature).toBe("port clk : in std_logic");
    expect(formatHoverMarkdown(entry!)).toBe("```vhdl\nport clk : in std_logic\n```");
  });

  test("prefers the component declaration for an instantiation target", () => {
    const uri = "file:///top.vhd";
    const entityUri = "file:///my_comp.vhd";
    const text = `
architecture rtl of top is
  component my_comp is
  end component my_comp;
begin
  u1 : my_comp port map ();
end architecture rtl;
`;
    const entityText = `
entity my_comp is
end entity my_comp;
`;

    const index = makeHoverIndex([
      { uri, text },
      { uri: entityUri, text: entityText },
    ]);
    const [start, end] = wordRange(text, "my_comp", "last");
    const entry = resolveHoverEntry(text, start, end, uri, index);

    expect(entry?.kind).toBe("component");
    expect(entry?.signature).toBe("component my_comp");
  });

  test("returns the component declaration when hovering its own name", () => {
    const uri = "file:///top.vhd";
    const entityUri = "file:///my_comp.vhd";
    const text = `
architecture rtl of top is
  component my_comp is
    port ( clk : in std_logic );
  end component my_comp;
begin
end architecture rtl;
`;
    const entityText = `
entity my_comp is
  port ( clk : in std_logic );
end entity my_comp;
`;

    const index = makeHoverIndex([
      { uri, text },
      { uri: entityUri, text: entityText },
    ]);
    const [start, end] = wordRange(text, "my_comp", "first");
    const entry = resolveHoverEntry(text, start, end, uri, index);

    expect(entry?.kind).toBe("component");
    expect(entry?.signature).toBe("component my_comp");
  });

  test("resolves a locally declared subtype when used in a signal declaration", () => {
    const uri = "file:///top.vhd";
    const text = `
architecture rtl of top is
  subtype address_t is std_logic_vector(15 downto 0);
  signal t : address_t;
begin
end architecture rtl;
`;

    const index = makeHoverIndex([{ uri, text }]);
    const [start, end] = wordRange(text, "address_t", "last");
    const entry = resolveHoverEntry(text, start, end, uri, index);

    expect(entry?.kind).toBe("subtype");
    expect(entry?.signature).toBe("subtype address_t : std_logic_vector(15 downto 0)");
  });
});

// ---------------------------------------------------------------------------
// resolveCompletionItems
// ---------------------------------------------------------------------------

describe("resolveCompletionItems", () => {
  test("suggests visible variables, parameters, local types/subtypes, outer signals, and functions", () => {
    const uri = "file:///top.vhd";
    const text = `
entity top is
  port (
    clk : in std_logic;
    rst : in std_logic
  );
end entity top;

architecture rtl of top is
  signal outer_sig : std_logic;
  type state_t is (idle, busy);
  subtype small_int_t is integer range 0 to 7;

  function calc(sample_in : integer) return integer is
    variable temp_value : integer;
  begin
    -- cursor
    return temp_value;
  end function calc;
begin
end architecture rtl;
`;

    const index = makeHoverIndex([{ uri, text }]);
    const offset = text.indexOf("-- cursor");
    const items = resolveCompletionItems(text, offset, uri, index);
    const labels = items.map((item) => item.label);

    expect(labels).toContain("sample_in");
    expect(labels).toContain("temp_value");
    expect(labels).toContain("outer_sig");
    expect(labels).toContain("state_t");
    expect(labels).toContain("small_int_t");
    expect(labels).toContain("clk");
    expect(labels).toContain("calc");
  });

  test("suggests predefined VHDL functions, types, and subtypes", () => {
    const uri = "file:///top.vhd";
    const text = `
entity top is
end entity top;

architecture rtl of top is
begin
  ab
  int
  nat
end architecture rtl;
`;

    const index = makeHoverIndex([{ uri, text }]);

    const absItems = resolveCompletionItems(
      text,
      text.lastIndexOf("ab") + "ab".length,
      uri,
      index
    );
    expect(absItems.map((item) => item.label)).toContain("abs");

    const intItems = resolveCompletionItems(
      text,
      text.lastIndexOf("int") + "int".length,
      uri,
      index
    );
    expect(intItems.map((item) => item.label)).toContain("integer");

    const natItems = resolveCompletionItems(
      text,
      text.lastIndexOf("nat") + "nat".length,
      uri,
      index
    );
    expect(natItems.map((item) => item.label)).toContain("natural");
  });

  test("does not leak process-local variables from sibling processes", () => {
    const uri = "file:///top.vhd";
    const text = `
architecture rtl of top is
  signal shared_sig : std_logic;
begin
  p1 : process
    variable only_p1 : integer;
  begin
    null;
  end process;

  p2 : process
    variable only_p2 : integer;
  begin
    only
    null;
  end process;
end architecture rtl;
`;

    const index = makeHoverIndex([{ uri, text }]);
  const offset = text.lastIndexOf("only") + "only".length;
    const items = resolveCompletionItems(text, offset, uri, index);
    const labels = items.map((item) => item.label);

    expect(labels).toContain("only_p2");
    expect(labels).not.toContain("only_p1");
  });

  test("suggests target ports on the formal side of a port map", () => {
    const uri = "file:///top.vhd";
    const text = `
architecture rtl of top is
  component my_comp is
    port (
      clk : in std_logic;
      rst : in std_logic
    );
  end component my_comp;
begin
  u1 : my_comp port map (
    cl
  );
end architecture rtl;
`;

    const index = makeHoverIndex([{ uri, text }]);
  const offset = text.lastIndexOf("cl") + "cl".length;
    const items = resolveCompletionItems(text, offset, uri, index);
    const labels = items.map((item) => item.label);

    expect(labels).toContain("clk");
    expect(labels).not.toContain("architecture");
  });

  test("suggests design units for instantiation targets", () => {
    const uri = "file:///top.vhd";
    const depUri = "file:///dep.vhd";
    const text = `
architecture rtl of top is
begin
  u1 : co
end architecture rtl;
`;
    const depText = `
component counter is
end component counter;

entity counter_ent is
end entity counter_ent;
`;

    const index = makeHoverIndex([
      { uri, text },
      { uri: depUri, text: depText },
    ]);
    const offset = text.lastIndexOf("co") + "co".length;
    const items = resolveCompletionItems(text, offset, uri, index);
    const labels = items.map((item) => item.label);

    expect(labels).toContain("counter");
    expect(labels).toContain("counter_ent");
  });

  test("suggests enum literals in a case-when branch for the case selector type", () => {
    const uri = "file:///top.vhd";
    const text = `
architecture rtl of top is
  type CU_States_t is (FETCH, DECODE, EXECUTE, INTERRUPT, ERR);
  signal test_state : CU_States_t;
begin
  p_main : process(all)
  begin
    case test_state is
      when 
        null;
      when others =>
        null;
    end case;
  end process;
end architecture rtl;
`;

    const index = makeHoverIndex([{ uri, text }]);
    const offset = text.lastIndexOf("when ") + "when ".length;
    const items = resolveCompletionItems(text, offset, uri, index);
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining([
      "FETCH",
      "DECODE",
      "EXECUTE",
      "INTERRUPT",
      "ERR",
    ]));
  });

  test("suggests enum literals on assignment to a typed signal", () => {
    const uri = "file:///top.vhd";
    const text = `
architecture rtl of top is
  type cu_states_t is (FETCH, DECODE, EXECUTE, INTERRUPT, ERR);
  signal test_state : cu_states_t;
begin
  p_main : process(all)
  begin
    test_state <= EX
  end process;
end architecture rtl;
`;

    const index = makeHoverIndex([{ uri, text }]);
    const offset = text.lastIndexOf("EX") + "EX".length;
    const items = resolveCompletionItems(text, offset, uri, index);
    const labels = items.map((item) => item.label);

    expect(labels).toContain("EXECUTE");
    expect(labels).not.toContain("FETCH");
  });

  test("suggests based-literal snippets when typing x/b/o prefix", () => {
    const uri = "file:///top.vhd";
    const text = `
architecture rtl of top is
begin
  x
  b
  o
end architecture rtl;
`;

    const index = makeHoverIndex([{ uri, text }]);

    const xItems = resolveCompletionItems(
      text,
      text.lastIndexOf("x") + "x".length,
      uri,
      index
    );
    const xSnippet = xItems.find((item) => item.label === 'x""');
    expect(xSnippet).toBeTruthy();
    expect(xSnippet?.insertText).toBe('x"$1"');
    expect(xSnippet?.insertTextFormat).toBe(2);

    const bItems = resolveCompletionItems(
      text,
      text.lastIndexOf("b") + "b".length,
      uri,
      index
    );
    expect(bItems.map((item) => item.label)).toContain('b""');

    const oItems = resolveCompletionItems(
      text,
      text.lastIndexOf("o") + "o".length,
      uri,
      index
    );
    expect(oItems.map((item) => item.label)).toContain('o""');
  });

  test("preserves typed keyword case on exact keyword completion", () => {
    const uri = "file:///top.vhd";
    const text = `
architecture rtl of top is
begin
  SUBTYPE
end architecture rtl;
`;

    const index = makeHoverIndex([{ uri, text }]);
    const offset = text.lastIndexOf("SUBTYPE") + "SUBTYPE".length;
    const items = resolveCompletionItems(text, offset, uri, index);
    const subtypeKeyword = items.find((item) => item.label === "subtype");

    expect(subtypeKeyword).toBeTruthy();
    expect(subtypeKeyword?.insertText).toBe("SUBTYPE");
    expect(subtypeKeyword?.insertTextFormat).toBe(1);
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
      signature: "entity foo",
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
