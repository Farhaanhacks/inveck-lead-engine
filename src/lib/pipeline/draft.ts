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

  const result = await askJson(svc, DRAFT_PROMPT, userText, schema);
  if (result.error !== undefined) return { error: result.error };
  const draft = {
    subject: asText(result.data.email_subject),
    body: asText(result.data.email_body),
    linkedin: asText(result.data.linkedin_message),
  };
  if (!draft.subject || !draft.body) return { error: 'The AI draft is missing a subject or body' };
  return { draft };
}
