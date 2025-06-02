
"use client";

import type React from 'react';
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { fileToDataURL } from '@/lib/utils';

import { AppHeader } from '@/components/astrostacker/AppHeader';
import { ImageUploadArea } from '@/components/astrostacker/ImageUploadArea';
import { ImageQueueItem } from '@/components/astrostacker/ImageQueueItem';
import { ImagePreview } from '@/components/astrostacker/ImagePreview';
import { DownloadButton } from '@/components/astrostacker/DownloadButton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Star as StarIcon, Wand2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';


interface UploadedFile {
  file: File;
  previewUrl: string;
}

interface Star {
  x: number;
  y: number;
  brightness: number;
}

// Helper function to detect star-like features in image data
function detectStars(imageData: ImageData, brightnessThreshold: number = 180, localContrastFactor: number = 1.3): Star[] {
  const stars: Star[] = [];
  const { data, width, height } = imageData;

  for (let y = 1; y < height - 1; y++) { // Avoid edges for neighbor checks
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // Alpha is data[i+3]
      const currentPixelBrightness = r + g + b; // Simple sum

      // Threshold for a single pixel to be considered part of a potential star
      if (r > brightnessThreshold && g > brightnessThreshold && b > brightnessThreshold) {
        let neighborSumBrightness = 0;
        let neighborCount = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const ni = ((y + dy) * width + (x + dx)) * 4;
            neighborSumBrightness += data[ni] + data[ni + 1] + data[ni + 2];
            neighborCount++;
          }
        }
        const avgNeighborBrightness = neighborSumBrightness / neighborCount;

        if (currentPixelBrightness > avgNeighborBrightness * localContrastFactor) {
          stars.push({ x, y, brightness: currentPixelBrightness });
        }
      }
    }
  }
  // Basic filtering: if too many "stars" are detected (e.g. > 1000), it might be noise or a very dense starfield
  // A large number of stars from this simple detection might make the centroid less stable.
  if (stars.length > 1000) { 
    console.warn(`Detected a large number of stars (${stars.length}), centroid might be less precise or computation slow. Consider filtering further or using a subset.`);
    // Optional: sort by brightness and take top N
    // stars.sort((a, b) => b.brightness - a.brightness);
    // return stars.slice(0, 500); // Example: take top 500
  }
  return stars;
}

// Helper function to calculate the centroid of an array of detected stars
function calculateStarArrayCentroid(stars: Star[]): { x: number; y: number } | null {
  if (stars.length < 3) { // Require at least a few stars for a meaningful centroid
     console.warn(`Not enough stars (${stars.length}) detected for star-based centroid. Need at least 3.`);
     return null;
  }

  let totalBrightness = 0;
  let weightedX = 0;
  let weightedY = 0;

  for (const star of stars) {
    weightedX += star.x * star.brightness;
    weightedY += star.y * star.brightness;
    totalBrightness += star.brightness;
  }

  if (totalBrightness === 0) { // Should not happen if stars have brightness > 0
    return stars.length > 0 ? { x: stars[0].x, y: stars[0].y } : null;
  }

  return {
    x: weightedX / totalBrightness,
    y: weightedY / totalBrightness,
  };
}


