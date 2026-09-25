import type { Icp } from '../db/schema';
import { askJson } from './ai';
import type { Contact } from './contacts';
import { DRAFT_PROMPT } from './prompts';
import type { Research } from './research';
import type { Services } from './services';
import { asText } from './text';

export type Draft = { subject: string; body: string; linkedin: string };

const schema = {
  type: 'object',
  properties: {
    email_subject: { type: 'string' },
    email_body: { type: 'string' },
    linkedin_message: { type: 'string' },
  },
  required: ['email_subject', 'email_body', 'linkedin_message'],
  additionalProperties: false,
};

/** Every string field in a (possibly nested) reply, keyed by its lower-case path, e.g. "email.subject". */
function flatten(v: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v)) flatten(val, prefix ? `${prefix}.${k.toLowerCase()}` : k.toLowerCase(), out);
  } else if (prefix) {
    const text = asText(v);
    if (text) out[prefix] = text;
  }
  return out;
}

/**
 * Reads the draft whatever DeepSeek called the fields: email_subject, subject,
 * email.subject, emailBody, body, content…
 */
export function readDraft(data: Record<string, unknown>): Draft {
  const fields = Object.entries(flatten(data));
  const find = (test: (key: string) => boolean) => fields.find(([k]) => test(k))?.[1] || '';
  const isLinkedin = (k: string) => /linkedin|connection|dm|inmail/.test(k);
  return {
    subject: find((k) => /subject/.test(k) && !isLinkedin(k)),
    body: find((k) => /(body|content|text|message)$/.test(k) && !/subject/.test(k) && !isLinkedin(k)),
    linkedin: find(isLinkedin),
  };
}

export async function writeOutreach(
  svc: Services,
  lead: { company: string; city: string; segment: string },
  research: Research,
  icp: Icp,
  contact: Contact,
): Promise<{ draft?: Draft; error?: string }> {
  const s = svc.settings;
  const userText = [
    `## Company: ${lead.company}${lead.city ? ` (${lead.city})` : ''}`,
    research.text,
    '',
    `## ICP segment: ${lead.segment}`,
    `Pitch angle: ${icp.pitchAngle}`,
    '',
    '## Contact',
    `Name: ${contact.name}`,
    `Title: ${contact.title}`,
    '',
    '## Sender',
    `Name: ${s.senderName}`,
    `Title: ${s.senderTitle}`,
    `Company: ${s.senderCompany}`,
    `Demo link: ${s.demoLink || '(none; ask for a convenient time instead)'}`,
  ].join('\n');

  // DeepSeek occasionally drops or renames a field; one retry nearly always fixes it.
  let error = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await askJson(svc, DRAFT_PROMPT, userText, schema);
    if (result.error !== undefined) {
      error = result.error;
      continue;
    }
    const draft = readDraft(result.data);
    if (draft.subject && draft.body) return { draft };
    error = `The AI draft is missing ${!draft.subject ? 'a subject' : 'a body'} (it returned: ${Object.keys(result.data).join(', ') || 'nothing'})`;
  }
  return { error };
}
