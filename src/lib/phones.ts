/**
 * A contact can have several numbers, kept in one field: "98450 12345, 080 2222 3333". The first is
 * the one to call and WhatsApp first.
 */
export function splitPhones(value: string | null | undefined): string[] {
  return String(value ?? '')
    .split(/\s*[,;/|\n]\s*/)
    .map((p) => p.trim())
    .filter((p) => p.replace(/\D/g, '').length >= 6);
}

const digits = (p: string) => p.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');

/** The numbers with another added at the end (not twice, however it is written). */
export function addPhone(value: string, phone: string): string {
  const list = splitPhones(value);
  if (!splitPhones(phone).length || list.some((p) => digits(p) === digits(phone))) return list.join(', ');
  return [...list, phone.trim()].join(', ');
}

/** The numbers without the first one (a wrong number), and that one, so Undo can put it back. */
export function dropFirstPhone(value: string): { removed: string; rest: string } {
  const [removed = '', ...rest] = splitPhones(value);
  return { removed, rest: rest.join(', ') };
}

/** A number put back in front (Undo of a wrong number). */
export function putPhoneBack(value: string, phone: string): string {
  const list = splitPhones(value).filter((p) => digits(p) !== digits(phone));
  return [phone, ...list].join(', ');
}

export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;
