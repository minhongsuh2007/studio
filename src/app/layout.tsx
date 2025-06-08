
import type {Metadata} from 'next';
import './globals.css';
import { Toaster } from "@/components/ui/toaster";
import { LanguageProvider } from '@/contexts/LanguageContext'; // Added import

export const metadata: Metadata = {
  title: 'AstroStacker',
  description: 'Stack astrophotography images to reduce noise and enhance details. Features basic star alignment.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // LanguageProvider wraps html to set lang attribute, but practically,
    // it's better to wrap the body content for client-side state.
    // For initial lang on <html>, it might be better handled via next-i18n routing.
    // For this basic setup, LanguageProvider is inside <body> for client components.
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body className="font-body antialiased">
        <LanguageProvider> {/* Added LanguageProvider */}
          {children}
          <Toaster />
        </LanguageProvider>
      </body>
    </html>
  );
}
