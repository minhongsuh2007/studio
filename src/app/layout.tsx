
import type {Metadata} from 'next';
import './globals.css';
import { LanguageProvider } from '@/contexts/LanguageContext'; // Added import


export const metadata: Metadata = {
  title: 'AstroStacker',
  description: 'Stack astrophotography images to reduce noise and enhance details. Features basic star alignment.',
  openGraph: {
    title: 'AstroStacker',
    description: 'Stack and enhance your astrophotography images.',
    images: [
      {
        url: 'https://storage.googleapis.com/astrostacker-public-assets/astrostacker-og-image.jpg',
        width: 1200,
        height: 630,
        alt: 'A beautiful image of a galaxy.',
      },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body className="font-body antialiased">
        <LanguageProvider>
          {children}
        </LanguageProvider>
      </body>
    </html>
  );
}
