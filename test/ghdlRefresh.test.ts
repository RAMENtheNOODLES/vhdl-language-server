import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  buildGhdlCompilationOrder,
  clearGhdlCacheFiles,
  findWorkspaceVhdlFiles,
} from "../src/ghdlRefresh";

function makeTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vhdl-ls-refresh-"));
}

describe("ghdl refresh helpers", () => {
  test("finds VHDL files recursively", async () => {
    const root = makeTempWorkspace();
    const nested = path.join(root, "sub", "dir");
    fs.mkdirSync(nested, { recursive: true });

    const topFile = path.join(root, "top.vhd");
    const nestedFile = path.join(nested, "types.vhdl");
    const ignoredFile = path.join(nested, "notes.txt");

    fs.writeFileSync(topFile, "entity top is end entity top;\n");
    fs.writeFileSync(nestedFile, "package my_pkg is end package my_pkg;\n");
    fs.writeFileSync(ignoredFile, "ignore me\n");

    const files = await findWorkspaceVhdlFiles([root]);

    expect(files).toEqual(expect.arrayContaining([path.normalize(topFile), path.normalize(nestedFile)]));
    expect(files).not.toContain(path.normalize(ignoredFile));
  });

  test("orders package providers before dependents", () => {
    const root = makeTempWorkspace();
    const typesFile = path.join(root, "types.vhdl");
    const bodyFile = path.join(root, "types_body.vhdl");
    const consumerFile = path.join(root, "consumer.vhd");

    fs.writeFileSync(
      typesFile,
      [
        "package my_pkg is",
        "  type state_t is (idle, busy);",
        "end package my_pkg;",
        "",
      ].join("\n")
    );
    fs.writeFileSync(
      bodyFile,
      [
        "package body my_pkg is",
        "end package body my_pkg;",
        "",
      ].join("\n")
    );
    fs.writeFileSync(
      consumerFile,
      [
        "library work;",
        "use work.my_pkg.all;",
        "",
        "entity top is",
        "end entity top;",
        "",
        "architecture rtl of top is",
        "  signal state_sig : state_t;",
        "begin",
        "end architecture rtl;",
        "",
      ].join("\n")
    );

    const order = buildGhdlCompilationOrder([consumerFile, bodyFile, typesFile]);

    expect(order.indexOf(typesFile)).toBeLessThan(order.indexOf(bodyFile));
    expect(order.indexOf(typesFile)).toBeLessThan(order.indexOf(consumerFile));
  });

  test("clears GHDL cache files", async () => {
    const root = makeTempWorkspace();
    const cacheFile = path.join(root, "work-obj93.cf");
    fs.writeFileSync(cacheFile, "cache contents\n");

    const cleared = await clearGhdlCacheFiles([cacheFile]);

    expect(cleared).toBe(1);
    expect(fs.existsSync(cacheFile)).toBe(false);
  });
});