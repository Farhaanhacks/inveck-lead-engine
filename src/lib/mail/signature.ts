import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { users } from '../db/schema';

/**
 * The INVECK email signature, added to every email the CRM sends from a person's Outlook (never to WhatsApp or anything
 * else). The name and number are the sending person's own, from their user record. The logo goes with the email as an
 * inline attachment (referenced by Content-ID), so it shows for the recipient without any link back to the CRM.
 */

export const LOGO_CID = 'inveck-email-logo';
const OFFICE = ['4th Floor, Above Shinhan Bank,', 'Red Building, Boat Club Road, DP Road,', 'Pune – 411001'];
const WEBSITE = 'https://inveck.com/';
const DISCLAIMER =
  'Disclaimer: The contents, attachments, and information provided in this email are privileged and confidential material of AK Finserv and are sent to the intended addressee(s). The said contents should not be disclosed to, used by, or copied in any manner by anyone else. In case you are not the intended addressee, you should delete this message and/or re-direct it to the sender. The attachments to this email have been scanned by an antivirus trusted by AK Finserv. However, the recipient should ensure that it is virus-free.';

/** Full name and number for each person's signature, matched on the first name saved on their account. */
const SIGNATURE_DETAILS: Record<string, { name: string; phone: string }> = {
  parimal: { name: 'Parimal Dhake', phone: '+91-8149991842' },
  puja: { name: 'Puja Mehta', phone: '+91-8149123078' },
  anchal: { name: 'Anchal Parekh', phone: '+91-7774042851' },
  anuradha: { name: 'Anuradha Pohare', phone: '+91-7522988834' },
};

/** Once per start: fills in the signature name and number of the team members that have none yet (never overwrites an edit). */
export async function backfillSignatureDetails(db: Db): Promise<void> {
  for (const [first, d] of Object.entries(SIGNATURE_DETAILS)) {
    await db
      .update(users)
      .set({ signatureName: d.name })
      .where(sql`${users.signatureName} = '' AND lower(split_part(trim(${users.name}), ' ', 1)) = ${first}`);
    await db
      .update(users)
      .set({ phone: d.phone })
      .where(sql`${users.phone} = '' AND lower(split_part(trim(${users.name}), ' ', 1)) = ${first}`);
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = "font-family:Aptos,Calibri,'Segoe UI',Arial,sans-serif;";

/** True when the text already carries the signature (typed in by hand, or in a template), so it is never added twice. */
export function hasSignature(text: string): boolean {
  return /privileged and confidential material of AK Finserv/i.test(text) || /\|\s*Inveck India\b/i.test(text);
}

/**
 * A closing the draft ends with ("Regards, Puja"): dropped when the signature goes on, since the signature opens with its
 * own "Thanks & Regards," and name. Only a closing followed by the sender's own name (or INVECK) is taken off.
 */
export function withoutSignOff(text: string, names: string[]): string {
  // "Regards", "Best regards", "Thanks & Regards", "Sincerely": always a closing. A bare "Thanks" or "Best" only with their name.
  const m = /\n[ \t]*((?:(?:thanks|thank you)\s*(?:&|and)\s*)?(?:(?:kind|best|warm|warmest|with|many)\s+)?regards|best wishes|sincerely|yours sincerely|thanks|thank you|cheers|best)[ \t]*,?[ \t]*((?:\n[ \t]*[^\n]{1,60}){1,2})[ \t\n]*$/i.exec(text);
  if (!m) return text;
  const tail = m[2].toLowerCase();
  const strong = /regards|sincerely|best wishes/i.test(m[1]);
  return strong || names.some((n) => n && tail.includes(n.toLowerCase())) || tail.includes('inveck') ? text.slice(0, m.index).trimEnd() : text;
}

/** A plain-text email as HTML: text escaped, line breaks kept, web addresses made links. */
export function textToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => esc(line).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g, (u) => `<a href="${u}">${u}</a>`));
  return `<div style="${FONT}font-size:11pt;color:#000;">${lines.join('<br>')}</div>`;
}

