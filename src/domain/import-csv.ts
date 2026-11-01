// The first step of an import: turn the uploaded bytes into text, and the text into rows of cells.
// Everything after this (column mapping, dates, amounts) works on strings, so the two places where a
// file can be hostile or foreign (its byte encoding and its quoting) are settled here and nowhere else.
//
// Two rules shape the module. First, nothing here throws on bad input: a statement that will not decode
// or a quote that never closes is reported as a value, so a corrupt file reaches the person as a message
// instead of a server error. Second, statement text is sensitive, so no error message ever contains any
// of the input (not a byte, not a snippet): messages are fixed strings.
//
// The tokenizer is a single pass over the characters rather than a regex or split-on-newline, because a
// quoted field may hold the delimiter and line breaks and only a left-to-right scan can know which it is.

export const IMPORT_DELIMITERS = [",", ";", "\t", "|"] as const
export type ImportDelimiter = (typeof IMPORT_DELIMITERS)[number]

export const IMPORT_ENCODINGS = ["utf-8", "windows-1252", "utf-16le"] as const
export type ImportEncoding = (typeof IMPORT_ENCODINGS)[number]

const NUL = 0x00

/**
 * A cheap guard before decoding: a spreadsheet or archive renamed to .csv is full of NUL bytes, while real
 * UTF-16LE text also is (every ASCII character is followed by one) and announces itself with its BOM.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  const utf16Bom = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
  return utf16Bom || !bytes.includes(NUL)
}

export type DecodeResult = { ok: true; text: string } | { ok: false; error: string }

/**
 * Decode with the encoding the person chose, never guessing. `fatal` makes an invalid sequence an error
 * rather than a silent U+FFFD, which would corrupt a description without anyone noticing. A BOM that matches
 * the encoding is dropped so it cannot end up glued to the first header cell.
 */
export function decodeBytes(bytes: Uint8Array, encoding: ImportEncoding): DecodeResult {
  let body = bytes
  if (encoding === "utf-8" && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    body = bytes.subarray(3)
  } else if (encoding === "utf-16le" && bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    body = bytes.subarray(2)
  }
  try {
    const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(body)
    return { ok: true, text }
  } catch {
    return { ok: false, error: `The file is not valid ${encoding} text` }
  }
}

export interface CsvRow {
  /** The 1-based physical line the row starts on (a quoted field may make a row span several lines). */
  line: number
  cells: string[]
  error?: string
}

const QUOTE = '"'
const UNTERMINATED_QUOTE = "A quoted field is never closed"

/**
 * Split text into rows of cells. Follows RFC 4180 (quoted fields, doubled quotes, delimiters and line breaks
 * inside quotes, CRLF or LF) and is lenient where real exports are sloppy: a quote in the middle of an
 * unquoted field is kept as text, and characters after a closing quote are appended to the field. Blank lines
 * are skipped; a line of only delimiters is a row of empty cells. A row's cell count is whatever it had.
 */
export function parseCsv(text: string, delimiter: ImportDelimiter): CsvRow[] {
  const rows: CsvRow[] = []

  let cells: string[] = []
  let field = ""
  // Whether this field was opened with a quote, so `""` is an empty cell and not a blank line.
  let fieldQuoted = false
  let inQuotes = false
  let line = 1
  let rowLine = 1

  const endRow = (error?: string) => {
    const blank = cells.length === 0 && field === "" && !fieldQuoted
    if (!blank) {
      cells.push(field)
      rows.push(error === undefined ? { line: rowLine, cells } : { line: rowLine, cells, error })
    }
    cells = []
    field = ""
    fieldQuoted = false
    inQuotes = false
  }

  let i = 0
  // A leading BOM can survive when the caller decoded with a different path; it is never part of a cell.
  if (text.charCodeAt(0) === 0xfeff) i = 1

  for (; i < text.length; i++) {
    const char = text[i]

    if (inQuotes) {
      if (char === QUOTE) {
        if (text[i + 1] === QUOTE) {
          field += QUOTE
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
        if (char === "\n") line++
        else if (char === "\r") {
          // CRLF inside quotes is one physical line break; keep both characters in the cell.
          if (text[i + 1] === "\n") {
            field += "\n"
            i++
          }
          line++
        }
      }
      continue
    }

    if (char === QUOTE && field === "" && !fieldQuoted) {
      inQuotes = true
      fieldQuoted = true
    } else if (char === delimiter) {
      cells.push(field)
      field = ""
      fieldQuoted = false
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++
      endRow()
      line++
      rowLine = line
    } else {
      field += char
    }
  }

  if (inQuotes) {
    endRow(UNTERMINATED_QUOTE)
  } else {
    endRow()
  }
  return rows
}
