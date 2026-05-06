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

function spansToTextRuns(spans: InlineSpan[], opts: { bold?: boolean; size?: number } = {}): TextRun[] {
  return spans.map((s) => new TextRun({
    text: s.text,
    bold: s.bold || opts.bold || false,
    size: opts.size ?? 22,  // 11pt — half-points
  }));
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
            children: headerCells.map((cell) => new TableCell({
              children: [new Paragraph({
                children: spansToTextRuns(parseInline(cell), { bold: true }),
              })],
            })),
          }),
          // Body rows
          ...rows.map((row) => new TableRow({
            children: row.map((cell) => new TableCell({
              children: [new Paragraph({
                children: spansToTextRuns(parseInline(cell)),
              })],
            })),
          })),
        ],
        width: { size: 100, type: WidthType.PERCENTAGE },
      });
      elements.push(table);
      continue;
    }

    // Bullet list
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      elements.push(new Paragraph({
        children: spansToTextRuns(parseInline(trimmed.slice(2))),
        bullet: { level: 0 },
        spacing: { after: 80 },
      }));
      i++;
      continue;
    }

    // Numbered list (a) ... or 1. ... or a. ...)
    if (/^([a-z]\)|[a-z]\.|\d+\.)\s/.test(trimmed)) {
      elements.push(new Paragraph({
        children: spansToTextRuns(parseInline(trimmed)),
        spacing: { after: 80 },
        indent: { left: 360 },
      }));
      i++;
      continue;
    }

    // Default: paragraph
    elements.push(new Paragraph({
      children: spansToTextRuns(parseInline(trimmed)),
      spacing: { after: 120 },
    }));
    i++;
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
