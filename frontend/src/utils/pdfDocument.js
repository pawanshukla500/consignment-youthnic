/**
 * Minimal, dependency-free PDF writer sized for fixed-format labels.
 *
 * Only what a 4x6 box label needs: filled/stroked rectangles, hairlines and
 * base-14 Type1 text. Every page carries its own MediaBox, so the printer
 * driver picks up the label stock from the file instead of falling back to
 * whatever default paper (A4/Letter) is loaded.
 *
 * Callers lay out in a top-left origin with y growing downward (like CSS);
 * the flip to the PDF bottom-left origin happens when the stream is written.
 */

const FONTS = {
  regular: { key: 'F1', base: 'Helvetica' },
  bold: { key: 'F2', base: 'Helvetica-Bold' },
  mono: { key: 'F3', base: 'Courier' },
  monoBold: { key: 'F4', base: 'Courier-Bold' },
}

// Adobe AFM advance widths (per 1000 em) for ASCII 32..126.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584,
]

const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975,
  722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  333, 278, 333, 584, 556, 333,
  556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500,
  389, 280, 389, 584,
]

// Characters outside Latin-1 that we still want to print, mapped to their
// WinAnsiEncoding slot plus regular/bold advance widths.
const WIN_ANSI_EXTRAS = {
  '…': [0x85, 1000, 1000], // ellipsis
  '—': [0x97, 1000, 1000], // em dash
  '–': [0x96, 556, 556], // en dash
  '‘': [0x91, 222, 278],
  '’': [0x92, 222, 278],
  '“': [0x93, 333, 500],
  '”': [0x94, 333, 500],
  '•': [0x95, 350, 350], // bullet
}

const FALLBACK_WIDTH = 556
const MONO_WIDTH = 600

function isMono(font) {
  return font === 'mono' || font === 'monoBold'
}

/**
 * Fold arbitrary input down to bytes the base-14 WinAnsi fonts can render.
 * Anything unmappable becomes '?' rather than corrupting the stream.
 */
export function toWinAnsi(value) {
  const text = String(value ?? '')
  let out = ''
  for (const char of text) {
    const extra = WIN_ANSI_EXTRAS[char]
    if (extra) {
      out += String.fromCharCode(extra[0])
      continue
    }
    const code = char.codePointAt(0)
    if (code < 0x20) out += ' '
    else if (code <= 0xff) out += char
    else out += '?'
  }
  return out
}

function charWidth(char, font) {
  if (isMono(font)) return MONO_WIDTH
  const extra = WIN_ANSI_EXTRAS[char]
  if (extra) return font === 'bold' ? extra[2] : extra[1]
  const code = char.codePointAt(0)
  if (code >= 32 && code <= 126) {
    const table = font === 'bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS
    return table[code - 32]
  }
  return FALLBACK_WIDTH
}

/** Advance width of `value` in points at `size`. */
export function measureText(value, font, size) {
  let units = 0
  for (const char of String(value ?? '')) units += charWidth(char, font)
  return (units * size) / 1000
}

/** Clip `value` to `maxWidth` points, ending in an ellipsis when it had to cut. */
export function fitText(value, font, size, maxWidth) {
  const text = String(value ?? '')
  if (!text || maxWidth <= 0) return ''
  if (measureText(text, font, size) <= maxWidth) return text
  const ellipsis = '…'
  const ellipsisWidth = measureText(ellipsis, font, size)
  let width = 0
  let out = ''
  for (const char of text) {
    const next = width + charWidth(char, font) * size / 1000
    if (next + ellipsisWidth > maxWidth) break
    width = next
    out += char
  }
  return out ? `${out}${ellipsis}` : ellipsis
}

function escapePdfText(value) {
  return value.replace(/([\\()])/g, '\\$1')
}

function hexToRgb(color) {
  if (Array.isArray(color)) return color
  const hex = String(color || '#000000').replace('#', '')
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
  const int = parseInt(full, 16)
  if (Number.isNaN(int)) return [0, 0, 0]
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255]
}

function fmt(n) {
  return (Math.round(n * 1000) / 1000).toString()
}

/**
 * @param {{ width: number, height: number }} size page size in PDF points (72 per inch)
 */
