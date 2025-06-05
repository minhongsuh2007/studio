
"use client";

import { ImageOff } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useState, useEffect } from 'react';

interface ImagePreviewProps {
  imageUrl: string | null;
  fitMode: 'contain' | 'cover';
}

export function ImagePreview({ imageUrl, fitMode }: ImagePreviewProps) {
  const [displayError, setDisplayError] = useState(false);

  useEffect(() => {
    // Reset error state when imageUrl changes, or when fitMode changes (to retry loading if necessary)
    setDisplayError(false);
  }, [imageUrl, fitMode]);

  const handleImageError = () => {
    console.warn("ImagePreview: <img> onError triggered. The image source might be invalid, corrupt, or the data URI is too large for the browser to handle for an <img> tag.");
    setDisplayError(true);
  };

  let contentToRender;

  if (imageUrl && !displayError) {
    contentToRender = (
      <div className="relative w-full h-full">
        <img
          key={imageUrl + '-' + fitMode} // Add key to help React re-render if src or fitMode changes
          src={imageUrl} // This is expected to be a data URI string (e.g., "data:image/jpeg;base64,...")
          alt="Stacked astrophotography image"
          style={{
            width: '100%',
            height: '100%',
            objectFit: fitMode,
            borderRadius: '0.375rem', // Tailwind's rounded-md, applied via style for <img>
          }}
          onError={handleImageError}
          data-ai-hint="galaxy nebula"
        />
      </div>
    );
  } else {
    let titleMessage = "Your stacked image will appear here";
    let detailMessage = "Upload images and click 'Align & Stack Images' to begin.";

    if (displayError) {
        titleMessage = "Image Preview Error";
        detailMessage = "Could not load the preview. The image data might be invalid, corrupt, or too large for the browser to display.";
    } else if (imageUrl === null) { 
      // This case covers when stacking hasn't happened or finished without a result.
      // The default messages are appropriate here.
    }

    contentToRender = (
      <div className="flex flex-col items-center justify-center h-full space-y-2 text-muted-foreground text-center p-4">
        <ImageOff className="h-16 w-16" />
        <p className="text-lg font-medium">{titleMessage}</p>
        <p className="text-sm">{detailMessage}</p>
      </div>
    );
  }

  return (
    <Card className="flex-grow flex items-center justify-center shadow-lg min-h-[300px] md:min-h-[400px] lg:min-h-[500px] bg-card">
      <CardContent className="w-full h-full flex items-center justify-center p-2">
        {contentToRender}
      </CardContent>
    </Card>
  );
}
