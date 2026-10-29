export type ConnectionState = 'connected' | 'not_configured' | 'auth_failed' | 'unavailable' | 'mock';

export type ConnectionStatus = {
  state: ConnectionState;
  detail: string;
  checkedAt: string;
  siteName?: string;
  /** Capabilities the adapter could confirm, for example "can create posts". */
  confirmed?: string[];
};

export type MediaInput = { bytes: Buffer; filename: string; mimeType: string; altText: string; title: string };
export type MediaResult = { mediaId: string; url: string };

export type PostInput = {
  /** Our article id. Stored invisibly in the post so a retry can recognise a post it already created. */
  articleId: string;
  title: string;
  slug: string;
  contentHtml: string;
  excerpt: string;
  categoryNames: string[];
  tags: string[];
  featuredMediaId?: string;
  /** WordPress user to show as the post's author (needs an Editor or Administrator connection to set someone else). */
  authorWpId?: number;
  status: 'draft' | 'publish';
  seo?: { title?: string; description?: string; focusKeyword?: string };
};

export type PostResult = {
  cmsPostId: string;
  url: string;
  status: string;
  /** What happened with optional extras (for example SEO plugin fields), recorded for the audit trail. */
  notes: Record<string, unknown>;
};

/**
 * The publishing surface the rest of the app depends on. Scheduling lives in our own worker, so adapters
 * only need to create, find, update and confirm posts.
 */
export interface CmsAdapter {
  readonly name: string;
  /** True for the local stand-in. A mock post is never a real publication. */
  readonly isMock: boolean;
  testConnection(): Promise<ConnectionStatus>;
  uploadMedia(input: MediaInput): Promise<MediaResult>;
  /** Looks for a post this system already created for the article (after a crash between "created" and "saved"). */
  findExisting(articleId: string, slug: string): Promise<PostResult | null>;
  createPost(input: PostInput): Promise<PostResult>;
  getPost(cmsPostId: string): Promise<PostResult | null>;
  /** Moves a published post back to draft. */
  unpublish(cmsPostId: string): Promise<void>;
}

export class CmsError extends Error {
  constructor(
    message: string,
    readonly code: 'not_configured' | 'auth_failed' | 'unavailable' | 'rejected' | 'unverified' | 'category_missing',
    readonly transient: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CmsError';
  }
}
