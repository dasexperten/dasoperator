export type UgcImportRow = {
  handle: string;
  platform: string;
  display_name?: string | null;
  followers?: number | null;
  engagement_rate?: number | null;
  content_url?: string | null;
  content_type?: string | null;
  views?: number | null;
  comments?: number | null;
  product_codes?: string[];
  usage_label?: string | null;
  source_rating?: number | null;
  source_valid?: string | null;
  audio_label?: string | null;
  download_url?: string | null;
  source_workbook: string;
  source_sheet: string;
  source_row: number;
};

function text(value: unknown): string | null {
  if (value == null) return null;
  const result = String(value).trim();
  return result || null;
}

function number(value: unknown): number | null {
  if (value == null || value === '') return null;
  const normalized = typeof value === 'string'
    ? value.replace(/\s*%\s*$/, '').replace(',', '.').trim()
    : value;
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
}

function platform(value: unknown, fallback = 'other'): string {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[._-]+/g, ' ');
  if (!raw) return fallback;
  if (raw.includes('instagram')) return 'instagram';
  if (raw === 'tik tok' || raw.includes('tiktok')) return 'tiktok';
  if (raw === 'vk' || raw.includes('vkontakte')) return 'vk';
  if (raw.includes('shopee')) return 'shopee';
  if (raw.includes('lazada')) return 'lazada';
  if (raw.includes('facebook')) return 'facebook';
  if (raw.includes('telegram')) return 'telegram';
  if (raw.includes('youtube')) return 'youtube';
  return 'other';
}

function product(value: unknown): string | null {
  const raw = text(value);
  if (!raw || raw === '0') return null;
  if (/^\d{3}[A-Z]*$/i.test(raw)) return `DE${raw.toUpperCase()}`;
  return raw.toUpperCase();
}

function contentType(url: string | null): string | null {
  if (!url) return null;
  if (/\/reels?\//i.test(url)) return 'reel';
  if (/\/p\//i.test(url)) return 'post';
  if (/\/video\//i.test(url)) return 'video';
  return null;
}

export async function parseUgcWorkbook(buffer: ArrayBuffer, workbookName: string): Promise<UgcImportRow[]> {
  const XLSX = await import('xlsx-js-style');
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const output: UgcImportRow[] = [];

  const legacy = workbook.Sheets.Sheet1;
  if (legacy) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(legacy, { header: 1, raw: true, defval: null });
    // A1 contains the first real creator handle while B1:U1 are headers.
    // Blank A cells below mean "same creator", not an unknown creator.
    let handle = text(rows[0]?.[0]);
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index] ?? [];
      handle = text(row[0]) ?? handle;
      if (!handle) continue;
      const url = text(row[8]);
      const products = [row[13], row[14], row[15], row[16], row[17]]
        .map(product)
        .filter((value): value is string => Boolean(value));
      output.push({
        handle,
        platform: 'instagram',
        followers: number(row[1]),
        engagement_rate: number(row[2]),
        comments: number(row[6]),
        views: number(row[7]),
        content_url: url,
        content_type: contentType(url),
        usage_label: text(row[9]),
        source_rating: number(row[10]),
        display_name: text(row[11]),
        source_valid: text(row[12]),
        product_codes: products,
        audio_label: text(row[19]),
        download_url: text(row[20]),
        source_workbook: workbookName,
        source_sheet: 'Sheet1',
        source_row: index + 1,
      });
    }
  }

  const newer = workbook.Sheets.NEW;
  if (newer) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(newer, { header: 1, raw: true, defval: null });
    let handle: string | null = null;
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index] ?? [];
      handle = text(row[0]) ?? handle;
      if (!handle) continue;
      const url = text(row[5]);
      const products = [row[3], row[4]].map(product).filter((value): value is string => Boolean(value));
      output.push({
        handle,
        platform: platform(row[1]),
        views: number(row[2]),
        content_url: url,
        content_type: contentType(url),
        product_codes: products,
        source_valid: text(row[6]),
        audio_label: text(row[7]),
        source_workbook: workbookName,
        source_sheet: 'NEW',
        source_row: index + 1,
      });
    }
  }

  return output;
}
