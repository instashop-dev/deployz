import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

// The same build answers on two hostnames, so relative metadata URLs would
// resolve differently depending on which one the reader arrived at. Pinning
// metadataBase to the marketing origin makes every canonical and Open Graph
// URL point at deployz.dev regardless — the app host is marked noindex in
// middleware.ts, so marketing is the only version that should be indexed.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Deployz',
  description: 'Deploy your app into your customers’ cloud accounts.',
  alternates: { canonical: './' },
  openGraph: {
    title: 'Deployz',
    description: 'Deploy your app into your customers’ cloud accounts.',
    url: './',
    siteName: 'Deployz',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
