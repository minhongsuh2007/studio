
"use client";

import NextImage from 'next/image';
import { ImageOff, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useState, useEffect } from 'react';

interface ImagePreviewProps {
  imageUrl: string | null;
  isLoading: boolean;
}

export function ImagePreview({ imageUrl, isLoading }: ImagePreviewProps) {
  const [hasLoadError, setHasLoadError] = useState(false);

  useEffect(() => {
    // Reset error state if imageUrl changes (even to null) or if loading starts
    setHasLoadError(false);
  }, [imageUrl, isLoading]);

  const handleImageError = () => {
    console.warn("ImagePreview: NextImage onError triggered, indicating an issue loading the image source.");
    setHasLoadError(true);
  };

  let contentToRender;

  if (isLoading) {
    contentToRender = (
      <div className="flex flex-col items-center space-y-2 text-muted-foreground">
        <Loader2 className="h-12 w-12 animate-spin text-accent" />
        <p>Processing image...</p>
      </div>
    );
  } else if (imageUrl && !hasLoadError) {
    // Attempt to render the image if URL is present and no error has occurred yet
    contentToRender = (
      <div className="relative w-full h-full"> {/* This div provides the bounds for layout="fill" */}
        <NextImage
          key={imageUrl} // Force re-mount if imageUrl string identity changes
          src={imageUrl}
          alt="Stacked astrophotography image"
          layout="fill"
          objectFit="contain"
          className="rounded-md"
          data-ai-hint="galaxy nebula"
          onError={handleImageError} // If NextImage fails, set hasLoadError
        />
      </div>
    );
  } else {
    // This branch covers:
    // 1. Not loading, and no imageUrl (initial state or processing failed to produce a URL)
    // 2. Not loading, imageUrl exists, but hasLoadError is true (NextImage failed)
    let titleMessage = "Your stacked image will appear here";
    let detailMessage = "Upload images and click 'Stack Images' to begin.";

    if (hasLoadError) {
      titleMessage = "Image Preview Error";
      detailMessage = "Could not load the preview. The image data might be invalid, corrupt, or too large for the browser to display.";
    } else if (imageUrl === null && !isLoading) {
      // Specifically for when processing finished but returned null (explicitly no image)
      titleMessage = "No Preview Available";
      detailMessage = "Image processing finished, but no valid preview could be generated. The resulting image might be empty or an error occurred during its creation.";
    }

    contentToRender = (
      <div className="flex flex-col items-center space-y-2 text-muted-foreground text-center p-4">
        <ImageOff className="h-16 w-16" />
        <p className="text-lg font-medium">{titleMessage}</p>
        <p className="text-sm">{detailMessage}</p>
      </div>
    );
  }

  return (
    <Card className="flex-grow flex items-center justify-center shadow-lg min-h-[300px] md:min-h-[400px] lg:min-h-[500px] bg-card">
      <CardContent className="w-full h-full flex items-center justify-center p-2"> {/* Ensure CardContent allows full space */}
        {contentToRender}
      </CardContent>
    </Card>
  );
}
