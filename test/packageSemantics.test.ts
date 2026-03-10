import { TextDocument } from "vscode-languageserver-textdocument";

import { resolveCompletionItems } from "../src/completionResolver";
import { resolveHoverEntry } from "../src/hoverResolver";
import {
  getSemanticEntryRange,
  getSemanticEntryUri,
  resolveSemanticEntry,
  type SemanticSymbolIndex,
} from "../src/semanticResolver";
import {
  indexText,
  type CallableEntry,
  type DesignUnitEntry,
  type PackageEntry,
} from "../src/indexing/indexTextSignature";

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

function resolveDefinition(
  text: string,
  uri: string,
  index: SemanticSymbolIndex,
  word: string,
  occurrence: "first" | "last" = "last"
): {
  ambiguous: boolean;
  signature: string | null;
  targetUri: string | null;
  rangeText: string | null;
} {
  const [start, end] = wordRange(text, word, occurrence);
  const resolution = resolveSemanticEntry(text, start, end, uri, index);
  if (!resolution.entry) {
    return {
      ambiguous: resolution.ambiguous,
      signature: null,
      targetUri: null,
      rangeText: null,
    };
  }

  const targetUri = getSemanticEntryUri(resolution.entry, uri);
  const range = getSemanticEntryRange(resolution.entry);
  const targetText = (targetUri === uri ? text : "")
    .slice(0, 0);

  return {
    ambiguous: resolution.ambiguous,
    signature: resolution.entry.signature,
    targetUri,
    rangeText: targetText.length === 0 ? null : targetText,
  };
}

