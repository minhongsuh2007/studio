
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

const MAX_IMAGE_LOAD_DIMENSION = 16384; 
const ANALYSIS_MAX_DIMENSION = 1024; 
const MIN_VALID_DATA_URL_LENGTH = 100; 
const MAX_STARS_FOR_CENTROID_CALCULATION = 2000; // New limit for centroid calculation

// Adjusted default parameters for potentially better star detection & performance
function detectStars(imageData: ImageData, brightnessThreshold: number = 200, localContrastFactor: number = 1.5): Star[] {
  const stars: Star[] = [];
  const { data, width, height } = imageData;

  for (let y = 1; y < height - 1; y++) { 
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // Using r+g+b sum for brightness can be simple. For more perceptual brightness, luminance (0.299R + 0.587G + 0.114B) is common.
      // However, for star detection, ensuring all channels are bright (r > T && g > T && b > T) is often better to pick out white-ish stars.
      const currentPixelBrightness = r + g + b; 

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
  if (stars.length > 1000) { 
    console.warn(`Detected a large number of stars (${stars.length}) during analysis. This might slow down centroid calculation or indicate a noisy image. Consider adjusting detection parameters if results are suboptimal.`);
  }
  return stars;
}

function calculateStarArrayCentroid(starsInput: Star[]): { x: number; y: number } | null {
  let stars = starsInput;
  if (stars.length < 3) { 
     console.warn(`Not enough stars (${stars.length}) detected for star-based centroid. Need at least 3.`);
     return null;
  }

  if (stars.length > MAX_STARS_FOR_CENTROID_CALCULATION) {
    console.warn(`More than ${MAX_STARS_FOR_CENTROID_CALCULATION} stars detected (${stars.length}). Using a random sample of ${MAX_STARS_FOR_CENTROID_CALCULATION} stars for centroid calculation to improve performance.`);
    // Simple random sampling. For more deterministic results, a more sophisticated sampling might be used.
    const sampledStars: Star[] = [];
    const indices = new Set<number>();
    while (indices.size < MAX_STARS_FOR_CENTROID_CALCULATION) {
      indices.add(Math.floor(Math.random() * stars.length));
    }
    indices.forEach(index => sampledStars.push(stars[index]));
    stars = sampledStars;
  }


  let totalBrightness = 0;
  let weightedX = 0;
  let weightedY = 0;

  for (const star of stars) {
    weightedX += star.x * star.brightness;
    weightedY += star.y * star.brightness;
    totalBrightness += star.brightness;
  }

  if (totalBrightness === 0) { 
    // This case should be rare if stars have brightness > 0
    return stars.length > 0 ? { x: stars[0].x, y: stars[0].y } : null;
  }

  return {
    x: weightedX / totalBrightness,
    y: weightedY / totalBrightness,
  };
}

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
        const brightness = 0.299 * r + 0.587 * g + 0.114 * b; 

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

const getMedian = (arr: number[]): number => {
  if (!arr.length) return 0; // Should not happen if image data is valid
  const sortedArr = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sortedArr.length / 2);
  if (sortedArr.length % 2 !== 0) {
    return sortedArr[mid];
  }
  return (sortedArr[mid - 1] + sortedArr[mid]) / 2;
};


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
        if (!file.type.startsWith('image/')) {
            toast({
                title: "Unsupported File Type",
                description: `${file.name} is not a recognized image type. Please upload JPG, PNG, GIF, or WEBP.`,
                variant: "destructive",
            });
            continue;
        }
        const previewUrl = await fileToDataURL(file);
        newUploadedFiles.push({ file, previewUrl });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        toast({
          title: "Error Reading File",
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
          } else if (img.naturalWidth > MAX_IMAGE_LOAD_DIMENSION || img.naturalHeight > MAX_IMAGE_LOAD_DIMENSION) {
            reject(new Error(`Image ${file.name} dimensions (${img.naturalWidth}x${img.naturalHeight}) exceed max allowed load size of ${MAX_IMAGE_LOAD_DIMENSION}px. It cannot be processed.`));
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
    if (uploadedFiles.length < 2) {
      toast({ title: "Not Enough Images", description: "Please upload at least two images for median stacking." });
      return;
    }
    setIsProcessing(true);
    setStackedImage(null); 
    console.log("Starting image stacking process (Median)...");

    try {
      let imageElements: HTMLImageElement[] = [];
      // Load all images first
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
           // Do not proceed if any image fails to load, or filter them out and check count later
        }
      }

      // Ensure we have enough valid images to stack
      if (imageElements.length < 2) {
        toast({ title: "Not Enough Valid Images", description: "Need at least two valid images for median stacking after filtering.", variant: "destructive" });
        setIsProcessing(false); 
        return;
      }

      // Use the first valid image's dimensions as the target for stacking
      const firstImage = imageElements[0];
      if (!firstImage || firstImage.naturalWidth === 0 || firstImage.naturalHeight === 0) {
        // This check should ideally be redundant if loadImage rejects 0-dim images, but good for safety.
        toast({
          title: "Invalid Reference Image",
          description: `The first image (${uploadedFiles[0].file.name}) is invalid or empty. Cannot proceed.`,
          variant: "destructive",
        });
        setIsProcessing(false);
        return;
      }
      
      const targetWidth = firstImage.naturalWidth;
      const targetHeight = firstImage.naturalHeight;

      console.log(`Target stacking dimensions: ${targetWidth}x${targetHeight} (from first image)`);

      // Setup canvases
      const offscreenCanvas = document.createElement('canvas');
      offscreenCanvas.width = targetWidth;
      offscreenCanvas.height = targetHeight;
      const ctx = offscreenCanvas.getContext('2d', { willReadFrequently: true }); // willReadFrequently for getImageData

      const tempAnalysisCanvas = document.createElement('canvas'); // For scaled-down analysis
      const tempAnalysisCtx = tempAnalysisCanvas.getContext('2d', { willReadFrequently: true });

      if (!ctx || !tempAnalysisCtx) {
        throw new Error('Could not get canvas contexts for stacking');
      }
      
      // 1. Calculate Centroids for all images
      const centroids: ({ x: number; y: number } | null)[] = [];
      let successfulStarAlignments = 0;

      for (let i = 0; i < imageElements.length; i++) {
        const imgEl = imageElements[i]; // Already validated by loadImage
        const fileNameForLog = uploadedFiles[i]?.file?.name || `image ${i}`;
        let finalScaledCentroid: { x: number; y: number } | null = null;
        let method = "unknown";
        
        // This check is important before accessing naturalWidth/Height
        if (!imgEl || imgEl.naturalWidth === 0 || imgEl.naturalHeight === 0) {
            console.warn(`Skipping analysis for invalid image element at index ${i}: ${fileNameForLog}`);
            finalScaledCentroid = { x: targetWidth / 2, y: targetHeight / 2 }; // Fallback to target geometric center
            method = "invalid_element_fallback";
            centroids.push(finalScaledCentroid);
            console.log(`Image ${i} (${fileNameForLog}) centroid method: ${method}, Scaled to Target Coords:`, finalScaledCentroid);
            continue; // Skip to next image
        }
        
        try {
          console.log(`Analyzing image ${i} (${fileNameForLog}): ${imgEl.naturalWidth}x${imgEl.naturalHeight}`);
          // Determine analysis dimensions (scale down if image is larger than ANALYSIS_MAX_DIMENSION)
          let analysisWidth = imgEl.naturalWidth;
          let analysisHeight = imgEl.naturalHeight;
          let analysisScaleFactor = 1.0; // Scale factor from original to analysis size

          if (imgEl.naturalWidth > ANALYSIS_MAX_DIMENSION || imgEl.naturalHeight > ANALYSIS_MAX_DIMENSION) {
            if (imgEl.naturalWidth > imgEl.naturalHeight) {
              analysisScaleFactor = ANALYSIS_MAX_DIMENSION / imgEl.naturalWidth;
              analysisWidth = ANALYSIS_MAX_DIMENSION;
              analysisHeight = imgEl.naturalHeight * analysisScaleFactor;
            } else {
              analysisScaleFactor = ANALYSIS_MAX_DIMENSION / imgEl.naturalHeight;
              analysisHeight = ANALYSIS_MAX_DIMENSION;
              analysisWidth = imgEl.naturalWidth * analysisScaleFactor;
            }
            console.log(`Image ${fileNameForLog} scaled for analysis from ${imgEl.naturalWidth}x${imgEl.naturalHeight} to ${analysisWidth.toFixed(0)}x${analysisHeight.toFixed(0)} (factor: ${analysisScaleFactor.toFixed(3)})`);
          }
          analysisWidth = Math.max(1, Math.round(analysisWidth)); // Ensure positive dimensions
          analysisHeight = Math.max(1, Math.round(analysisHeight));

          tempAnalysisCanvas.width = analysisWidth;
          tempAnalysisCanvas.height = analysisHeight;
          tempAnalysisCtx.clearRect(0, 0, analysisWidth, analysisHeight);
          tempAnalysisCtx.drawImage(imgEl, 0, 0, analysisWidth, analysisHeight);
          const analysisImageData = tempAnalysisCtx.getImageData(0, 0, analysisWidth, analysisHeight);

          const stars = detectStars(analysisImageData);
          let analysisImageCentroid = calculateStarArrayCentroid(stars);
          
          if (analysisImageCentroid) {
              method = `star-based (${stars.length} stars detected, analysis on ${analysisWidth}x${analysisHeight}${analysisScaleFactor < 1.0 ? ' [scaled]' : ''})`;
              successfulStarAlignments++;
          } else {
            const reason = stars.length < 3 ? `only ${stars.length} stars detected (min 3 needed)` : "star detection/centroid calculation failed";
            method = `brightness-based fallback (${reason}, analysis on ${analysisWidth}x${analysisHeight}${analysisScaleFactor < 1.0 ? ' [scaled]' : ''})`;
            console.warn(`Star-based centroid failed for ${fileNameForLog} (${reason}). Falling back to brightness-based centroid.`);
            analysisImageCentroid = calculateBrightnessCentroid(analysisImageData);
          }
          
          // If centroid was found (either star or brightness), scale it back to original image coords, then to target coords
          if (analysisImageCentroid) {
            // Centroid in original image coordinates (relative to itself)
            const nativeEquivalentCentroid = {
                x: analysisImageCentroid.x / analysisScaleFactor,
                y: analysisImageCentroid.y / analysisScaleFactor,
            };
            // Centroid scaled to match the target image's coordinate system
            finalScaledCentroid = {
                x: nativeEquivalentCentroid.x * (targetWidth / imgEl.naturalWidth),
                y: nativeEquivalentCentroid.y * (targetHeight / imgEl.naturalHeight),
            };
          }

        } catch (imgAnalysisError) {
            const errorMessage = imgAnalysisError instanceof Error ? imgAnalysisError.message : String(imgAnalysisError);
            console.error(`Error analyzing image ${fileNameForLog}: ${errorMessage}`);
             toast({
                title: `Analysis Error for ${fileNameForLog}`,
                description: `Could not analyze image: ${errorMessage}. It may not align optimally.`,
                variant: "destructive"
            });
            method = "analysis_error";
        }
        
        // Fallback if no centroid could be determined at all
        if (!finalScaledCentroid) {
            console.error(`Could not determine any centroid for ${fileNameForLog}. It will be aligned to target geometric center.`);
            toast({
                title: "Centroid Failed",
                description: `Could not determine centroid for ${fileNameForLog}. It may not align optimally.`,
                variant: "destructive"
            });
            finalScaledCentroid = { x: targetWidth / 2, y: targetHeight / 2 }; // Fallback to target geometric center
            method = method === "analysis_error" ? "analysis_error_fallback" : "geometric_center_fallback";
        }
        console.log(`Image ${i} (${fileNameForLog}) centroid method: ${method}, Scaled to Target Coords:`, finalScaledCentroid);
        centroids.push(finalScaledCentroid);
      }

      // Ensure reference centroid (from first image) is valid
      const referenceCentroid = centroids[0];
      if (!referenceCentroid) {
        // This implies the first image analysis failed catastrophically or the image itself was invalid.
        toast({ title: "Alignment Failed", description: "Could not determine alignment reference for the first image. Stacking cannot proceed.", variant: "destructive" });
        setIsProcessing(false);
        return;
      }
      
      // 2. Stack Images using Median
      // Initialize a data structure to hold pixel values from all images for each pixel coordinate
      const pixelDataCollector: Array<{ r: number[], g: number[], b: number[] }> = [];
      for (let i = 0; i < targetWidth * targetHeight; i++) {
        pixelDataCollector.push({ r: [], g: [], b: [] });
      }
      let validImagesStackedCount = 0;

      for (let i = 0; i < imageElements.length; i++) {
        const img = imageElements[i]; // Already validated by loadImage
         // Double-check image validity before use
        if (!img || img.naturalWidth === 0 || img.naturalHeight === 0) {
            console.warn(`Skipping stacking for invalid image element at index ${i}: ${uploadedFiles[i]?.file.name}`);
            continue;
        }
        const currentCentroid = centroids[i]; // Should exist due to fallbacks
        
        let dx = 0;
        let dy = 0;
        
        if (currentCentroid) { // currentCentroid is already scaled to target coordinates
          dx = referenceCentroid.x - currentCentroid.x;
          dy = referenceCentroid.y - currentCentroid.y;
        } else {
          // This case should ideally not be reached if fallbacks are working, but as a last resort:
          // Align its geometric center (in target coords) to referenceCentroid.
          const nativeGeoCenterX = img.naturalWidth / 2;
          const nativeGeoCenterY = img.naturalHeight / 2;
          const targetEquivalentGeoCenterX = nativeGeoCenterX * (targetWidth / img.naturalWidth);
          const targetEquivalentGeoCenterY = nativeGeoCenterY * (targetHeight / img.naturalHeight);
          dx = referenceCentroid.x - targetEquivalentGeoCenterX;
          dy = referenceCentroid.y - targetEquivalentGeoCenterY;
          console.warn(`Centroid missing for image ${i} (${uploadedFiles[i]?.file.name}) at stacking stage. Aligning its geometric center to reference centroid.`);
        }
        
        console.log(`Stacking image ${i} (${uploadedFiles[i]?.file.name}) with offset dx=${dx.toFixed(2)}, dy=${dy.toFixed(2)}`);
        ctx.clearRect(0, 0, targetWidth, targetHeight); // Clear for each draw
        // Draw the current image, offset to align its centroid with the reference centroid,
        // and scaled to fit the target dimensions.
        ctx.drawImage(img, dx, dy, targetWidth, targetHeight); 
        
        try {
          const frameImageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
          const data = frameImageData.data;
          for (let j = 0; j < data.length; j += 4) {
            const pixelIndex = j / 4;
            pixelDataCollector[pixelIndex].r.push(data[j]);
            pixelDataCollector[pixelIndex].g.push(data[j + 1]);
            pixelDataCollector[pixelIndex].b.push(data[j + 2]);
            // Alpha is handled by finalImageData.data[i * 4 + 3] = 255;
          }
          validImagesStackedCount++;
        } catch (e) {
          // This can happen if getImageData fails (e.g., canvas is tainted, though unlikely with file uploads)
          const errorMsg = e instanceof Error ? e.message : String(e);
          console.error(`Error getting image data for frame ${i} (${uploadedFiles[i]?.file.name}) after drawing with offset: ${errorMsg}`);
          toast({
            title: `Stacking Error on Frame ${i}`,
            description: `Could not process pixel data for ${uploadedFiles[i]?.file.name || `image ${i}`}: ${errorMsg}. It might be excluded.`,
            variant: "destructive"
          });
        }
      }

      if (validImagesStackedCount === 0) {
        toast({ title: "Stacking Failed", description: "No images could be successfully processed and stacked.", variant: "destructive" });
        setIsProcessing(false); 
        return;
      }

      // Create the final image data by taking the median of collected pixel values
      const finalImageData = ctx.createImageData(targetWidth, targetHeight);
      for (let i = 0; i < pixelDataCollector.length; i++) {
        finalImageData.data[i * 4] = getMedian(pixelDataCollector[i].r);
        finalImageData.data[i * 4 + 1] = getMedian(pixelDataCollector[i].g);
        finalImageData.data[i * 4 + 2] = getMedian(pixelDataCollector[i].b);
        finalImageData.data[i * 4 + 3] = 255; // Full alpha
      }
      
      ctx.putImageData(finalImageData, 0, 0);
      const resultDataUrl = offscreenCanvas.toDataURL('image/png'); // Or image/jpeg for smaller files
      
      if (!resultDataUrl || resultDataUrl === "data:," || resultDataUrl.length < MIN_VALID_DATA_URL_LENGTH) {
        console.error("Failed to generate a valid data URL from canvas. Preview will be empty. Canvas might be too large, an operation failed, or the result is empty.");
        toast({
          title: "Preview Generation Failed",
          description: "Could not generate a valid image preview. The image might be too large, processing resulted in an empty image, or an internal error occurred during canvas processing.",
          variant: "destructive",
        });
        setStackedImage(null);
      } else {
        setStackedImage(resultDataUrl);
        const alignmentMessage = successfulStarAlignments > 0 
          ? `${successfulStarAlignments}/${imageElements.length} images primarily aligned using star-based centroids. Others used fallbacks.`
          : `All images aligned using brightness-based centroids or geometric centers due to insufficient stars detected. Analysis for alignment may have been scaled for performance.`;
        toast({ 
          title: "Median Stacking Complete", 
          description: `${alignmentMessage} ${validImagesStackedCount} image(s) processed using median stacking. Processing dimension was ${targetWidth}x${targetHeight}. This can be slow for large images.`,
          duration: 9000, // Longer duration for this important message
        });
      }

    } catch (error) {
      // Catch any unhandled errors from the entire process
      console.error("Unhandled error in handleStackImages:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast({
        title: "Stacking Process Failed",
        description: `An unexpected error occurred: ${errorMessage}. Check console for details.`,
        variant: "destructive",
      });
      setStackedImage(null); // Ensure preview is cleared on failure
    } finally {
      setIsProcessing(false); // Ensure processing state is reset
      console.log("Image median stacking process finished.");
    }
  };
  
  // Cleanup effect (optional, as data URLs don't need explicit revocation like Object URLs)
  useEffect(() => {
    return () => {
      // Potentially revoke object URLs if they were used, though fileToDataURL doesn't create them.
      // uploadedFiles.forEach(f => URL.revokeObjectURL(f.previewUrl)); // Only if previewUrl was from URL.createObjectURL
    };
  }, []);

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
                  Upload & Align Images (Median Stack)
                </CardTitle>
                <CardDescription>
                  Add PNG, JPG, GIF, or WEBP. Images are aligned using detected stars (or brightness centroids as fallback) and then stacked using the median pixel value to reduce noise.
                  Analysis for star detection on images larger than {ANALYSIS_MAX_DIMENSION}px (width/height) is done on a scaled-down version for performance.
                  Max image load dimension: {MAX_IMAGE_LOAD_DIMENSION}px.
                  Processing many or very large images may be slow or cause browser issues on some devices. This is computationally intensive.
                </CardDescription>
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
                            key={index} // Using index is okay here if list order doesn't change unexpectedly or items don't have stable IDs
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
                      disabled={isProcessing || uploadedFiles.length < 2}
                      className="w-full bg-accent hover:bg-accent/90 text-accent-foreground"
                      title={uploadedFiles.length < 2 ? "Upload at least two images for median stacking" : "Align & Median Stack Images"}
                    >
                      <Wand2 className="mr-2 h-5 w-5" />
                      {isProcessing ? 'Processing...' : `Align & Median Stack (${uploadedFiles.length})`}
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
    

    
