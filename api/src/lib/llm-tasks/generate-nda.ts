// =============================================================================
// LLM Task — Generate NDA
//
// Pulls partner data + DEI data + skill extract + template from R2, calls
// DeepSeek PRO, returns final markdown NDA. No PDF rendering here — that's
// done by the calling route. This file is pure: data in, markdown out.
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
  signingDate: string;        // ISO-formatted, e.g. "May 6, 2026"
  skillExtract: string;       // contents of templates/nda-skill-extract.md (R2)
  template: string;           // contents of templates/nda-mutual-en.md (R2)
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
      content: `${input.skillExtract}

You will be given a template with {{placeholders}} and a data block. Replace the placeholders with the data values and return the final document as markdown.`,
    },
    {
      role: 'user',
      content: `=== TEMPLATE ===
${input.template}

=== DATA ===
${dataBlock}

=== TASK ===
Generate the final NDA in markdown. Replace all {{variables}} with the data above. Apply legalizer skill rules. Return only the markdown — no preamble, no commentary, no code fences. Start with the document title (# NON-DISCLOSURE AGREEMENT).`,
    },
  ];

  const result = await callPro(messages, {
    apiKey: input.apiKey,
    temperature: 0.2,  // very low — we want deterministic legal text
    maxTokens: 6000,   // typical NDA is ~3000 tokens, headroom for safety
  });

  return {
    markdown: result.text.trim(),
    tokensUsed: {
      in: result.usage.prompt_tokens,
      out: result.usage.completion_tokens,
    },
  };
}
