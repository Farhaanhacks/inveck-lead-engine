import Image from 'next/image';
import instagram from '../../assets/instagram.webp';
import linkedin from '../../assets/linkedin.webp';
import type { ContentPlatform } from '@/lib/content-meta';

const LOGO = { instagram, linkedin } as const;
const NAME = { instagram: 'Instagram', linkedin: 'LinkedIn' } as const;

/** The platform's logo (assets/instagram.webp, assets/linkedin.webp), a square mark at the size given. */
export function PlatformLogo({ platform, size = 16, className = '' }: { platform: ContentPlatform; size?: number; className?: string }) {
  return <Image src={LOGO[platform]} alt={NAME[platform]} width={size} height={size} className={`inline-block shrink-0 rounded-[22%] ${className}`} />;
}
