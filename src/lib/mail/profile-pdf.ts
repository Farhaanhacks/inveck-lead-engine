import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MailError } from './outlook';

/** The INVECK product profile, attached to outreach emails. Kept in the repository (not in the database). */
export const PROFILE_PDF_FILE = 'inveck-product-profile.pdf';
/** Graph's sendMail takes attachments up to about 3 MB in the request itself. */
const MAX_BYTES = 3 * 1024 * 1024;

/**
 * The profile as an attachment, or null while the file isn't in `assets/` yet (the email then goes without it:
 * nothing is invented in its place).
 */
export async function loadProfilePdf(dir = join(process.cwd(), 'assets')): Promise<{ name: string; contentType: string; bytes: Buffer } | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(dir, PROFILE_PDF_FILE));
  } catch {
    return null;
  }
  if (bytes.length > MAX_BYTES) throw new MailError(`The product profile PDF is too large to attach (${(bytes.length / 1048576).toFixed(1)} MB; the limit is 3 MB). Ask an administrator for a smaller file.`);
  return { name: 'INVECK Product Profile.pdf', contentType: 'application/pdf', bytes };
}
