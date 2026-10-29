import { CmsError, type CmsAdapter, type ConnectionStatus, type MediaInput, type MediaResult, type PostInput, type PostResult } from './types';

type WpPost = { id: number; link?: string; status?: string; slug?: string; content?: { raw?: string; rendered?: string } };

const marker = (articleId: string) => `<!-- inveck-blog:${articleId} -->`;

/**
 * WordPress REST API adapter (core endpoints: /wp/v2/posts, /media, /categories, /tags) using an Application Password.
 * Verified against the WordPress REST API with an Application Password (core endpoints only).
 * Not yet exercised with credentials, so the first real publish should be done on a draft (see docs).
 */
export class WordPressAdapter implements CmsAdapter {
  readonly name = 'wordpress';
  readonly isMock = false;
  private readonly base: string;
  private readonly auth: string;

  constructor(baseUrl: string, username: string, appPassword: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${username}:${appPassword.replace(/\s+/g, '')}`).toString('base64')}`;
  }

  private async req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: this.auth, accept: 'application/json', ...((init.headers as Record<string, string>) ?? {}) };
    let body = init.body;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    try {
      return await this.fetchImpl(`${this.base}/wp-json${path}`, { ...init, headers, body, signal: AbortSignal.timeout(45_000) });
    } catch (e) {
      throw new CmsError(`Could not reach WordPress: ${e instanceof Error ? e.message : String(e)}`, 'unavailable', true);
    }
  }

  private async check(res: Response, what: string): Promise<unknown> {
    if (res.ok) return res.json();
    const text = (await res.text().catch(() => '')).slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new CmsError(`WordPress refused the credentials while ${what} (${res.status}). ${text}`, 'auth_failed', false, res.status);
    if (res.status === 429 || res.status >= 500) throw new CmsError(`WordPress is unavailable while ${what} (${res.status}).`, 'unavailable', true, res.status);
    throw new CmsError(`WordPress rejected the request while ${what} (${res.status}): ${text}`, 'rejected', false, res.status);
  }

  async testConnection(): Promise<ConnectionStatus> {
    const checkedAt = new Date().toISOString();
    try {
      const me = (await this.check(await this.req('/wp/v2/users/me?context=edit'), 'checking the account')) as { name?: string; capabilities?: Record<string, boolean> };
      const caps = me.capabilities ?? {};
      const confirmed = [caps.publish_posts && 'can publish posts', caps.upload_files && 'can upload media', caps.edit_posts && 'can edit posts'].filter((x): x is string => !!x);
      if (!caps.publish_posts) return { state: 'auth_failed', detail: `Signed in as ${me.name ?? 'user'}, but this account cannot publish posts. Use an Author, Editor or Administrator account.`, checkedAt, confirmed };
      if (!caps.upload_files) return { state: 'auth_failed', detail: 'This account cannot upload media, so featured images would fail.', checkedAt, confirmed };
      const root = (await this.check(await this.req('/'), 'reading the site')) as { name?: string };
      return { state: 'connected', detail: `Signed in as ${me.name ?? 'user'}.`, checkedAt, siteName: root.name, confirmed };
    } catch (e) {
      if (e instanceof CmsError) return { state: e.code === 'auth_failed' ? 'auth_failed' : 'unavailable', detail: e.message, checkedAt };
      return { state: 'unavailable', detail: e instanceof Error ? e.message : String(e), checkedAt };
    }
  }

  async uploadMedia(input: MediaInput): Promise<MediaResult> {
    const body = new Uint8Array(input.bytes);
    const res = await this.req('/wp/v2/media', {
      method: 'POST',
      headers: { 'content-disposition': `attachment; filename="${input.filename.replace(/"/g, '')}"`, 'content-type': input.mimeType },
      body,
    });
    const media = (await this.check(res, 'uploading the featured image')) as { id: number; source_url?: string };
    // Alt text and title are separate fields set after the upload.
    await this.check(await this.req(`/wp/v2/media/${media.id}`, { method: 'POST', json: { alt_text: input.altText, title: input.title } }), 'setting image alt text');
    return { mediaId: String(media.id), url: media.source_url ?? '' };
  }

  private async termIds(kind: 'categories' | 'tags', names: string[], create: boolean): Promise<number[]> {
    const ids: number[] = [];
    for (const name of names) {
      const found = (await this.check(await this.req(`/wp/v2/${kind}?search=${encodeURIComponent(name)}&per_page=100&_fields=id,name,slug`), `looking up ${kind}`)) as { id: number; name: string }[];
      const hit = found.find((t) => decodeEntities(t.name).toLowerCase() === name.toLowerCase());
      if (hit) { ids.push(hit.id); continue; }
      if (!create) throw new CmsError(`The WordPress category "${name}" does not exist. Create it, or change the domain's publishing category.`, 'category_missing', false);
      const res = await this.req(`/wp/v2/${kind}`, { method: 'POST', json: { name } });
      if (res.status === 400) {
        const err = (await res.json().catch(() => ({}))) as { code?: string; data?: { term_id?: number } };
        if (err.code === 'term_exists' && err.data?.term_id) { ids.push(err.data.term_id); continue; }
      }
      const made = (await this.check(res, `creating the ${kind.slice(0, -1)} "${name}"`)) as { id: number };
      ids.push(made.id);
    }
    return ids;
  }

  private shape(p: WpPost, notes: Record<string, unknown> = {}): PostResult {
    return { cmsPostId: String(p.id), url: p.link ?? '', status: p.status ?? 'unknown', notes };
  }

  async findExisting(articleId: string, slug: string): Promise<PostResult | null> {
    const list = (await this.check(await this.req(`/wp/v2/posts?slug=${encodeURIComponent(slug)}&status=any&context=edit&_fields=id,link,status,slug,content`), 'looking for an earlier post')) as WpPost[];
    const mine = list.find((p) => p.content?.raw?.includes(marker(articleId)));
    return mine ? this.shape(mine, { adopted: true }) : null;
  }

  async getPost(cmsPostId: string): Promise<PostResult | null> {
    const res = await this.req(`/wp/v2/posts/${encodeURIComponent(cmsPostId)}?context=edit&_fields=id,link,status,slug`);
    if (res.status === 404) return null;
    return this.shape((await this.check(res, 'reading the post')) as WpPost);
  }

  async createPost(input: PostInput): Promise<PostResult> {
    const [categories, tags] = await Promise.all([this.termIds('categories', input.categoryNames, false), this.termIds('tags', input.tags, true)]);
    const created = (await this.check(
      await this.req('/wp/v2/posts', {
        method: 'POST',
        json: {
          title: input.title,
          slug: input.slug,
          content: `${input.contentHtml}\n${marker(input.articleId)}`,
          excerpt: input.excerpt,
          status: input.status,
          categories,
          tags,
          ...(input.featuredMediaId ? { featured_media: Number(input.featuredMediaId) } : {}),
          ...(input.authorWpId ? { author: input.authorWpId } : {}),
        },
      }),
      'creating the post',
    )) as WpPost;

    const notes: Record<string, unknown> = {};
    if (input.seo && (input.seo.title || input.seo.description || input.seo.focusKeyword)) {
      // Rank Math is installed on the site. Its meta-update route is not part of WordPress core and is not formally documented,
      // so a failure here is recorded but never blocks or undoes the publication.
      try {
        const res = await this.req('/rankmath/v1/updateMeta', {
          method: 'POST',
          json: { objectID: created.id, objectType: 'post', meta: { rank_math_title: input.seo.title, rank_math_description: input.seo.description, rank_math_focus_keyword: input.seo.focusKeyword } },
        });
        notes.rankMathMeta = res.ok ? 'applied' : `not applied (${res.status})`;
      } catch (e) {
        notes.rankMathMeta = `not applied (${e instanceof Error ? e.message : 'error'})`;
      }
    }
    const result = this.shape(created, notes);
    // Confirm from the CMS itself rather than trusting our own request.
    if (input.status === 'publish' && (result.status !== 'publish' || !result.url)) {
      throw new CmsError(`WordPress created post ${created.id} but it is not published (status "${result.status}").`, 'unverified', false);
    }
    return result;
  }

  async unpublish(cmsPostId: string): Promise<void> {
    await this.check(await this.req(`/wp/v2/posts/${encodeURIComponent(cmsPostId)}`, { method: 'POST', json: { status: 'draft' } }), 'unpublishing');
  }
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&#8217;/g, '’').replace(/&#038;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
