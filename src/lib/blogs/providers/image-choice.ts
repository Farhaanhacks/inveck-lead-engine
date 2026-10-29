import { PollinationsImageProvider } from './pollinations';
import type { ImageProvider } from './types';
import { WaveSpeedImageProvider } from './wavespeed';

export const DEFAULT_WAVESPEED_MODEL = 'google/nano-banana/text-to-image';
export const DEFAULT_POLLINATIONS_MODEL = 'tongyi-mai/z-image-turbo';

type ImageEnv = { WAVESPEED_API_KEY?: string; WAVESPEED_IMAGE_MODEL?: string; POLLINATIONS_API_KEY?: string; POLLINATIONS_IMAGE_MODEL?: string };

/** Which service draws featured images: WaveSpeed when its key is set, then Pollinations, otherwise null (Gemini's image model). */
export function chooseImageService(e: ImageEnv): { name: 'wavespeed' | 'pollinations'; model: string; provider: () => ImageProvider } | null {
  if (e.WAVESPEED_API_KEY) return { name: 'wavespeed', model: e.WAVESPEED_IMAGE_MODEL || DEFAULT_WAVESPEED_MODEL, provider: () => new WaveSpeedImageProvider(e.WAVESPEED_API_KEY!) };
  if (e.POLLINATIONS_API_KEY) return { name: 'pollinations', model: e.POLLINATIONS_IMAGE_MODEL || DEFAULT_POLLINATIONS_MODEL, provider: () => new PollinationsImageProvider(e.POLLINATIONS_API_KEY!) };
  return null;
}
