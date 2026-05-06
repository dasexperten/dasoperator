// =============================================================================
// LLM Task — Generate NDA
//
// Pulls partner data + DEI data + skill extract + design canon + bilingual
// template from R2, calls DeepSeek PRO, returns final markdown NDA.
// No DOCX rendering here — that's done by the calling route. This file is
// pure: data in, markdown out.
// =============================================================================

import { callPro, type ChatMessage } from '../deepseek';

export interface PartnerForNda {
  id: string;
  trade_name: string;
  legal_name?: string | null;
  country?: string | null;
  registered_address_local?: string | null;
}

export interface DeiCompanyForNda {
  legal_name: string;
  jurisdiction: string;
  registered_address: string;
  registration_no: string;
  signing_authority_name: string;
  signing_authority_title: string;
}

export interface GenerateNdaInput {
  partner: PartnerForNda;
  dei: DeiCompanyForNda;
  signingDate: string;        // formatted, e.g. "May 6, 2026"
  designCanon: string;        // contents of templates/das-design-canon.md (R2)
  skillExtract: string;       // contents of templates/nda-skill-extract.md (R2)
  template: string;           // contents of selected nda template (R2)
  apiKey: string;
}

export interface GenerateNdaResult {
  markdown: string;
  tokensUsed: { in: number; out: number };
}

export async function generateNda(input: GenerateNdaInput): Promise<GenerateNdaResult> {
  // Compose data block — DeepSeek will substitute these into the template
  const dataBlock = [
    `partner_legal_name: ${input.partner.legal_name ?? input.partner.trade_name}`,
    `partner_country: ${input.partner.country ?? '[NOT PROVIDED]'}`,
    `partner_registered_address: ${input.partner.registered_address_local ?? '[NOT PROVIDED]'}`,
    `dei_legal_name: ${input.dei.legal_name}`,
    `dei_jurisdiction: ${input.dei.jurisdiction}`,
    `dei_registered_address: ${input.dei.registered_address}`,
    `dei_registration_no: ${input.dei.registration_no}`,
    `dei_signing_authority_name: ${input.dei.signing_authority_name}`,
    `dei_signing_authority_title: ${input.dei.signing_authority_title}`,
    `signing_date: ${input.signingDate}`,
  ].join('\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${input.designCanon}

---

${input.skillExtract}

You will be given a template with {{placeholders}} and a data block. Replace the placeholders with the data values and return the final document as markdown.

CRITICAL: Preserve the EXACT structural layout of the template. Do not change paragraph order, do not merge sections, do not switch between layouts. The template's structure IS the layout.`,
    },
    {
      role: 'user',
      content: `=== TEMPLATE ===
${input.template}

=== DATA ===
${dataBlock}

=== TASK ===
Generate the final NDA in markdown. Replace all {{variables}} with the data above. Apply ALL design canon rules and legalizer skill rules. Return ONLY the markdown — no preamble, no commentary, no code fences. Start with the document title.`,
    },
  ];

  const result = await callPro(messages, {
    apiKey: input.apiKey,
    temperature: 0.2,
    maxTokens: 8000,
  });

  return {
    markdown: result.text.trim(),
    tokensUsed: {
      in: result.usage.prompt_tokens,
      out: result.usage.completion_tokens,
    },
  };
}

// =============================================================================
// Template selection — maps partner_language to R2 key.
// Defaults to EN if language is not yet supported (future: throw error).
// =============================================================================
const SUPPORTED_LANGUAGES = ['EN', 'RU', 'EN-RU', 'EN-AR', 'EN-VI', 'EN-ZH'] as const;
type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

export function ndaTemplateKey(partnerLanguage: string | null | undefined): string {
  const lang = (partnerLanguage ?? 'EN').toUpperCase();
  if (!SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)) {
    // Fallback to EN for unknown languages
    return 'templates/nda/nda-mutual-EN.md';
  }
  return `templates/nda/nda-mutual-${lang}.md`;
}

export function isPartnerLanguageSupported(partnerLanguage: string | null | undefined): boolean {
  const lang = (partnerLanguage ?? 'EN').toUpperCase();
  return SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage);
}

// =============================================================================
// Languages requiring local legal review before sending to partner.
// AR/VI translations are good but not native — local lawyer should sweep.
// EN/RU/ZH/EN-RU don't need this gate (RU and ZH are DeepSeek strengths;
// EN is universal; EN-RU is mature pair).
// =============================================================================
export function requiresLocalLegalReview(partnerLanguage: string | null | undefined): boolean {
  const lang = (partnerLanguage ?? 'EN').toUpperCase();
  return lang === 'EN-AR' || lang === 'EN-VI';
}