// Calculates brightness-weighted centroid from ImageData (fallback method)
// Operates on the provided ImageData dimensions.
function calculateBrightnessCentroid(imageData: ImageData, brightnessThreshold: number = 60): { x: number; y: number } | null {
    const { data, width, height } = imageData;
    let totalBrightness = 0;
    let weightedX = 0;
    let weightedY = 0;
    let brightPixels = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const brightness = 0.299 * r + 0.587 * g + 0.114 * b; // Luminance

        if (brightness > brightnessThreshold) {
          weightedX += x * brightness;
          weightedY += y * brightness;
          totalBrightness += brightness;
          brightPixels++;
        }
      }
    }

    if (totalBrightness === 0 || brightPixels === 0) {
      console.warn("No bright pixels found for brightness centroid calculation. Falling back to geometric center of this image data.");
      return { x: width / 2, y: height / 2 }; // Fallback to geometric center of the current image data
    }

    return {
      x: weightedX / totalBrightness,
      y: weightedY / totalBrightness,
    };
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
            reject(new Error(`Image ${file.name} loaded with zero dimensions (0x0). Its data cannot be processed.`));
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

  const handleStackImages = async () => {
    if (uploadedFiles.length === 0) {
      toast({ title: "No images", description: "Please upload images to stack." });
      return;
    }
    setIsProcessing(true);
    setStackedImage(null);
    console.log("Starting image stacking process...");

    try {
      let imageElements: HTMLImageElement[] = [];
      for (const f of uploadedFiles) {
        try {
          const imgEl = await loadImage(f.file);
          imageElements.push(imgEl);
        } catch (loadError) {
           const errorMessage = loadError instanceof Error ? loadError.message : String(loadError);
           toast({
            title: `Error Loading ${f.file.name}`,
            description: errorMessage,
            variant: "destructive",
           });
        }
      }

      if (imageElements.length === 0) {
        toast({ title: "No images loaded", description: "Could not load any images for stacking.", variant: "destructive" });
        setIsProcessing(false); // Ensure processing is set to false here too
        return;
      }

      const firstImage = imageElements[0];
      if (!firstImage || firstImage.naturalWidth === 0 || firstImage.naturalHeight === 0) {
        toast({
          title: "Invalid Reference Image",
          description: `The first image (${uploadedFiles[0].file.name}) is invalid (0x0 dimensions). Cannot proceed.`,
          variant: "destructive",
        });
        setIsProcessing(false); // Ensure processing is set to false here too
        return;
      }
      
      const targetWidth = firstImage.naturalWidth;
      const targetHeight = firstImage.naturalHeight;

      const offscreenCanvas = document.createElement('canvas');
      offscreenCanvas.width = targetWidth;
      offscreenCanvas.height = targetHeight;
      const ctx = offscreenCanvas.getContext('2d', { willReadFrequently: true });

      const tempAnalysisCanvas = document.createElement('canvas');
      const tempAnalysisCtx = tempAnalysisCanvas.getContext('2d', { willReadFrequently: true });

      if (!ctx || !tempAnalysisCtx) {
        throw new Error('Could not get canvas contexts for stacking');
      }
      
      const centroids: ({ x: number; y: number } | null)[] = [];
      let successfulStarAlignments = 0;

      for (let i = 0; i < imageElements.length; i++) {
        const imgEl = imageElements[i];
        let finalScaledCentroid: { x: number; y: number } | null = null;
        let method = "unknown";

        if (!imgEl || imgEl.naturalWidth === 0 || imgEl.naturalHeight === 0) {
            console.warn(`Skipping analysis for invalid image element at index ${i}: ${uploadedFiles[i]?.file.name}`);
            finalScaledCentroid = { x: targetWidth / 2, y: targetHeight / 2 }; 
            method = "invalid_element_fallback";
            centroids.push(finalScaledCentroid);
            console.log(`Image ${i} (${uploadedFiles[i]?.file.name || `image ${i}`}) centroid method: ${method}, Scaled to Target Coords:`, finalScaledCentroid);
            continue; 
        }
        
        try {
          tempAnalysisCanvas.width = imgEl.naturalWidth;
          tempAnalysisCanvas.height = imgEl.naturalHeight;
          tempAnalysisCtx.clearRect(0, 0, imgEl.naturalWidth, imgEl.naturalHeight);
          tempAnalysisCtx.drawImage(imgEl, 0, 0, imgEl.naturalWidth, imgEl.naturalHeight);
          const nativeImageData = tempAnalysisCtx.getImageData(0, 0, imgEl.naturalWidth, imgEl.naturalHeight);

          const stars = detectStars(nativeImageData);
          const nativeStarCentroid = calculateStarArrayCentroid(stars);
          
          if (nativeStarCentroid) {
              method = "star-based (native)";
              successfulStarAlignments++;
              finalScaledCentroid = {
                x: nativeStarCentroid.x * (targetWidth / imgEl.naturalWidth),
                y: nativeStarCentroid.y * (targetHeight / imgEl.naturalHeight),
              };
          } else {
            console.warn(`Star-based centroid detection failed for ${uploadedFiles[i]?.file.name || `image ${i}`}. Falling back to global brightness centroid on NATIVE image.`);
            method = "brightness-based (native)";
            const nativeBrightnessCentroid = calculateBrightnessCentroid(nativeImageData);
            if (nativeBrightnessCentroid) {
              finalScaledCentroid = {
                x: nativeBrightnessCentroid.x * (targetWidth / imgEl.naturalWidth),
                y: nativeBrightnessCentroid.y * (targetHeight / imgEl.naturalHeight),
              };
            }
          }
        } catch (imgAnalysisError) {
            const fileNameForError = uploadedFiles[i]?.file?.name || `image ${i}`;
            console.error(`Error analyzing image ${fileNameForError}: ${imgAnalysisError instanceof Error ? imgAnalysisError.message : String(imgAnalysisError)}`);
            method = "analysis_error";
        }
        
        if (!finalScaledCentroid) {
            const fileNameForError = uploadedFiles[i]?.file?.name || `image ${i}`;
            console.error(`Could not determine any centroid for ${fileNameForError}. It will be aligned to target geometric center.`);
            toast({
                title: "Centroid Failed",
                description: `Could not determine centroid for ${fileNameForError}. It may not align optimally.`,
                variant: "destructive"
            });
            finalScaledCentroid = { x: targetWidth / 2, y: targetHeight / 2 };
            method = method === "analysis_error" ? "analysis_error_fallback" : "geometric_center_fallback";
        }
        const fileNameForLog = uploadedFiles[i]?.file?.name || `image ${i}`;
        console.log(`Image ${i} (${fileNameForLog}) centroid method: ${method}, Scaled to Target Coords:`, finalScaledCentroid);
        centroids.push(finalScaledCentroid);
      }

      const referenceCentroid = centroids[0];
      if (!referenceCentroid) {
        toast({ title: "Alignment Failed", description: "Could not determine alignment reference for the first image. Stacking cannot proceed.", variant: "destructive" });
        setIsProcessing(false); // Ensure processing is set to false here too
        return;
      }
      
      const summedPixelData = new Float32Array(targetWidth * targetHeight * 4);

      for (let i = 0; i < imageElements.length; i++) {
        const img = imageElements[i]; 
         if (!img || img.naturalWidth === 0 || img.naturalHeight === 0) {
            console.warn(`Skipping stacking for invalid image element at index ${i}: ${uploadedFiles[i]?.file.name}`);
            continue;
        }
        const currentCentroid = centroids[i]; 
        
        let dx = 0;
        let dy = 0;
        
        if (currentCentroid) { 
          dx = referenceCentroid.x - currentCentroid.x;
          dy = referenceCentroid.y - currentCentroid.y;
        } else {
          dx = referenceCentroid.x - (img.naturalWidth / 2 * (targetWidth / img.naturalWidth)); 
          dy = referenceCentroid.y - (img.naturalHeight / 2 * (targetHeight / img.naturalHeight));
          console.warn(`Centroid missing for image ${i} despite fallbacks. Aligning its geometric center to reference centroid.`);
        }
        
        ctx.clearRect(0, 0, targetWidth, targetHeight); 
        ctx.drawImage(img, dx, dy, targetWidth, targetHeight); 
        
        try {
          const frameImageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
          for (let j = 0; j < frameImageData.data.length; j++) {
            summedPixelData[j] += frameImageData.data[j];
          }
        } catch (e) {
          console.error(`Error getting image data for frame ${i} after drawing with offset:`, e);
          toast({
            title: `Stacking Error on Frame ${i}`,
            description: `Could not process pixel data for ${uploadedFiles[i]?.file.name || `image ${i}`}. It might be excluded or corrupt the final stack.`,
            variant: "destructive"
          });
        }
      }

      const averagedImageData = ctx.createImageData(targetWidth, targetHeight);
      const numImagesToAverage = imageElements.filter(img => img && img.naturalWidth > 0 && img.naturalHeight > 0).length;
      const numValidImagesForAverage = numImagesToAverage > 0 ? numImagesToAverage : 1; 

      for (let i = 0; i < summedPixelData.length; i++) {
        averagedImageData.data[i] = summedPixelData[i] / numValidImagesForAverage;
        if (i % 4 === 3) { 
             averagedImageData.data[i] = 255; 
        }
      }
      
      ctx.putImageData(averagedImageData, 0, 0);
      const resultDataUrl = offscreenCanvas.toDataURL('image/png');
      
      setStackedImage(resultDataUrl);
      const alignmentMessage = successfulStarAlignments > 0 
        ? `${successfulStarAlignments}/${imageElements.length} images primarily aligned using star-based centroids (native resolution analysis). Others used fallbacks.`
        : `Images aligned using brightness-based centroids or geometric centers (native resolution analysis). ${imageElements.length - successfulStarAlignments} used fallback methods.`;
      toast({ 
        title: "Alignment & Stacking Complete", 
        description: `${alignmentMessage} Pixel averaging applied.`
      });

    } catch (error) {
      console.error("Unhandled error in handleStackImages:", error);
      toast({
        title: "Stacking Process Failed",
        description: `An unexpected error occurred: ${error instanceof Error ? error.message : String(error)}`,
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
      console.log("Image stacking process finished.");
    }
  };
  
  useEffect(() => {
    return () => {
      // Cleanup if any URL.createObjectURL were used (not currently the case for previews)
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
                  <StarIcon className="mr-2 h-5 w-5 text-accent" />
                  Upload & Align Images
                </CardTitle>
                <CardDescription>Add captures (JPG, PNG). Images are aligned using detected stars (native resolution analysis, fallback to brightness) then stacked.</CardDescription>
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
                      {isProcessing ? 'Processing...' : 'Align by Stars & Stack'}
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

