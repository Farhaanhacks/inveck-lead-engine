import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'INVECK Lead Engine',
  description: 'Finds, researches and qualifies prospects for INVECK India, and drafts outreach for approval.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
