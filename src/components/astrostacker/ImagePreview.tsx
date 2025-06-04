
"use client";

import NextImage from 'next/image';
import { ImageOff, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useState, useEffect } from 'react';

interface ImagePreviewProps {
  imageUrl: string | null;
  isLoading: boolean;
  fitMode: 'contain' | 'cover';
}

export function ImagePreview({ imageUrl, isLoading, fitMode }: ImagePreviewProps) {
  const [hasLoadError, setHasLoadError] = useState(false);

  useEffect(() => {
    setHasLoadError(false);
  }, [imageUrl, isLoading, fitMode]);

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
    contentToRender = (
      <div className="relative w-full h-full">
        <NextImage
          key={imageUrl + '-' + fitMode} 
          src={imageUrl}
          alt="Stacked astrophotography image"
          fill
          style={{ objectFit: fitMode }}
          className="rounded-md"
          data-ai-hint="galaxy nebula"
          onError={handleImageError}
        />
      </div>
    );
  } else {
    let titleMessage = "Your stacked image will appear here";
    let detailMessage = "Upload images and click 'Align & Stack Images' to begin.";

    if (hasLoadError) {
      titleMessage = "Image Preview Error";
      detailMessage = "Could not load the preview. The image data might be invalid, corrupt, or too large for the browser to display.";
    } else if (imageUrl === null && !isLoading) {
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
      <CardContent className="w-full h-full flex items-center justify-center p-2">
        {contentToRender}
      </CardContent>
    </Card>
  );
}

    
