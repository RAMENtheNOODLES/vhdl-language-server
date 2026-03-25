import { TextDocument } from "vscode-languageserver-textdocument";

import { buildDocumentSemanticTokens, VHDL_SEMANTIC_TOKENS_LEGEND } from "../src/semanticTokens";
import { indexText, type CallableEntry, type DesignUnitEntry, type PackageEntry } from "../src/indexing/indexTextSignature";
import type { SemanticSymbolIndex } from "../src/semanticResolver";

function makeIndex(
  docs: Array<{ uri: string; text: string }>
): SemanticSymbolIndex {
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

function decodeTokenTriples(
  text: string,
  data: number[]
): Array<{ lexeme: string; tokenType: string }> {
  const lines = text.split(/\r?\n/);
  const result: Array<{ lexeme: string; tokenType: string }> = [];
  let line = 0;
  let char = 0;

  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    char = data[i] === 0 ? char + data[i + 1] : data[i + 1];

    const length = data[i + 2];
    const tokenTypeIndex = data[i + 3];
    const tokenType = VHDL_SEMANTIC_TOKENS_LEGEND.tokenTypes[tokenTypeIndex] ?? "unknown";
    const lexeme = lines[line]?.slice(char, char + length) ?? "";

    result.push({ lexeme, tokenType });
  }

  return result;
}

describe("semantic tokens", () => {
  test("highlights user-defined type and subtype references", () => {
    const uri = "file:///types.vhd";
    const text = `
entity top is
end entity top;

architecture rtl of top is
  type state_t is (idle, busy);
  subtype nibble_t is integer range 0 to 15;
  signal current_state : state_t;
  signal current_nibble : nibble_t;
begin
end architecture rtl;
`;

    const index = makeIndex([{ uri, text }]);
    const document = TextDocument.create(uri, "vhdl", 0, text);
    const tokens = buildDocumentSemanticTokens(document, index);
    const triples = decodeTokenTriples(text, tokens.data);

    expect(triples).toEqual(expect.arrayContaining([
      { lexeme: "state_t", tokenType: "type" },
      { lexeme: "nibble_t", tokenType: "type" },
    ]));
  });

  test("highlights called user functions", () => {
    const uri = "file:///callable.vhd";
    const text = `
entity top is
end entity top;

architecture rtl of top is
  function inc(value_in : integer) return integer is
  begin
    return value_in + 1;
  end function inc;

  signal out_sig : integer;
begin
  out_sig <= inc(1);
end architecture rtl;
`;

    const index = makeIndex([{ uri, text }]);
    const document = TextDocument.create(uri, "vhdl", 0, text);
    const tokens = buildDocumentSemanticTokens(document, index);
    const triples = decodeTokenTriples(text, tokens.data);

    expect(triples).toContainEqual({ lexeme: "inc", tokenType: "function" });
  });
});