describe("package semantics", () => {
  const pkgUri = "file:///pkg.vhd";
  const pkgBodyUri = "file:///pkg-body.vhd";
  const consumerUri = "file:///consumer.vhd";

  const packageDecl = `
package my_pkg is
  constant ANSWER : integer := 42;
  subtype word_t is integer range 0 to 15;
  type state_t is (idle, busy);
  function inc(value_in : integer) return integer;
  procedure reset_counter(signal clk : in std_logic);
  component helper is
    port ( a : in std_logic );
  end component helper;
  alias default_answer is ANSWER;
end package my_pkg;
`;

  const packageBody = `
package body my_pkg is
  constant BODY_ONLY : integer := 7;

  function inc(value_in : integer) return integer is
  begin
    return value_in + BODY_ONLY;
  end function inc;
end package body my_pkg;
`;

  test("indexes package declarations and package members", () => {
    const result = indexText(TextDocument.create(pkgUri, "vhdl", 0, packageDecl));

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0].nameLower).toBe("my_pkg");
    expect(result.packages[0].members.map((entry) => `${entry.kind}:${entry.nameLower}`)).toEqual(
      expect.arrayContaining([
        "constant:answer",
        "subtype:word_t",
        "type:state_t",
        "function:inc",
        "procedure:reset_counter",
        "component:helper",
        "alias:default_answer",
      ])
    );
  });

  test("indexes package bodies separately", () => {
    const result = indexText(TextDocument.create(pkgBodyUri, "vhdl", 0, packageBody));

    expect(result.packageBodies).toHaveLength(1);
    expect(result.packageBodies[0].nameLower).toBe("my_pkg");
    expect(result.packageBodies[0].members.map((entry) => `${entry.kind}:${entry.nameLower}`)).toEqual(
      expect.arrayContaining(["constant:body_only", "function:inc"])
    );
  });

  test("parses library clauses and use clauses", () => {
    const text = `
library ieee, work;
use ieee.std_logic_1164.all;
use work.my_pkg.ANSWER;
`;
    const result = indexText(TextDocument.create(consumerUri, "vhdl", 0, text));

    expect(result.libraryClauses.map((entry) => entry.nameLower)).toEqual(
      expect.arrayContaining(["ieee", "work"])
    );
    expect(result.useClauses).toHaveLength(2);
    expect(result.useClauses[0].libraryNameLower).toBe("ieee");
    expect(result.useClauses[0].packageNameLower).toBe("std_logic_1164");
    expect(result.useClauses[0].isAll).toBe(true);
    expect(result.useClauses[1].libraryNameLower).toBe("work");
    expect(result.useClauses[1].packageNameLower).toBe("my_pkg");
    expect(result.useClauses[1].memberNameLower).toBe("answer");
  });

  test("hover and definition resolve imported members across files and prefer the package declaration", () => {
    const consumerText = `
library work;
use work.my_pkg.all;

entity top is
end entity top;

architecture rtl of top is
  signal result_sig : word_t;
begin
  result_sig <= inc(ANSWER);
end architecture rtl;
`;
    const index = makeIndex([
      { uri: pkgUri, text: packageDecl },
      { uri: pkgBodyUri, text: packageBody },
      { uri: consumerUri, text: consumerText },
    ]);

    const [answerStart, answerEnd] = wordRange(consumerText, "ANSWER", "last");
    const hoverEntry = resolveHoverEntry(consumerText, answerStart, answerEnd, consumerUri, index);
    expect(hoverEntry?.signature).toBe("constant ANSWER : integer := 42");

    const incDefinition = resolveDefinition(consumerText, consumerUri, index, "inc", "last");
    expect(incDefinition.ambiguous).toBe(false);
    expect(incDefinition.targetUri).toBe(pkgUri);
    expect(incDefinition.signature).toBe("function inc(value_in : integer) return integer");

    const typeDefinition = resolveDefinition(consumerText, consumerUri, index, "word_t", "last");
    expect(typeDefinition.targetUri).toBe(pkgUri);
    expect(typeDefinition.signature).toBe("subtype word_t is integer range 0 to 15");
  });

  test("explicit member imports expose only the imported symbol", () => {
    const consumerText = `
library work;
use work.my_pkg.ANSWER;

entity top is
end entity top;

architecture rtl of top is
begin
  ANSWER <= ANSWER;
  -- cursor
end architecture rtl;
`;
    const index = makeIndex([
      { uri: pkgUri, text: packageDecl },
      { uri: consumerUri, text: consumerText },
    ]);

    const definition = resolveDefinition(consumerText, consumerUri, index, "ANSWER", "last");
    expect(definition.targetUri).toBe(pkgUri);
    expect(definition.signature).toBe("constant ANSWER : integer := 42");

    const items = resolveCompletionItems(
      consumerText,
      consumerText.indexOf("-- cursor"),
      consumerUri,
      index
    );
    const labels = items.map((item) => item.label);
    expect(labels).toContain("ANSWER");
    expect(labels).not.toContain("inc");
  });

  test("selected-name resolution works for package and member prefixes", () => {
    const consumerText = `
library work;

entity top is
end entity top;

architecture rtl of top is
begin
  work.my_pkg.ANSWER <= my_pkg.ANSWER;
end architecture rtl;
`;
    const index = makeIndex([
      { uri: pkgUri, text: packageDecl },
      { uri: consumerUri, text: consumerText },
    ]);

    const packageResolution = resolveDefinition(consumerText, consumerUri, index, "my_pkg", "last");
    expect(packageResolution.targetUri).toBe(pkgUri);
    expect(packageResolution.signature).toBe("package my_pkg");

    const memberResolution = resolveDefinition(consumerText, consumerUri, index, "ANSWER", "last");
    expect(memberResolution.targetUri).toBe(pkgUri);
    expect(memberResolution.signature).toBe("constant ANSWER : integer := 42");
  });

  test("local declarations shadow imported package members", () => {
    const consumerText = `
library work;
use work.my_pkg.all;

entity top is
end entity top;

architecture rtl of top is
  constant ANSWER : integer := 0;
begin
  ANSWER <= ANSWER;
end architecture rtl;
`;
    const index = makeIndex([
      { uri: pkgUri, text: packageDecl },
      { uri: consumerUri, text: consumerText },
    ]);

    const [start, end] = wordRange(consumerText, "ANSWER", "last");
    const hoverEntry = resolveHoverEntry(consumerText, start, end, consumerUri, index);
    expect(hoverEntry?.signature).toBe("constant ANSWER : integer := 0");
  });

  test("ambiguous imported names do not resolve silently", () => {
    const pkgAUri = "file:///pkg-a.vhd";
    const pkgBUri = "file:///pkg-b.vhd";
    const pkgAText = `
package pkg_a is
  constant ANSWER : integer := 1;
end package pkg_a;
`;
    const pkgBText = `
package pkg_b is
  constant ANSWER : integer := 2;
end package pkg_b;
`;
    const consumerText = `
library work;
use work.pkg_a.all;
use work.pkg_b.all;

entity top is
end entity top;

architecture rtl of top is
begin
  ANSWER <= ANSWER;
  ANS
end architecture rtl;
`;
    const index = makeIndex([
      { uri: pkgAUri, text: pkgAText },
      { uri: pkgBUri, text: pkgBText },
      { uri: consumerUri, text: consumerText },
    ]);

    const resolution = resolveDefinition(consumerText, consumerUri, index, "ANSWER", "last");
    expect(resolution.targetUri).toBeNull();
    expect(resolution.ambiguous).toBe(true);

    const items = resolveCompletionItems(
      consumerText,
      consumerText.lastIndexOf("ANS") + "ANS".length,
      consumerUri,
      index
    );
    const answer = items.find((item) => item.label === "ANSWER");
    expect(answer?.detail).toContain("ambiguous import");
  });

  test("completion includes visible imported functions, constants, and types", () => {
    const consumerText = `
library work;
use work.my_pkg.all;

entity top is
end entity top;

architecture rtl of top is
begin
  -- cursor
end architecture rtl;
`;
    const index = makeIndex([
      { uri: pkgUri, text: packageDecl },
      { uri: consumerUri, text: consumerText },
    ]);

    const items = resolveCompletionItems(
      consumerText,
      consumerText.indexOf("-- cursor"),
      consumerUri,
      index
    );
    const labels = items.map((item) => item.label);

    expect(labels).toContain("ANSWER");
    expect(labels).toContain("word_t");
    expect(labels).toContain("inc");
  });

  test("package-body-only members stay internal to the body", () => {
    const consumerText = `
library work;
use work.my_pkg.all;

entity top is
end entity top;

architecture rtl of top is
begin
  BODY_ONLY <= BODY_ONLY;
end architecture rtl;
`;
    const bodyText = `
package body my_pkg is
  constant BODY_ONLY : integer := 7;

  function inc(value_in : integer) return integer is
  begin
    return BODY_ONLY;
  end function inc;
end package body my_pkg;
`;
    const index = makeIndex([
      { uri: pkgUri, text: packageDecl },
      { uri: pkgBodyUri, text: bodyText },
      { uri: consumerUri, text: consumerText },
    ]);

    const externalResolution = resolveDefinition(consumerText, consumerUri, index, "BODY_ONLY", "last");
    expect(externalResolution.targetUri).toBeNull();
    expect(externalResolution.ambiguous).toBe(false);

    const bodyResolution = resolveDefinition(bodyText, pkgBodyUri, index, "BODY_ONLY", "last");
    expect(bodyResolution.targetUri).toBe(pkgBodyUri);
    expect(bodyResolution.signature).toBe("constant BODY_ONLY : integer := 7");
  });

  test("completion handles incomplete use clauses and partially typed selected names", () => {
    const incompleteUseText = `
library work;
use work.my_pkg.`;
    const selectedNameText = `
entity top is
end entity top;

architecture rtl of top is
begin
  my_pkg.A
end architecture rtl;
`;
    const index = makeIndex([
      { uri: pkgUri, text: packageDecl },
      { uri: consumerUri, text: incompleteUseText },
      { uri: "file:///selected.vhd", text: selectedNameText },
    ]);

    const useItems = resolveCompletionItems(
      incompleteUseText,
      incompleteUseText.length,
      consumerUri,
      index
    );
    const useLabels = useItems.map((item) => item.label);
    expect(useLabels).toContain("all");
    expect(useLabels).toContain("ANSWER");
    expect(useLabels).toContain("inc");

    const selectedItems = resolveCompletionItems(
      selectedNameText,
      selectedNameText.lastIndexOf("A") + 1,
      "file:///selected.vhd",
      index
    );
    expect(selectedItems.map((item) => item.label)).toContain("ANSWER");
  });
});