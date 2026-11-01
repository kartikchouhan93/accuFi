import { describe, expect, it } from "vitest"
import { decodeBytes, looksLikeText, parseCsv } from "./import-csv"

const bytes = (...values: number[]) => new Uint8Array(values)
const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0))

describe("parseCsv", () => {
  it("reads quoted fields, doubled quotes and CRLF, with no trailing empty row", () => {
    const rows = parseCsv('a,b\r\n"x,1","he said ""hi"""\n', ",")
    expect(rows).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["x,1", 'he said "hi"'] },
    ])
  })

  it("keeps a newline inside quotes in one row and counts the physical lines it consumed", () => {
    const rows = parseCsv('h1,h2\n"l1\nl2",z\nnext,row\n', ",")
    expect(rows).toEqual([
      { line: 1, cells: ["h1", "h2"] },
      { line: 2, cells: ["l1\nl2", "z"] },
      { line: 4, cells: ["next", "row"] },
    ])
  })

  it("counts a CRLF inside quotes as one physical line", () => {
    const rows = parseCsv('"a\r\nb",1\r\nc,2', ",")
    expect(rows.map((r) => r.line)).toEqual([1, 3])
    expect(rows[0].cells).toEqual(["a\r\nb", "1"])
  })

  it("skips blank lines but keeps their line numbers honest", () => {
    const rows = parseCsv("a,b\n\n\nc,d\n", ",")
    expect(rows).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 4, cells: ["c", "d"] },
    ])
  })

  it("keeps a line of only delimiters as a row of empty cells", () => {
    expect(parseCsv(",,\n", ",")).toEqual([{ line: 1, cells: ["", "", ""] }])
  })

  it("keeps an explicitly quoted empty field", () => {
    expect(parseCsv('""\n', ",")).toEqual([{ line: 1, cells: [""] }])
  })

  it("lets ragged rows keep their own cell counts", () => {
    const rows = parseCsv("a,b,c\n1,2\n1,2,3,4\n", ",")
    expect(rows.map((r) => r.cells.length)).toEqual([3, 2, 4])
  })

  it.each([
    [";", "a;b;c"],
    ["\t", "a\tb\tc"],
    ["|", "a|b|c"],
  ] as const)("splits on %j", (delimiter, text) => {
    expect(parseCsv(text, delimiter)).toEqual([{ line: 1, cells: ["a", "b", "c"] }])
  })

  it("treats the other delimiters as ordinary text", () => {
    expect(parseCsv("a,b;c|d", ";")).toEqual([{ line: 1, cells: ["a,b", "c|d"] }])
  })

  it("reads a final line without a newline", () => {
    expect(parseCsv("a,b\nc,d", ",")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["c", "d"] },
    ])
  })

  it("keeps an empty trailing field", () => {
    expect(parseCsv("a,b,\n", ",")).toEqual([{ line: 1, cells: ["a", "b", ""] }])
  })

  it("returns no rows for empty or whitespace-newline text", () => {
    expect(parseCsv("", ",")).toEqual([])
    expect(parseCsv("\n\r\n\n", ",")).toEqual([])
  })

  it("treats a lone carriage return as a line break", () => {
    expect(parseCsv("a,b\rc,d", ",")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["c", "d"] },
    ])
  })

  it("accepts a stray quote inside an unquoted field and text after a closing quote", () => {
    expect(parseCsv('5" pipe,"ab"cd,e', ",")).toEqual([{ line: 1, cells: ['5" pipe', "abcd", "e"] }])
  })

  it("reports an unterminated quote on a final row, with the cells read so far", () => {
    const rows = parseCsv('a,b\nc,"never closed\nstill open', ",")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ line: 1, cells: ["a", "b"] })
    expect(rows[1]).toEqual({
      line: 2,
      cells: ["c", "never closed\nstill open"],
      error: "A quoted field is never closed",
    })
  })

  it("never throws on an unterminated quote at the very end", () => {
    const rows = parseCsv('"', ",")
    expect(rows).toEqual([{ line: 1, cells: [""], error: "A quoted field is never closed" }])
  })

  it("does not put any input text in the error", () => {
    const secret = "SECRET-ACCOUNT-9911"
    const rows = parseCsv(`x,"${secret}`, ",")
    expect(rows[0].error).toBeDefined()
    expect(rows[0].error).not.toContain(secret)
  })
})

describe("decodeBytes", () => {
  it("strips a UTF-8 BOM", () => {
    expect(decodeBytes(bytes(0xef, 0xbb, 0xbf, ...ascii("a,b")), "utf-8")).toEqual({ ok: true, text: "a,b" })
  })

  it("decodes UTF-8 without a BOM", () => {
    expect(decodeBytes(bytes(...ascii("caf"), 0xc3, 0xa9), "utf-8")).toEqual({ ok: true, text: "café" })
  })

  it("reads 0xE9 as é under windows-1252", () => {
    expect(decodeBytes(bytes(0xe9), "windows-1252")).toEqual({ ok: true, text: "é" })
  })

  it("refuses 0xE9 under utf-8 without echoing the byte", () => {
    const result = decodeBytes(bytes(0xe9), "utf-8")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0)
      expect(result.error.toLowerCase()).not.toContain("e9")
      expect(result.error).not.toContain("é")
    }
  })

  it("decodes UTF-16LE with its BOM and drops the BOM", () => {
    const body = [0x61, 0x00, 0x2c, 0x00, 0x62, 0x00]
    expect(decodeBytes(bytes(0xff, 0xfe, ...body), "utf-16le")).toEqual({ ok: true, text: "a,b" })
  })

  it("decodes UTF-16LE without a BOM", () => {
    expect(decodeBytes(bytes(0x61, 0x00), "utf-16le")).toEqual({ ok: true, text: "a" })
  })

  it("gives an error for a truncated UTF-16LE sequence", () => {
    const result = decodeBytes(bytes(0x61), "utf-16le")
    expect(result.ok).toBe(false)
  })

  it("decodes empty bytes to empty text", () => {
    expect(decodeBytes(new Uint8Array(0), "utf-8")).toEqual({ ok: true, text: "" })
  })
})

describe("looksLikeText", () => {
  it("accepts ASCII and empty input", () => {
    expect(looksLikeText(bytes(...ascii("date,amount\n1,2")))).toBe(true)
    expect(looksLikeText(new Uint8Array(0))).toBe(true)
  })

  it("rejects bytes containing a NUL", () => {
    expect(looksLikeText(bytes(0x50, 0x4b, 0x03, 0x04, 0x00, 0x01))).toBe(false)
  })

  it("accepts UTF-16LE that starts with its BOM even though it contains NULs", () => {
    expect(looksLikeText(bytes(0xff, 0xfe, 0x61, 0x00))).toBe(true)
  })

  it("rejects a NUL-bearing file with a BOM of another kind", () => {
    expect(looksLikeText(bytes(0xef, 0xbb, 0xbf, 0x61, 0x00))).toBe(false)
  })
})
