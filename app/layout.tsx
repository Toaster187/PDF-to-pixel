import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'PDF / PIXEL — verlustfreier PDF-zu-PNG-Export',
  description:
    'Lokale PDF-zu-PNG-Konvertierung mit automatischem Schutz eingebetteter Bilddetails.',
  openGraph: {
    type: 'website',
    locale: 'de_DE',
    title: 'PDF / PIXEL — verlustfreier PDF-zu-PNG-Export',
    description: 'Jedes Detail bekommt die Pixel, die es braucht. Vollständig lokal im Browser.',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'PDF / PIXEL – Jedes Detail bekommt die Pixel, die es braucht.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PDF / PIXEL — verlustfreier PDF-zu-PNG-Export',
    description: 'Jedes Detail bekommt die Pixel, die es braucht. Vollständig lokal im Browser.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
