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
