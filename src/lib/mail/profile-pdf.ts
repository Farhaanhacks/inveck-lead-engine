import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { templateFor } from '../whatsapp-outreach';
import { MailError } from './outlook';

/**
 * The INVECK product profile attached to outreach emails, kept in the repository's `assets/` folder:
 *   assets/inveck-profile-manufacturing.pdf   Manufacturing companies
 *   assets/inveck-profile-3pl.pdf             3PL & Logistics / warehousing companies
 *   assets/inveck-product-profile.pdf         anything else (CA firms too), used when no segment file applies
 */
export const PROFILE_FILES = { manufacturing: 'inveck-profile-manufacturing.pdf', '3pl': 'inveck-profile-3pl.pdf' } as const;
export const GENERAL_PROFILE_FILE = 'inveck-product-profile.pdf';
/** Graph's sendMail takes attachments up to about 3 MB in the request itself. */
const MAX_BYTES = 3 * 1024 * 1024;

async function read(dir: string, file: string): Promise<Buffer | null> {
  try {
    return await readFile(join(dir, file));
  } catch {
    return null;
  }
}

/**
 * The profile for the company's segment as an attachment, or null while no file is in `assets/` for it (the email
 * then goes without one: nothing is invented in its place).
 */
export async function loadProfilePdf(segment: string, dir = join(process.cwd(), 'assets')): Promise<{ name: string; contentType: string; bytes: Buffer } | null> {
  const t = templateFor(segment);
  const specific = t === 'manufacturing' || t === '3pl' ? PROFILE_FILES[t] : null;
  const bytes = (specific && (await read(dir, specific))) || (await read(dir, GENERAL_PROFILE_FILE));
  if (!bytes) return null;
  if (bytes.length > MAX_BYTES) throw new MailError(`The product profile PDF is too large to attach (${(bytes.length / 1048576).toFixed(1)} MB; the limit is 3 MB). Ask an administrator for a smaller file.`);
  return { name: 'INVECK Product Profile.pdf', contentType: 'application/pdf', bytes };
}
