import type { Icp, Signal } from '../db/schema';
import { askJson } from './ai';
import type { Contact } from './contacts';
import { DRAFT_PROMPT, LINKEDIN_PROMPT } from './prompts';
import type { Research } from './research';
import type { Services } from './services';
import { asText } from './text';
import { signalLines } from './signals';

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

const linkedinSchema = {
  type: 'object',
  properties: { linkedin_message: { type: 'string' } },
  required: ['linkedin_message'],
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

type Lead = { company: string; city: string; segment: string };

function outreachBrief(svc: Services, lead: Lead, research: Research, icp: Icp, contact: Pick<Contact, 'name' | 'title'>, signals: Signal[]): string {
  const s = svc.settings;
  return [
    `## Company: ${lead.company}${lead.city ? ` (${lead.city})` : ''}`,
    research.text,
    '',
    `## ICP segment: ${lead.segment}`,
    `Pitch angle: ${icp.pitchAngle}`,
    '',
    ...(signals.length ? ['## Recent news (buying signals)', signalLines(signals), ''] : []),
    '## Contact',
    ...(contact.name
      ? [`Name: ${contact.name}`, `Title: ${contact.title}`]
      : ['Not found yet. Write to whoever runs plant operations or the supply chain there, greet with "Hello," (no name), and never invent a name.']),
    '',
    '## Sender',
    `Name: ${s.senderName}`,
    `Title: ${s.senderTitle}`,
    `Company: ${s.senderCompany}`,
    `Demo link: ${s.demoLink || '(none; ask for a convenient time instead)'}`,
  ].join('\n');
}

async function askLinkedin(svc: Services, brief: string, email: { subject: string; body: string }): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const li = await askJson(svc, LINKEDIN_PROMPT, `${brief}\n\n## The email already written\nSubject: ${email.subject}\n\n${email.body}`, linkedinSchema);
    const text = li.data ? readDraft(li.data).linkedin || asText(Object.values(li.data)[0]) : '';
    if (text) return text;
  }
  return '';
}

/** A LinkedIn message to go with an email already written (kept as the team may have edited it). */
export async function writeLinkedinMessage(svc: Services, lead: Lead, research: Research, icp: Icp, contact: Pick<Contact, 'name' | 'title'>, email: { subject: string; body: string }): Promise<string> {
  return askLinkedin(svc, outreachBrief(svc, lead, research, icp, contact, []), email);
}

export async function writeOutreach(
  svc: Services,
  lead: Lead,
  research: Research,
  icp: Icp,
  contact: Pick<Contact, 'name' | 'title'>,
  signals: Signal[] = [],
): Promise<{ draft?: Draft; error?: string }> {
  const userText = outreachBrief(svc, lead, research, icp, contact, signals);
  // DeepSeek occasionally drops or renames a field; a retry nearly always fixes it.
  let error = '';
  let best: Draft | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await askJson(svc, DRAFT_PROMPT, userText, schema);
    if (result.error !== undefined) {
      error = result.error;
      continue;
    }
    const draft = readDraft(result.data);
    if (draft.subject && draft.body && draft.linkedin) return { draft };
    if (draft.subject && draft.body) best = draft;
    const missing = !draft.subject ? 'a subject' : !draft.body ? 'a body' : 'a LinkedIn message';
    error = `The AI draft is missing ${missing} (it returned: ${Object.keys(result.data).join(', ') || 'nothing'})`;
  }
  // The email came back but the LinkedIn message never did: ask for that alone.
  if (best) return { draft: { ...best, linkedin: await askLinkedin(svc, userText, best) } };
  return { error };
}
