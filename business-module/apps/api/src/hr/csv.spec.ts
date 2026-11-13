import { parseCsv, parseCsvRecords, toCsv } from "./csv";

describe("csv", () => {
  it("reads quoted fields, escaped quotes, embedded commas and line breaks, CRLF, BOM and a missing final newline", () => {
    const text = '﻿a,b,c\r\n1,"x,y","he said ""hi"""\r\n"multi\nline",2,3';
    expect(parseCsv(text)).toEqual([["a", "b", "c"], ["1", "x,y", 'he said "hi"'], ["multi\nline", "2", "3"]]);
  });
  it("skips blank lines and builds records by header name, trimming values", () => {
    expect(parseCsvRecords("id, name\n\n1, Ann \n2,Bob\n")).toEqual([{ id: "1", name: "Ann" }, { id: "2", name: "Bob" }]);
    expect(parseCsvRecords("")).toEqual([]);
  });
  it("short rows get empty strings for the missing columns", () => {
    expect(parseCsvRecords("a,b,c\n1\n")).toEqual([{ a: "1", b: "", c: "" }]);
  });
  it("writes and re-reads the same data", () => {
    const rows = [["1", 'He said "hi", ok'], ["2", "line1\nline2"]];
    expect(parseCsv(toCsv(["id", "note"], rows))).toEqual([["id", "note"], ...rows]);
  });
  it("neutralises spreadsheet formulas on export", () => {
    expect(toCsv(["x"], [["=1+1"], ["+cmd"], ["-5"], ["@sum"]])).toBe("x\r\n'=1+1\r\n'+cmd\r\n'-5\r\n'@sum\r\n");
  });
});
