import { contactFirstName, templateFor } from '../whatsapp-outreach';
import { DEFAULT_TEMPLATES, MISSING_TEXT, renderTemplate, varsFor, type TemplateVariable } from '../config-templates';
import { templateKey, type TemplateSet } from '../config';
import { escHtml } from '../rich-text';

/**
 * The first email to a company whose ICP has a template: fixed wording, never rewritten. The templates are Configuration →
 * Templates (per product and ICP); the variables ({{contact_name}}, {{bd_name}}, {{company_name}}) are the only things filled
 * in. An ICP without an email template (CA firms) keeps the drafted email: this returns null for it. With no configured
 * set given, the built-in Manufacturing and 3PL templates (what the app has always sent) are used.
 */
export type FirstEmail =
  | { template?: 'manufacturing' | '3pl'; subject: string; body: string; /** The body is sanitized HTML (a configured template), not plain text (the built-in fallback). */ html?: boolean; problem: '' }
  | { template?: 'manufacturing' | '3pl'; subject: ''; body: ''; html?: boolean; problem: string };

/** The saved name as the template wants it: the template says "Mr.", so a saved Mr/Mrs/Ms/Shri in front is dropped. */
export function nameForGreeting(full: string | null | undefined): string {
  const name = String(full ?? '').trim().replace(/^(mr|mrs|ms|miss|shri|smt)\.?\s+/i, '').trim();
  return contactFirstName(name) ? name : '';
}

const builtIn = (segment: string): { subject: string; body: string; html?: boolean } | null => {
  const t = templateFor(segment);
  const icp = t === 'manufacturing' ? 'Manufacturing' : t === '3pl' ? '3PL & Logistics' : '';
  const found = DEFAULT_TEMPLATES.find((x) => x.channel === 'email' && x.icp === icp);
  return found ? { subject: found.subject, body: found.body } : null;
};

/**
 * The filled-in email for the lead's ICP at a step (0: the first contact; n: follow-up n), a problem to fix first, or null when
 * that step has no template. Only the first contact falls back to the built-in text when no configured set is given.
 */
export function firstEmailFor(lead: { segment: string; contactName: string; company?: string }, ownerName: string | null | undefined, templates?: TemplateSet, step = 0): FirstEmail | null {
  const tpl = templates ? (templates.get(templateKey(lead.segment, 'email', step)) ?? null) : step === 0 ? builtIn(lead.segment) : null;
  if (!tpl) return null;
  const kind = templateFor(lead.segment);
  const template = step === 0 && (kind === 'manufacturing' || kind === '3pl') ? kind : undefined;
  const rawVars = varsFor({ contactName: lead.contactName, company: lead.company ?? '' }, ownerName, contactFirstName, nameForGreeting);
  // In an HTML template the lead's values are text: never markup.
  const vars = tpl.html ? Object.fromEntries(Object.entries(rawVars).map(([k, v]) => [k, escHtml(v ?? '')])) : rawVars;
  const subject = renderTemplate(tpl.subject, rawVars);
  const body = renderTemplate(tpl.body, vars);
  const missing = new Set<TemplateVariable>([...(subject.ok ? [] : subject.missing), ...(body.ok ? [] : body.missing)]);
  if (!subject.ok || !body.ok) {
    const what = [...new Set([...missing].map((m) => MISSING_TEXT[m]))];
    return { template, subject: '', body: '', problem: `This email can't be sent yet: ${what.join(' and ')} ${what.length > 1 ? 'are' : 'is'} missing in the CRM. Correct the record first.` };
  }
  return { template, subject: subject.text, body: body.text, html: tpl.html, problem: '' };
}
