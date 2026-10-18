import { redirect } from 'next/navigation';
import { marketingPage } from '@/lib/access';

/** Marketing's landing page is the content calendar. */
export default async function MarketingHome() {
  await marketingPage();
  redirect('/marketing/calendar');
}
