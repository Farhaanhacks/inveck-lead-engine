import type { Icp } from '../db/schema';
import { askJson } from './ai';
import { RESEARCH_PROMPT } from './prompts';
import type { Services } from './services';
import { asBool, asText, asTextList } from './text';

export type LeadInput = { company: string; website: string; domain: string; city: string };

export type Research = {
  summary: string;
  industry: string;
  companySize: string;
  locations: string;
  inventoryComplexity: string;
  warehousing3pl: string;
  erpWms: string;
  verificationNeed: string;
  fitReason: string;
  pitchHook: string;
  targetRoles: string[];
  fitScore: number;
  qualified: boolean;
  /** Human-readable block saved as the lead's research summary. */
  text: string;
};

const WEBSITE_LIMIT = 40_000;

const schema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    industry: { type: 'string' },
    company_size: { type: 'string' },
    locations: { type: 'string' },
    inventory_complexity: { type: 'string' },
    warehousing_3pl: { type: 'string' },
    erp_wms: { type: 'string' },
    verification_need: { type: 'string' },
    qualified: { type: 'boolean' },
    fit_score: { type: 'integer' },
    fit_reason: { type: 'string' },
    target_roles: { type: 'array', items: { type: 'string' } },
    pitch_hook: { type: 'string' },
  },
  required: [
    'summary', 'industry', 'company_size', 'locations', 'inventory_complexity', 'warehousing_3pl',
    'erp_wms', 'verification_need', 'qualified', 'fit_score', 'fit_reason', 'target_roles', 'pitch_hook',
  ],
  additionalProperties: false,
};

/** Addresses on the company's own domain found in its website text. */
export function websiteEmails(text: string, domain: string): string[] {
  if (!domain) return [];
  const found = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map((e) => e.toLowerCase());
  return [...new Set(found.filter((e) => e.endsWith('@' + domain) || e.endsWith('.' + domain)))];
}

export async function researchLead(
  svc: Services,
  lead: LeadInput,
  icp: Icp,
  websiteText: string,
): Promise<{ research?: Research; error?: string }> {
  const text = websiteText.length > WEBSITE_LIMIT ? websiteText.slice(0, WEBSITE_LIMIT) + '\n[website text cut at 40,000 characters]' : websiteText;
  const userText = [
    `## ICP: ${icp.segment}`,
    `Description: ${icp.description}`,
    `Industries: ${icp.industries}`,
    `Company size: ${icp.companySize}`,
    `Geography: ${icp.geography}`,
    `Must-haves: ${icp.mustHaves}`,
    `Deal-breakers: ${icp.dealBreakers}`,
    `Target titles: ${icp.targetTitles}`,
    '',
    '## Company',
    `Name: ${lead.company}`,
    `Website: ${lead.website || 'not given'}`,
    `City: ${lead.city || 'not given'}`,
    '',
    '## Website text',
    text ? `<website>\n${text}\n</website>` : '(The website could not be fetched.)',
  ].join('\n');

  const result = await askJson(svc, RESEARCH_PROMPT, userText, schema);
  if (result.error !== undefined) return { error: result.error };
  const d = result.data;

  const t = (k: string) => asText(d[k]) || 'unknown';
  const fitScore = Math.max(0, Math.min(10, Math.round(parseFloat(asText(d.fit_score)) || 0)));
  const targetRoles = asTextList(d.target_roles);
  const research: Research = {
    summary: t('summary'),
    industry: t('industry'),
    companySize: t('company_size'),
    locations: t('locations'),
    inventoryComplexity: t('inventory_complexity'),
    warehousing3pl: t('warehousing_3pl'),
    erpWms: t('erp_wms'),
    verificationNeed: t('verification_need'),
    fitReason: t('fit_reason'),
    pitchHook: t('pitch_hook'),
    targetRoles,
    fitScore,
    qualified: asBool(d.qualified) && fitScore >= 6,
    text: '',
  };
  research.text = [
    research.summary,
    '',
    `Industry: ${research.industry}`,
    `Size: ${research.companySize}`,
    `Locations: ${research.locations}`,
    `Inventory complexity: ${research.inventoryComplexity}`,
    `Warehousing / 3PL: ${research.warehousing3pl}`,
    `ERP / WMS: ${research.erpWms}`,
    `Verification need: ${research.verificationNeed}`,
    `Roles to approach: ${targetRoles.join(', ')}`,
    `Pitch hook: ${research.pitchHook}`,
  ].join('\n');
  return { research };
}
