
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
        toast({
          title: "Error reading file",
          description: `Could not read ${file.name}.`,
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
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        if (event.target?.result) {
          img.src = event.target.result as string;
        } else {
          reject(new Error('Failed to read file for image loading.'));
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
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

      // Determine dimensions from the first image
      const targetWidth = images[0].width;
      const targetHeight = images[0].height;

      const offscreenCanvas = document.createElement('canvas');
      offscreenCanvas.width = targetWidth;
      offscreenCanvas.height = targetHeight;
      const ctx = offscreenCanvas.getContext('2d');

      if (!ctx) {
        throw new Error('Could not get canvas context');
      }

      // Initialize summed pixel data array (R, G, B, A)
      const summedPixelData = new Float32Array(targetWidth * targetHeight * 4);

      for (const img of images) {
        // Draw (and resize if necessary) image to offscreen canvas
        ctx.clearRect(0, 0, targetWidth, targetHeight); // Clear for each image
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
        const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
        for (let i = 0; i < imageData.data.length; i++) {
          summedPixelData[i] += imageData.data[i];
        }
      }

      // Average the pixel data
      const averagedImageData = ctx.createImageData(targetWidth, targetHeight);
      for (let i = 0; i < summedPixelData.length; i++) {
        averagedImageData.data[i] = summedPixelData[i] / images.length;
      }

      // Put averaged data onto the canvas and get data URL
      ctx.putImageData(averagedImageData, 0, 0);
      const resultDataUrl = offscreenCanvas.toDataURL('image/png');
      
      setStackedImage(resultDataUrl);
      toast({ title: "Stacking Complete", description: "Images stacked successfully using pixel averaging." });

    } catch (error) {
      console.error("Stacking error:", error);
      toast({
        title: "Stacking Failed",
        description: `An error occurred during client-side stacking: ${error instanceof Error ? error.message : String(error)}`,
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };
  
  // Clean up preview URLs when component unmounts or files change
  useEffect(() => {
    return () => {
      uploadedFiles.forEach(uploadedFile => {
        // Preview URLS are Data URIs from fileToDataURL, not object URLs, so no need to revoke.
      });
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
                <CardDescription>Add your astrophotography captures to begin stacking.</CardDescription>
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
                      {isProcessing ? 'Stacking...' : 'Stack Images (Pixel Average)'}
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