/** The signature block. `withLogo`: the logo is attached (inline) under the website line. */
export function signatureHtml(who: { name: string; phone: string }, withLogo: boolean): string {
  const p = (inner: string, extra = '') => `<p style="margin:0;${extra}">${inner}</p>`;
  const rule = '<hr style="border:0;border-top:1px solid #a0a0a0;margin:12px 0 0;width:80%;max-width:640px;" align="left">';
  return [
    `<div style="${FONT}font-size:11pt;color:#000;line-height:1.35;margin-top:18px;">`,
    p('Thanks &amp; Regards,'),
    '<br>',
    p(`<b style="font-size:13pt;">${esc(who.name)} | Inveck India</b>`),
    p('Business Development', 'font-size:13pt;'),
    ...(who.phone ? ['<br>', p(`Contact No: ${esc(who.phone)}`, 'font-size:13pt;')] : []),
    '<br>',
    p('Corporate Office:', 'font-size:11pt;'),
    ...OFFICE.map((l) => p(esc(l), 'font-size:10.5pt;')),
    '<br>',
    p(`Visit us at: <a href="${WEBSITE}" style="color:#0563c1;">${WEBSITE}</a>`, 'font-size:11pt;'),
    ...(withLogo ? [`<p style="margin:10px 0 0;"><img src="cid:${LOGO_CID}" alt="Inveck" width="140" style="display:block;width:140px;height:auto;border:0;"></p>`] : []),
    rule,
    `<p style="margin:10px 0 0;font-size:9pt;line-height:1.9;color:#333;">${esc(DISCLAIMER)}</p>`,
    '<hr style="border:0;border-top:1px solid #a0a0a0;margin:10px 0 0;" align="left">',
    '</div>',
  ].join('');
}

export type Logo = { name: string; contentType: string; bytes: Buffer };
let cached: { dir: string; logo: Logo | null } | undefined;

/**
 * The logo for the signature: assets/emaillogo.* (any common image type), else assets/inveck.webp. Outlook and Gmail
 * don't reliably show WebP, so anything but PNG, JPEG or GIF is converted to PNG here (the file itself is untouched).
 */
export async function loadEmailLogo(dir = join(process.cwd(), 'assets')): Promise<Logo | null> {
  if (cached?.dir === dir) return cached.logo;
  let logo: Logo | null = null;
  try {
    const files = await readdir(dir);
    const pick = (stem: string) => files.find((f) => f.toLowerCase().replace(/\.[^.]+$/, '') === stem && /\.(png|jpe?g|gif|webp)$/i.test(f));
    const file = pick('emaillogo') ?? pick('inveck');
    if (file) {
      const raw = await readFile(join(dir, file));
      const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
      if (ext === 'png' || ext === 'gif') logo = { name: `inveck-logo.${ext}`, contentType: `image/${ext}`, bytes: raw };
      else if (ext === 'jpg' || ext === 'jpeg') logo = { name: 'inveck-logo.jpg', contentType: 'image/jpeg', bytes: raw };
      else {
        const { default: sharp } = await import('sharp');
        logo = { name: 'inveck-logo.png', contentType: 'image/png', bytes: await sharp(raw).png().toBuffer() };
      }
    }
  } catch (e) {
    console.error('[mail] the signature logo could not be read:', e);
  }
  if (!logo) console.error('[mail] no logo found in assets/ (emaillogo.* or inveck.webp): emails go with the signature text only.');
  cached = { dir, logo };
  return logo;
}

/** The sender's signature details, from their own account. */
export async function signerOf(db: Db, userId: number): Promise<{ name: string; phone: string }> {
  const [u] = await db.select({ name: users.name, signatureName: users.signatureName, phone: users.phone }).from(users).where(eq(users.id, userId));
  return { name: u?.signatureName || u?.name || '', phone: u?.phone ?? '' };
}
