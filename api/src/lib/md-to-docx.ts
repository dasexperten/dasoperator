// =============================================================================
// Markdown → DOCX renderer (for NDA / MOU / LOI / Contract documents).
//
// Simple parser: handles headers (# / ## / ###), paragraphs, bold (**text**),
// horizontal rules (---), tables (basic | col | col |), and bullet lists.
//
// Not as fancy as a full markdown engine — by design. Legal docs from our
// templates use a known subset of markdown, and we control the source.
// If we hit edge cases, extend this file rather than adding a dependency.
// =============================================================================

import {
  AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell,
  TableRow, TextRun, WidthType, BorderStyle,
} from 'docx';

interface InlineSpan {
  text: string;
  bold: boolean;
}

// =============================================================================
// RTL detection (Arabic + Hebrew + Persian / Urdu)
// Ranges:
//   U+0590-05FF  Hebrew
//   U+0600-06FF  Arabic
//   U+0700-074F  Syriac
//   U+0750-077F  Arabic Supplement
//   U+0780-07BF  Thaana
//   U+08A0-08FF  Arabic Extended-A
//   U+FB50-FDFF  Arabic Presentation Forms-A
//   U+FE70-FEFF  Arabic Presentation Forms-B
// =============================================================================
const RTL_RANGE = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

// Exposed for tests / external code that needs to detect RTL content
export function containsRtl(text: string): boolean {
  return RTL_RANGE.test(text);
}

// Build paragraph option object that conditionally includes RTL props.
// Required because `exactOptionalPropertyTypes: true` rejects `alignment: undefined`.
function paraOpts(rtl: boolean, base: Record<string, unknown>): Record<string, unknown> {
  if (rtl) {
    return { ...base, alignment: AlignmentType.RIGHT, bidirectional: true };
  }
  return base;
}

// A line is "RTL-dominant" if it has RTL chars AND at least 30% of letter-chars are RTL.
// Lower threshold would catch lines like "EN. text" + arabic mixed; we want full-AR para.
function isRtlDominant(line: string): boolean {
  if (!RTL_RANGE.test(line)) return false;
  const letters = line.replace(/[^\p{L}]/gu, '');
  if (!letters.length) return false;
  let rtlCount = 0;
  for (const ch of letters) if (RTL_RANGE.test(ch)) rtlCount++;
  return rtlCount / letters.length >= 0.3;
}

// Parse **bold** runs in a single line, return spans
function parseInline(line: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const parts = line.split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (!part) continue;
    const boldMatch = part.match(/^\*\*([^*]+)\*\*$/);
    if (boldMatch) {
      spans.push({ text: boldMatch[1]!, bold: true });
    } else {
      spans.push({ text: part, bold: false });
    }
  }
  return spans;
}

function spansToTextRuns(
  spans: InlineSpan[],
  opts: { bold?: boolean; size?: number; rtl?: boolean } = {}
): TextRun[] {
  return spans.map((s) => {
    const runOpts: Record<string, unknown> = {
      text: s.text,
      bold: s.bold || opts.bold || false,
      size: opts.size ?? 22,  // 11pt — half-points
    };
    if (opts.rtl) runOpts.rightToLeft = true;
    return new TextRun(runOpts as ConstructorParameters<typeof TextRun>[0]);
  });
}

function parseTableLine(line: string): string[] {
  // "| a | b | c |" → ["a", "b", "c"]
  return line.replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s|:-]+\|$/.test(line.trim());
}

export function markdownToDocx(markdown: string): Document {
  const lines = markdown.split('\n');
  const elements: (Paragraph | Table)[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Skip empty lines (rendered as paragraph spacing implicitly)
    if (!trimmed) {
      i++;
      continue;
    }

    // Headers
    if (trimmed.startsWith('# ')) {
      elements.push(new Paragraph({
        children: spansToTextRuns(parseInline(trimmed.slice(2)), { bold: true, size: 32 }),
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        spacing: { before: 240, after: 240 },
      }));
      i++;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      elements.push(new Paragraph({
        children: spansToTextRuns(parseInline(trimmed.slice(3)), { bold: true, size: 26 }),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
      }));
      i++;
      continue;
    }
    if (trimmed.startsWith('### ')) {
      elements.push(new Paragraph({
        children: spansToTextRuns(parseInline(trimmed.slice(4)), { bold: true, size: 24 }),
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 200, after: 100 },
      }));
      i++;
      continue;
    }

    // Horizontal rule
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      elements.push(new Paragraph({
        text: '',
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '888888' } },
        spacing: { before: 120, after: 120 },
      }));
      i++;
      continue;
    }

    // Table — starts with | and next line is separator
    if (trimmed.startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const headerCells = parseTableLine(trimmed);
      i += 2;  // skip header + separator

      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        rows.push(parseTableLine(lines[i]!.trim()));
        i++;
      }

      const table = new Table({
        rows: [
          // Header row
          new TableRow({
            children: headerCells.map((cell) => {
              const rtl = isRtlDominant(cell);
              return new TableCell({
                children: [new Paragraph(paraOpts(rtl, {
                  children: spansToTextRuns(parseInline(cell), { bold: true, rtl }),
                }) as ConstructorParameters<typeof Paragraph>[0])],
              });
            }),
          }),
          // Body rows
          ...rows.map((row) => new TableRow({
            children: row.map((cell) => {
              const rtl = isRtlDominant(cell);
              return new TableCell({
                children: [new Paragraph(paraOpts(rtl, {
                  children: spansToTextRuns(parseInline(cell), { rtl }),
                }) as ConstructorParameters<typeof Paragraph>[0])],
              });
            }),
          })),
        ],
        width: { size: 100, type: WidthType.PERCENTAGE },
      });
      elements.push(table);
      continue;
    }

    // Bullet list
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const rtl = isRtlDominant(trimmed);
      elements.push(new Paragraph(paraOpts(rtl, {
        children: spansToTextRuns(parseInline(trimmed.slice(2)), { rtl }),
        bullet: { level: 0 },
        spacing: { after: 80 },
      }) as ConstructorParameters<typeof Paragraph>[0]));
      i++;
      continue;
    }

    // Numbered list (a) ... or 1. ... or a. ...)
    if (/^([a-z]\)|[a-z]\.|\d+\.)\s/.test(trimmed)) {
      const rtl = isRtlDominant(trimmed);
      elements.push(new Paragraph(paraOpts(rtl, {
        children: spansToTextRuns(parseInline(trimmed), { rtl }),
        spacing: { after: 80 },
        indent: { left: 360 },
      }) as ConstructorParameters<typeof Paragraph>[0]));
      i++;
      continue;
    }

    // Default: paragraph
    {
      const rtl = isRtlDominant(trimmed);
      elements.push(new Paragraph(paraOpts(rtl, {
        children: spansToTextRuns(parseInline(trimmed), { rtl }),
        spacing: { after: 120 },
      }) as ConstructorParameters<typeof Paragraph>[0]));
      i++;
    }
  }

  return new Document({
    sections: [{
      properties: {
        page: {
          margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },  // ~0.75"
        },
      },
      children: elements,
    }],
  });
}

export async function markdownToDocxBuffer(markdown: string): Promise<Uint8Array> {
  const doc = markdownToDocx(markdown);
  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}
