import type { Services } from '../pipeline/services';
import { fetchWebsiteText } from '../pipeline/site-reader';

/**
 * The words on a company's own website, for its industry when LinkedIn doesn't show it: the home page
 * read directly, never through Google, so it costs no search credit. '' when there's no website or it
 * can't be read.
 */
export async function websiteWords(svc: Services, website: string): Promise<string> {
  if (!website) return '';
  try {
    const site = await fetchWebsiteText(svc, website, { useGoogle: false });
    return site.text.slice(0, 6000);
  } catch {
    return '';
  }
}
