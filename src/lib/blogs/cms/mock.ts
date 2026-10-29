import { CmsError, type CmsAdapter, type ConnectionStatus, type MediaInput, type MediaResult, type PostInput, type PostResult } from './types';

/**
 * Local stand-in so the whole flow can be exercised without a CMS. Nothing is sent anywhere; ids and URLs are
 * obviously fake and every post it records is flagged isMock, so it can never count as a real publication.
 */
export class MockCmsAdapter implements CmsAdapter {
  readonly name = 'mock';
  readonly isMock = true;
  readonly created = new Map<string, PostResult>();

  async testConnection(): Promise<ConnectionStatus> {
    return { state: 'mock', detail: 'Mock mode: posts are simulated locally and nothing is published.', checkedAt: new Date().toISOString() };
  }
  async uploadMedia(input: MediaInput): Promise<MediaResult> {
    return { mediaId: `mock-media-${input.filename}`, url: `mock://media/${input.filename}` };
  }
  async findExisting(articleId: string): Promise<PostResult | null> {
    return this.created.get(articleId) ?? null;
  }
  async createPost(input: PostInput): Promise<PostResult> {
    const post: PostResult = { cmsPostId: `mock-${input.articleId.slice(0, 8)}`, url: `mock://inveck-blog.local/${input.slug}`, status: input.status, notes: { mock: true } };
    this.created.set(input.articleId, post);
    return post;
  }
  async getPost(cmsPostId: string): Promise<PostResult | null> {
    return [...this.created.values()].find((p) => p.cmsPostId === cmsPostId) ?? null;
  }
  async unpublish() {}
}

/** Used when nothing is configured: reports honestly and refuses to publish. */
export class UnconfiguredCmsAdapter implements CmsAdapter {
  readonly name = 'unconfigured';
  readonly isMock = false;
  constructor(private readonly reason: string) {}
  async testConnection(): Promise<ConnectionStatus> {
    return { state: 'not_configured', detail: this.reason, checkedAt: new Date().toISOString() };
  }
  private fail(): never {
    throw new CmsError(this.reason, 'not_configured', true);
  }
  async uploadMedia(): Promise<MediaResult> { return this.fail(); }
  async findExisting(): Promise<PostResult | null> { return this.fail(); }
  async createPost(): Promise<PostResult> { return this.fail(); }
  async getPost(): Promise<PostResult | null> { return this.fail(); }
  async unpublish(): Promise<void> { return this.fail(); }
}