export function createPdfDocument({ width, height }) {
  const pages = []
  let current = null

  const api = {
    width,
    height,

    addPage() {
      current = []
      pages.push(current)
      return api
    },

    /** Filled and/or stroked rectangle, `y` measured from the page top. */
    rect(x, y, w, h, { fill, stroke, lineWidth = 0.6 } = {}) {
      if (!current || w <= 0 || h <= 0) return api
      const bottom = height - y - h
      if (fill) {
        const [r, g, b] = hexToRgb(fill)
        current.push(`${fmt(r)} ${fmt(g)} ${fmt(b)} rg`)
        current.push(`${fmt(x)} ${fmt(bottom)} ${fmt(w)} ${fmt(h)} re f`)
      }
      if (stroke) {
        const [r, g, b] = hexToRgb(stroke)
        current.push(`${fmt(r)} ${fmt(g)} ${fmt(b)} RG`)
        current.push(`${fmt(lineWidth)} w`)
        current.push(`${fmt(x)} ${fmt(bottom)} ${fmt(w)} ${fmt(h)} re S`)
      }
      return api
    },

    /** Straight line, both endpoints measured from the page top. */
    line(x1, y1, x2, y2, { color = '#000000', lineWidth = 0.6 } = {}) {
      if (!current) return api
      const [r, g, b] = hexToRgb(color)
      current.push(`${fmt(r)} ${fmt(g)} ${fmt(b)} RG`)
      current.push(`${fmt(lineWidth)} w`)
      current.push(`${fmt(x1)} ${fmt(height - y1)} m ${fmt(x2)} ${fmt(height - y2)} l S`)
      return api
    },

    /**
     * Draw one line of text. `baseline` is measured from the page top, `x` is
     * the left/center/right anchor according to `align`.
     */
    text(value, x, baseline, { font = 'regular', size = 8, color = '#000000', align = 'left', maxWidth } = {}) {
      if (!current) return api
      const clipped = maxWidth ? fitText(value, font, size, maxWidth) : String(value ?? '')
      if (!clipped) return api
      const safe = toWinAnsi(clipped)
      const advance = measureText(safe, font, size)
      let left = x
      if (align === 'center') left = x - advance / 2
      else if (align === 'right') left = x - advance
      const [r, g, b] = hexToRgb(color)
      current.push('BT')
      current.push(`${fmt(r)} ${fmt(g)} ${fmt(b)} rg`)
      current.push(`/${FONTS[font].key} ${fmt(size)} Tf`)
      current.push(`1 0 0 1 ${fmt(left)} ${fmt(height - baseline)} Tm`)
      current.push(`(${escapePdfText(safe)}) Tj`)
      current.push('ET')
      return api
    },

    get pageCount() {
      return pages.length
    },

    /** Serialize to a Latin-1 string where one character is exactly one byte. */
    toRawString() {
      if (!pages.length) api.addPage()
      const fontKeys = Object.keys(FONTS)
      const fontObjStart = 3
      const pageObjStart = fontObjStart + fontKeys.length
      const objects = []

      const pageRefs = pages.map((_, i) => `${pageObjStart + i * 2} 0 R`)
      objects.push('<< /Type /Catalog /Pages 2 0 R >>')
      objects.push(`<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pages.length} >>`)
      for (const name of fontKeys) {
        objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS[name].base} /Encoding /WinAnsiEncoding >>`)
      }
      const fontResource = fontKeys
        .map((name, i) => `/${FONTS[name].key} ${fontObjStart + i} 0 R`)
        .join(' ')

      pages.forEach((ops, i) => {
        const contentRef = pageObjStart + i * 2 + 1
        objects.push(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(width)} ${fmt(height)}] ` +
          `/Resources << /Font << ${fontResource} >> /ProcSet [/PDF /Text] >> /Contents ${contentRef} 0 R >>`
        )
        const stream = ops.join('\n')
        objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
      })

      const chunks = ['%PDF-1.4\n%\xE2\xE3\xCF\xD3\n']
      let offset = chunks[0].length
      const offsets = []
      objects.forEach((body, i) => {
        const chunk = `${i + 1} 0 obj\n${body}\nendobj\n`
        offsets.push(offset)
        offset += chunk.length
        chunks.push(chunk)
      })

      const xrefOffset = offset
      let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
      for (const entry of offsets) {
        xref += `${String(entry).padStart(10, '0')} 00000 n \n`
      }
      chunks.push(xref)
      chunks.push(
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
      )

      return chunks.join('')
    },

    toUint8Array() {
      const raw = api.toRawString()
      const bytes = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i) & 0xff
      return bytes
    },

    toBlob() {
      return new Blob([api.toUint8Array()], { type: 'application/pdf' })
    },
  }

  return api
}
