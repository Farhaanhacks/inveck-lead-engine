import sharp from 'sharp';
import type { ImageProvider, UsageReport } from '../providers/types';
import { PipelineError } from './stages';

export interface ImageStorage {
  /** Stores bytes under a key and returns the public URL. Must only resolve once the object is actually stored. */
  put(key: string, bytes: Buffer, contentType: string): Promise<{ url: string }>;
}

export const IMAGE_WIDTH = 1600;
export const IMAGE_HEIGHT = 900;
export const MAX_IMAGE_BYTES = 400 * 1024;

export function buildImagePrompt(scene: string, headline: string, styleNote = ''): string {
  const extra = styleNote.trim() ? `\nAdditional style direction: ${styleNote.trim()}` : '';
  return `Editorial featured image for an article titled "${headline}".
Scene: ${scene}
Style: clean, professional editorial photograph or refined illustration, natural lighting, balanced composition, wide landscape framing.
Hard rules: no text, letters, numbers, captions, watermarks or logos anywhere in the image. Do not depict real, recognisable people or real events; use generic, anonymous figures or objects. No brand marks. Nothing sensational or misleading.${extra}`;
}

/** Resizes to 16:9, converts to WebP and trims quality until the file is small enough for the web. */
export async function optimizeImage(input: Buffer): Promise<{ bytes: Buffer; width: number; height: number; mimeType: 'image/webp' }> {
  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new PipelineError('The image provider returned data that is not a readable image', 'invalid_image', true);
  }
  if (!meta.width || !meta.height || meta.width < 400 || meta.height < 225) throw new PipelineError(`The generated image is too small (${meta.width}x${meta.height})`, 'invalid_image', true);
  let quality = 82;
  let bytes = await sharp(input).resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: 'cover', position: 'attention' }).webp({ quality }).toBuffer();
  while (bytes.length > MAX_IMAGE_BYTES && quality > 40) {
    quality -= 12;
    bytes = await sharp(input).resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: 'cover', position: 'attention' }).webp({ quality }).toBuffer();
  }
  return { bytes, width: IMAGE_WIDTH, height: IMAGE_HEIGHT, mimeType: 'image/webp' };
}

export type GeneratedImage = { url: string; storageKey: string; width: number; height: number; mimeType: string; bytes: number; usage: UsageReport };

/** Generates, optimises and stores the featured image. Throws a PipelineError/ProviderError on any failure so the caller can record it. */
export async function createFeaturedImage(args: { provider: ImageProvider; storage: ImageStorage; model: string; scene: string; headline: string; articleId: string; styleNote?: string }): Promise<GeneratedImage> {
  const raw = await args.provider.generateImage({ model: args.model, prompt: buildImagePrompt(args.scene, args.headline, args.styleNote), aspectRatio: '16:9' });
  const opt = await optimizeImage(raw.bytes);
  const storageKey = `articles/${args.articleId}/featured.webp`;
  const stored = await args.storage.put(storageKey, opt.bytes, opt.mimeType);
  return { url: stored.url, storageKey, width: opt.width, height: opt.height, mimeType: opt.mimeType, bytes: opt.bytes.length, usage: raw.usage };
}
