
"use client";

import type React from 'react';
import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { fileToDataURL } from '@/lib/utils';

import { AppHeader } from '@/components/astrostacker/AppHeader';
import { ImageUploadArea } from '@/components/astrostacker/ImageUploadArea';
import { ImageQueueItem } from '@/components/astrostacker/ImageQueueItem';
import { ImagePreview } from '@/components/astrostacker/ImagePreview';
import { DownloadButton } from '@/components/astrostacker/DownloadButton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Layers, Wand2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';


interface UploadedFile {
  file: File;
  previewUrl: string;
}

export default function AstroStackerPage() {
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [stackedImage, setStackedImage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const { toast } = useToast();

  const handleFilesAdded = async (files: File[]) => {
    setIsProcessing(true);
    const newUploadedFiles: UploadedFile[] = [];
    for (const file of files) {
      try {
        const previewUrl = await fileToDataURL(file);
        newUploadedFiles.push({ file, previewUrl });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        toast({
          title: "Error reading file",
          description: `Could not read ${file.name}: ${errorMessage}`,
          variant: "destructive",
        });
      }
    }
    setUploadedFiles(prev => [...prev, ...newUploadedFiles]);
    setIsProcessing(false);
  };

  const handleRemoveImage = (indexToRemove: number) => {
    setUploadedFiles(prev => prev.filter((_, index) => index !== indexToRemove));
  };

  const loadImage = (file: File): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (!event.target?.result) {
          reject(new Error(`FileReader failed to produce a result for ${file.name}.`));
          return;
        }
        const img = new Image();
        img.onload = () => {
          if (img.naturalWidth === 0 || img.naturalHeight === 0) {
            reject(new Error(`Image ${file.name} loaded with zero dimensions (0x0).`));
          } else {
            resolve(img);
          }
        };
        img.onerror = (e) => {
          const errorMsg = typeof e === 'string' ? e : (e as Event)?.type || 'unknown image load error';
          reject(new Error(`Failed to load image ${file.name}: ${errorMsg}`));
        };
        img.src = event.target.result as string;
      };
      reader.onerror = () => {
        reject(new Error(`FileReader failed to read ${file.name}. Error: ${reader.error?.name || 'unknown error'}`));
      };
      reader.readAsDataURL(file);
    });
  };

  const calculateImageCentroid = (image: HTMLImageElement, drawWidth: number, drawHeight: number): { x: number; y: number } => {
    const canvas = document.createElement('canvas');
    canvas.width = drawWidth;
    canvas.height = drawHeight;
    // Add willReadFrequently hint for potential performance improvement with getImageData
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); 
    
    if (!ctx) {
      console.warn(`Failed to get 2D context for centroid calculation (image: ${image.src.substring(0,50)}...). Falling back to geometric center.`);
      return { x: drawWidth / 2, y: drawHeight / 2 }; // Fallback
    }

    try {
      ctx.drawImage(image, 0, 0, drawWidth, drawHeight); 
      const imageData = ctx.getImageData(0, 0, drawWidth, drawHeight);
      const data = imageData.data;
      
      let totalBrightness = 0;
      let weightedX = 0;
      let weightedY = 0;
      
      for (let y = 0; y < drawHeight; y++) {
        for (let x = 0; x < drawWidth; x++) {
          const i = (y * drawWidth + x) * 4;
          const r = data[i];
          const g = data[i+1];
          const b = data[i+2];
          const brightness = 0.299 * r + 0.587 * g + 0.114 * b; 
          
          if (brightness > 60) { 
            weightedX += x * brightness;
            weightedY += y * brightness;
            totalBrightness += brightness;
          }
        }
      }
      
      if (totalBrightness === 0) {
        // If image is all black or all pixels below threshold, return geometric center
        return { x: drawWidth / 2, y: drawHeight / 2 };
      }
      
      return {
        x: weightedX / totalBrightness,
        y: weightedY / totalBrightness,
      };
    } catch (error) {
        console.warn(`Error during canvas operations in calculateImageCentroid for image (${image.src.substring(0,50)}...). Falling back.`, error);
        return { x: drawWidth / 2, y: drawHeight / 2 }; // Fallback if any canvas operation fails
    }
  };

  const handleStackImages = async () => {
    if (uploadedFiles.length === 0) {
      toast({ title: "No images", description: "Please upload images to stack." });
      return;
    }
    setIsProcessing(true);
    setStackedImage(null);

    try {
      const images = await Promise.all(uploadedFiles.map(f => loadImage(f.file)));

      if (images.length === 0) {
        toast({ title: "No images loaded", description: "Could not load any images for stacking.", variant: "destructive" });
        setIsProcessing(false);
        return;
      }

      // Ensure the first image, used for reference dimensions, is valid and has dimensions.
      // loadImage now also checks for naturalWidth/Height > 0.
      if (!images[0] || images[0].width === 0 || images[0].height === 0) {
        toast({
          title: "Invalid Reference Image",
          description: `The first image (${uploadedFiles[0].file.name}) is invalid or has zero dimensions. Cannot proceed with stacking.`,
          variant: "destructive",
        });
        setIsProcessing(false);
        return;
      }
      
      const targetWidth = images[0].width;
      const targetHeight = images[0].height;

      const centroids = images.map(img => calculateImageCentroid(img, targetWidth, targetHeight));
      const referenceCentroid = centroids[0]; 
      
      const offscreenCanvas = document.createElement('canvas');
      offscreenCanvas.width = targetWidth;
      offscreenCanvas.height = targetHeight;
      const ctx = offscreenCanvas.getContext('2d');

      if (!ctx) {
        throw new Error('Could not get canvas context for stacking');
      }

      const summedPixelData = new Float32Array(targetWidth * targetHeight * 4);

      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const currentCentroid = centroids[i];
        
        const dx = referenceCentroid.x - currentCentroid.x;
        const dy = referenceCentroid.y - currentCentroid.y;
        
        ctx.clearRect(0, 0, targetWidth, targetHeight); 
        ctx.drawImage(img, dx, dy, targetWidth, targetHeight); 
        
        const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
        for (let j = 0; j < imageData.data.length; j++) {
          summedPixelData[j] += imageData.data[j];
        }
      }

      const averagedImageData = ctx.createImageData(targetWidth, targetHeight);
      for (let i = 0; i < summedPixelData.length; i++) {
        averagedImageData.data[i] = summedPixelData[i] / images.length;
      }

      ctx.putImageData(averagedImageData, 0, 0);
      const resultDataUrl = offscreenCanvas.toDataURL('image/png');
      
      setStackedImage(resultDataUrl);
      toast({ 
        title: "Alignment & Stacking Complete", 
        description: "Images aligned by centroid and stacked successfully using pixel averaging." 
      });

    } catch (error) {
      console.error("Alignment/Stacking error:", error);
      toast({
        title: "Alignment/Stacking Failed",
        description: `An error occurred: ${error instanceof Error ? error.message : String(error)}`,
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };
  
  useEffect(() => {
    return () => {
      // No explicit cleanup needed for data URIs from fileToDataURL
    };
  }, [uploadedFiles]);

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <AppHeader />
      <main className="flex-grow container mx-auto py-6 px-2 sm:px-4 md:px-6">
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Left Panel */}
          <div className="w-full lg:w-2/5 xl:w-1/3 space-y-6">
            <Card className="shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center text-xl font-headline">
                  <Layers className="mr-2 h-5 w-5 text-accent" />
                  Upload & Manage Images
                </CardTitle>
                <CardDescription>Add your astrophotography captures. Images will be aligned by centroid then stacked.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <ImageUploadArea onFilesAdded={handleFilesAdded} isProcessing={isProcessing} />
                {uploadedFiles.length > 0 && (
                  <>
                    <h3 className="text-lg font-semibold mt-4 text-foreground">Image Queue ({uploadedFiles.length})</h3>
                    <ScrollArea className="h-64 border rounded-md p-2 bg-background/30">
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {uploadedFiles.map((uploadedFile, index) => (
                          <ImageQueueItem
                            key={index}
                            file={uploadedFile.file}
                            previewUrl={uploadedFile.previewUrl}
                            onRemove={() => handleRemoveImage(index)}
                            isProcessing={isProcessing}
                          />
                        ))}
                      </div>
                    </ScrollArea>
                    <Button
                      onClick={handleStackImages}
                      disabled={isProcessing || uploadedFiles.length === 0}
                      className="w-full bg-accent hover:bg-accent/90 text-accent-foreground"
                    >
                      <Wand2 className="mr-2 h-5 w-5" />
                      {isProcessing ? 'Processing...' : 'Align & Stack Images'}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Right Panel */}
          <div className="w-full lg:w-3/5 xl:w-2/3 flex flex-col space-y-6">
            <ImagePreview imageUrl={stackedImage} isLoading={isProcessing && !stackedImage} />
            <DownloadButton imageUrl={stackedImage} isProcessing={isProcessing} />
          </div>
        </div>
      </main>
      <footer className="py-4 text-center text-sm text-muted-foreground border-t border-border">
        AstroStacker &copy; {new Date().getFullYear()}
      </footer>
    </div>
  );
}
