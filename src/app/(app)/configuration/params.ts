export type ConfigParams = Record<string, string | string[] | undefined>;
/** One value of a query parameter ('' when absent). */
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
