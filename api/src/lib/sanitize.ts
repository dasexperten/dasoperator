/**
 * sanitizeReply — strip all markdown syntax and unwanted symbols from LLM output
 * before posting to Wildberries/Ozon. WB renders plain text only, markdown comes
 * out as visible garbage characters (**, ##, etc).
 *
 * Removes:
 *   **bold**, __bold__ → text
 *   *italic*, _italic_ → text
 *   `code`, ```block``` → text/'' 
 *   ## Header → Header
 *   > blockquote → text
 *   [link text](url) → text
 *   - bullet, 1. number at line start → ''
 *   --- horizontal rules → ''
 *   All emoji and pictographic symbols → ''
 *   Multiple newlines compressed
 *   Trim trailing/leading whitespace per line
 *
 * Preserves:
 *   × ÷ ± — − (mathematical signs needed for "4×10¹⁰", "20–30%")
 *   ¹²³ subscripts/superscripts
 *   Cyrillic, Latin, punctuation
 */
export function sanitizeReply(text: string): string {
  if (!text) return '';
  let t = text;

  // Code blocks (remove entire block)
  t = t.replace(/```[\s\S]*?```/g, '');
  t = t.replace(/`([^`]+)`/g, '$1');

  // Bold/italic — keep inner text
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');
  t = t.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '$1');

  // Headers
  t = t.replace(/^#{1,6}\s+/gm, '');

  // Blockquotes
  t = t.replace(/^>\s+/gm, '');

  // Lists at line start
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+\.\s+/gm, '');

  // Horizontal rules
  t = t.replace(/^[-*_]{3,}\s*$/gm, '');

  // Links
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  t = t.replace(/!\[[^\]]*\]\([^)]+\)/g, '');

  // Emoji and pictographs
  t = t.replace(/[\u{1F300}-\u{1F9FF}]/gu, '');
  t = t.replace(/[\u{1FA00}-\u{1FAFF}]/gu, '');
  t = t.replace(/[\u{2600}-\u{26FF}]/gu, '');
  t = t.replace(/[\u{2700}-\u{27BF}]/gu, '');
  // Variation selectors and zero-width
  t = t.replace(/[\u{FE00}-\u{FE0F}]/gu, '');
  t = t.replace(/[\u{200B}-\u{200D}]/gu, '');

  // Whitespace
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.split('\n').map(line => line.trim()).join('\n');
  t = t.trim();

  return t;
}
