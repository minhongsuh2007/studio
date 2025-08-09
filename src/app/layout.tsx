
import type {Metadata} from 'next';
import './globals.css';
import { LanguageProvider } from '@/contexts/LanguageContext'; // Added import
import Script from 'next/script';


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
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <Script id="imagemagick-setup">
          {`
            var Module = {
              locateFile: function(path, prefix) {
                return '/' + path;
              },
              onRuntimeInitialized: function() {
                window.ImageMagick = Module;
                // Dispatch a custom event to notify that the WASM module is ready
                document.dispatchEvent(new CustomEvent('wasmReady'));
              }
            };
          `}
        </Script>
        <Script src="/imagemagick.js" strategy="lazyOnload" />
      </head>
      <body className="font-body antialiased">
        <LanguageProvider>
          {children}
        </LanguageProvider>
      </body>
    </html>
  );
}
