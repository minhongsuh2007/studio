
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
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    // Reset error state when imageUrl changes (to null or a new URL)
    setImageError(false);
  }, [imageUrl]);

  useEffect(() => {
    // If loading starts, reset any previous error state
    if (isLoading) {
      setImageError(false);
    }
  }, [isLoading]);

  return (
    <Card className="flex-grow flex items-center justify-center shadow-lg min-h-[300px] md:min-h-[400px] bg-background/50">
      <CardContent className="p-2 w-full h-full flex items-center justify-center">
        {isLoading && (
          <div className="flex flex-col items-center space-y-2 text-muted-foreground">
            <Loader2 className="h-12 w-12 animate-spin text-accent" />
            <p>Processing image...</p>
          </div>
        )}
        {!isLoading && imageUrl && !imageError && (
          <div className="relative w-full h-full max-w-full max-h-[calc(100vh-200px)]">
             <NextImage
                key={imageUrl} // Force re-mount if imageUrl string changes
                src={imageUrl}
                alt="Stacked astrophotography image"
                layout="fill"
                objectFit="contain"
                className="rounded-md"
                data-ai-hint="galaxy nebula"
                onError={() => {
                  console.warn("ImagePreview: NextImage onError triggered for image preview.");
                  setImageError(true);
                }}
              />
          </div>
        )}
        {!isLoading && (!imageUrl || imageError) && (
          <div className="flex flex-col items-center space-y-2 text-muted-foreground">
            <ImageOff className="h-16 w-16" />
            <p className="text-lg">Your stacked image will appear here</p>
            <p className="text-sm">
              {imageError 
                ? "Could not load the preview. The image might be invalid, too large, or processing resulted in an empty/corrupt image." 
                : "Upload images and click 'Stack Images' to begin."}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

    