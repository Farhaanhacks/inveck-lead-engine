import type { Services } from './services';

/**
 * Where places are, so "is this person at the lead's site?" is a matter of distance, not of a list
 * of city names: someone in "Ahmedabad, Gujarat" works at a Sanand plant (22 km), someone in
 * "Hyderabad" doesn't. Places are looked up on Google Maps (through Serper) once and kept in the
 * database for good; a place that can't be found is "not known", never "elsewhere".
 */

/** A person this close to the lead's site works there: a plant's staff live across its metro area. */
export const SITE_RADIUS_KM = 60;

export type Point = { lat: number; lng: number };

/** Looked up this run (also from the database): a point, null for "not found". */
const known = new Map<string, Point | null>();

/** The place as written, reduced to what identifies it: "Greater Ahmedabad Area" gives "ahmedabad". */
export function placeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(greater|area|region|metropolitan|metro|division|district|urban|rural)\b/g, ' ')
    .replace(/[^a-z0-9,]+/g, ' ')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .join(', ');
}

/** States and the country alone don't say which site someone is at; they aren't looked up. */
const REGION_ONLY = /^(india|bharat|maharashtra|gujarat|karnataka|tamil nadu|telangana|andhra pradesh|kerala|goa|rajasthan|madhya pradesh|uttar pradesh|uttarakhand|haryana|punjab|himachal pradesh|jammu and kashmir|jammu kashmir|bihar|jharkhand|odisha|west bengal|assam|chhattisgarh|north india|south india|east india|west india)$/;

function lookupable(key: string): boolean {
  const first = key.split(',')[0]?.trim() ?? '';
  return first.length >= 3 && !REGION_ONLY.test(first);
}

const inIndia = (p: Point) => p.lat > 6 && p.lat < 37.5 && p.lng > 68 && p.lng < 97.5;

/** The distance between two points, in km. */
export function distanceKm(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** A place looked up earlier: a point, null when it wasn't found, undefined when it hasn't been looked up. */
export function pointOf(text: string | null | undefined): Point | null | undefined {
  const key = placeKey(String(text ?? ''));
  if (!key || !lookupable(key)) return null;
  return known.get(key);
}

async function lookUp(svc: Services, key: string): Promise<Point | null> {
  const cacheKey = `place:v1:${key}`;
  try {
    const hit = (await svc.cache?.get(cacheKey)) as { point: Point | null } | null | undefined;
    if (hit && 'point' in hit) return hit.point;
  } catch {}
  const res = await svc.fetch('https://google.serper.dev/maps', {
    method: 'POST',
    headers: { 'X-API-KEY': svc.keys.serper, 'content-type': 'application/json' },
    body: JSON.stringify({ q: /\bindia\b/.test(key) ? key : `${key}, India`, gl: 'in' }),
  });
  if (!res.ok) throw new Error(`maps search ${res.status}`);
  const data = (await res.json()) as { places?: { latitude?: number; longitude?: number; type?: string; types?: string[] }[] };
  // A town or city comes back as a place with no business type. Anything else is a landmark or a
  // business that shares the name ("Raigad" gives Raigad Fort): not the place someone lives in.
  const first = data.places?.[0];
  const point = first && !first.type && !first.types?.length && typeof first.latitude === 'number' && typeof first.longitude === 'number' ? { lat: first.latitude, lng: first.longitude } : null;
  const result = point && inIndia(point) ? point : null;
  await svc.cache?.set(cacheKey, { point: result }).catch(() => {});
  return result;
}

/**
 * Looks up the places not known yet (a few at a time). A lookup that fails leaves the place not
 * looked up, so the text rules decide for it this time. Never throws.
 */
export async function knowPlaces(svc: Services, texts: (string | null | undefined)[]): Promise<void> {
  if (!svc.keys.serper) return;
  const keys = [...new Set(texts.map((t) => placeKey(String(t ?? ''))))].filter((k) => k && lookupable(k) && !known.has(k));
  const queue = [...keys];
  const worker = async () => {
    for (let key = queue.shift(); key; key = queue.shift()) {
      try {
        known.set(key, await lookUp(svc, key));
      } catch {
        // Not known this time.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
}

/** Tests only: forget the places looked up. */
export function forgetPlaces() {
  known.clear();
}
