
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";


interface UploadedFile {
  file: File;
  previewUrl: string;
}

interface Star {
  x: number;
  y: number;
  brightness: number;
}

type StackingMode = 'median' | 'sigmaClip';

const MAX_IMAGE_LOAD_DIMENSION = 8192;
const ANALYSIS_MAX_DIMENSION = 600;
const MAX_STACKING_SIDE_LENGTH = 3500;
const MAX_IMAGES_TO_STACK = 10;
const MIN_VALID_DATA_URL_LENGTH = 100;
const MAX_STARS_FOR_CENTROID_CALCULATION = 2000;
const STACKING_BAND_HEIGHT = 50; 

const SIGMA_CLIP_THRESHOLD = 2.0;
const SIGMA_CLIP_ITERATIONS = 2;
const MIN_STARS_FOR_ALIGNMENT = 5; // New constant for minimum stars

// Helper function to yield to the event loop
const yieldToEventLoop = async (delayMs: number) => {
  await new Promise(resolve => setTimeout(resolve, delayMs));
};

function detectStars(imageData: ImageData, brightnessThreshold: number = 200, localContrastFactor: number = 1.5): Star[] {
  const stars: Star[] = [];
  const { data, width, height } = imageData;

  if (width === 0 || height === 0) {
    console.warn("detectStars called with zero-dimension imageData.");
    return stars;
  }

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const currentPixelBrightness = r + g + b;

      if (r > brightnessThreshold && g > brightnessThreshold && b > brightnessThreshold) {
        let neighborSumBrightness = 0;
        let neighborCount = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const ni = ((y + dy) * width + (x + dx)) * 4;
            if (ni >= 0 && ni < data.length -3) { 
                neighborSumBrightness += data[ni] + data[ni + 1] + data[ni + 2];
                neighborCount++;
            }
          }
        }
        if (neighborCount === 0) continue; 
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
  if (stars.length < MIN_STARS_FOR_ALIGNMENT) { // Changed from 3 to MIN_STARS_FOR_ALIGNMENT
     console.warn(`Not enough stars (${stars.length}) detected for star-based centroid. Need at least ${MIN_STARS_FOR_ALIGNMENT}.`);
     return null;
  }

  if (stars.length > MAX_STARS_FOR_CENTROID_CALCULATION) {
    console.warn(`More than ${MAX_STARS_FOR_CENTROID_CALCULATION} stars detected (${stars.length}). Using a random sample of ${MAX_STARS_FOR_CENTROID_CALCULATION} stars for centroid calculation to improve performance.`);
    const sampledStars: Star[] = [];
    const indices = new Set<number>();
    while (indices.size < MAX_STARS_FOR_CENTROID_CALCULATION && indices.size < stars.length) {
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
    return stars.length > 0 ? { x: stars[0].x, y: stars[0].y } : null;
  }

  return {
    x: weightedX / totalBrightness,
    y: weightedY / totalBrightness,
  };
}

function calculateBrightnessCentroid(imageData: ImageData, brightnessThreshold: number = 60): { x: number; y: number } | null {
    const { data, width, height } = imageData;
    if (width === 0 || height === 0) {
        console.warn("calculateBrightnessCentroid called with zero-dimension imageData.");
        return { x: 0, y: 0 }; 
    }
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
      return { x: width / 2, y: height / 2 };
    }

    return {
      x: weightedX / totalBrightness,
      y: weightedY / totalBrightness,
    };
}

const getMedian = (arr: number[]): number => {
  if (!arr.length) return 0;
  const sortedArr = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sortedArr.length / 2);
  if (sortedArr.length % 2 !== 0) {
    return sortedArr[mid];
  }
  return (sortedArr[mid - 1] + sortedArr[mid]) / 2;
};

const calculateMean = (arr: number[]): number => {
  if (!arr.length) return 0;
  return arr.reduce((acc, val) => acc + val, 0) / arr.length;
};

const calculateStdDev = (arr: number[], meanVal?: number): number => {
  if (arr.length < 2) return 0; 
  const mean = meanVal === undefined ? calculateMean(arr) : meanVal;
  const variance = arr.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (arr.length -1); // Sample standard deviation (n-1)
  return Math.sqrt(variance);
};

const applySigmaClip = (
  initialValues: number[],
  sigmaThreshold: number = SIGMA_CLIP_THRESHOLD,
  maxIterations: number = SIGMA_CLIP_ITERATIONS
): number => {
  if (!initialValues.length) return 0;
  if (initialValues.length === 1) return initialValues[0];

  let currentValues = [...initialValues];

  for (let iter = 0; iter < maxIterations; iter++) {
    if (currentValues.length < 2) break; 

    const mean = calculateMean(currentValues);
    const stdDev = calculateStdDev(currentValues, mean);

    if (stdDev === 0) break; 

    const lowerBound = mean - sigmaThreshold * stdDev;
    const upperBound = mean + sigmaThreshold * stdDev;

    const nextValues = currentValues.filter(val => val >= lowerBound && val <= upperBound);

    if (nextValues.length === currentValues.length) {
      break; 
    }
    currentValues = nextValues;
  }
  
  if (!currentValues.length) { // If all values were clipped
    return calculateMean(initialValues); // Fallback to mean of original values
  }
  return calculateMean(currentValues); // Return mean of the (remaining) clipped values
};


export default function AstroStackerPage() {
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [stackedImage, setStackedImage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [stackingMode, setStackingMode] = useState<StackingMode>('median');
  const { toast } = useToast();

  const handleFilesAdded = async (files: File[]) => {
    setIsProcessing(true);
    const newUploadedFiles: UploadedFile[] = [];
    const acceptedWebTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

    for (const file of files) {
      try {
        const fileType = file.type.toLowerCase();
        const fileName = file.name.toLowerCase();

        if (fileType === 'image/tiff' || fileName.endsWith('.tiff') || fileName.endsWith('.tif') ||
            fileType === 'image/x-adobe-dng' || fileType === 'image/x-raw' || fileName.endsWith('.dng')) {
          toast({
            title: "Manual Conversion Required",
            description: `${file.name} is a TIFF/DNG file. Please convert it to JPG, PNG, or WEBP manually for stacking. Automatic conversion is not supported.`,
            variant: "default", 
            duration: 8000,
          });
          continue; 
        }

        if (!acceptedWebTypes.includes(fileType)) {
            toast({
                title: "Unsupported File Type",
                description: `${file.name} is not a supported image type for stacking. Please use JPG, PNG, GIF, or WEBP.`,
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
      toast({ title: "Not Enough Images", description: "Please upload at least two images for stacking." });
      return;
    }
    setIsProcessing(true);
    setStackedImage(null);
    console.log(`Starting image stacking process (${stackingMode})...`);

    let filesToProcess = uploadedFiles;
    if (uploadedFiles.length > MAX_IMAGES_TO_STACK) {
      toast({
        title: "Processing Limit Applied",
        description: `To ensure stability, only the first ${MAX_IMAGES_TO_STACK} images will be stacked.`,
        variant: "default",
        duration: 7000,
      });
      filesToProcess = uploadedFiles.slice(0, MAX_IMAGES_TO_STACK);
    }

    try {
      let imageElements: HTMLImageElement[] = [];
      for (const f of filesToProcess) {
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

      if (imageElements.length < 2) {
        toast({ title: "Not Enough Valid Images", description: `Need at least two valid images (out of the processed set of ${filesToProcess.length}) for stacking after filtering. Found ${imageElements.length}.`, variant: "destructive" });
        setIsProcessing(false);
        return;
      }

      const firstImage = imageElements[0];
      if (!firstImage || firstImage.naturalWidth === 0 || firstImage.naturalHeight === 0) {
        toast({
          title: "Invalid Reference Image",
          description: `The first image (${filesToProcess[0]?.file.name || 'unknown'}) is invalid or empty. Cannot proceed.`,
          variant: "destructive",
        });
        setIsProcessing(false);
        return;
      }
      
      let targetWidth = firstImage.naturalWidth;
      let targetHeight = firstImage.naturalHeight;

      if (targetWidth > MAX_STACKING_SIDE_LENGTH || targetHeight > MAX_STACKING_SIDE_LENGTH) {
        const aspectRatio = targetWidth / targetHeight;
        if (targetWidth > targetHeight) {
          targetWidth = MAX_STACKING_SIDE_LENGTH;
          targetHeight = Math.round(targetWidth / aspectRatio);
        } else {
          targetHeight = MAX_STACKING_SIDE_LENGTH;
          targetWidth = Math.round(targetHeight * aspectRatio);
        }
        targetWidth = Math.max(1, targetWidth); 
        targetHeight = Math.max(1, targetHeight); 
        toast({
          title: "Stacking Resolution Capped",
          description: `For stability, stacking resolution has been capped to ${targetWidth}x${targetHeight} because the first image was larger than ${MAX_STACKING_SIDE_LENGTH}px on one side.`,
          duration: 9000,
        });
      }
      console.log(`Target stacking dimensions: ${targetWidth}x${targetHeight}`);
      if (targetWidth === 0 || targetHeight === 0) {
        toast({ title: "Error", description: "Calculated target stacking dimensions are zero. Cannot proceed.", variant: "destructive" });
        setIsProcessing(false);
        return;
      }
      
      const numImages = imageElements.length;
      const totalPixels = targetWidth * targetHeight;
      const normalizedImageFactor = Math.min(1, numImages / MAX_IMAGES_TO_STACK);
      const maxPossiblePixels = (MAX_STACKING_SIDE_LENGTH || 1) * (MAX_STACKING_SIDE_LENGTH || 1);
      const normalizedPixelFactor = Math.min(1, totalPixels / maxPossiblePixels);
      const loadScore = (0.3 * normalizedImageFactor) + (0.7 * normalizedPixelFactor); 
      const dynamicDelayMs = Math.max(1, Math.min(50, 1 + Math.floor(loadScore * 49))); 
      console.log(`Calculated dynamic yield delay: ${dynamicDelayMs}ms based on load score: ${loadScore.toFixed(2)} (Images: ${numImages}, Pixels: ${totalPixels})`);


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
        const fileNameForLog = filesToProcess[i]?.file?.name || `image ${i}`;
        let finalScaledCentroid: { x: number; y: number } | null = null;
        let method = "unknown";
        
        if (!imgEl || imgEl.naturalWidth === 0 || imgEl.naturalHeight === 0) {
            console.warn(`Skipping analysis for invalid image element at index ${i}: ${fileNameForLog}`);
            finalScaledCentroid = { x: targetWidth / 2, y: targetHeight / 2 };
            method = "invalid_element_fallback";
            centroids.push(finalScaledCentroid);
            console.log(`Image ${i} (${fileNameForLog}) centroid method: ${method}, Scaled to Target Coords:`, finalScaledCentroid);
            await yieldToEventLoop(dynamicDelayMs); 
            continue;
        }
        
        try {
          console.log(`Analyzing image ${i} (${fileNameForLog}): ${imgEl.naturalWidth}x${imgEl.naturalHeight}`);
          let analysisWidth = imgEl.naturalWidth;
          let analysisHeight = imgEl.naturalHeight;
          let analysisScaleFactor = 1.0;

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
          analysisWidth = Math.max(1, Math.round(analysisWidth));
          analysisHeight = Math.max(1, Math.round(analysisHeight));

          tempAnalysisCanvas.width = analysisWidth;
          tempAnalysisCanvas.height = analysisHeight;
          tempAnalysisCtx.clearRect(0, 0, analysisWidth, analysisHeight);
          tempAnalysisCtx.drawImage(imgEl, 0, 0, analysisWidth, analysisHeight);
          
          let analysisImageData: ImageData | null = null;
          try {
            analysisImageData = tempAnalysisCtx.getImageData(0, 0, analysisWidth, analysisHeight);
          } catch (getImageDataError) {
             console.error(`Error getting image data for analysis canvas (${fileNameForLog}):`, getImageDataError);
             toast({
                title: `Analysis Error (getImageData) for ${fileNameForLog}`,
                description: `Could not get pixel data for analysis. It may not align optimally.`,
                variant: "destructive"
            });
            method = "getImageData_error";
          }

          if (analysisImageData) {
            const stars = detectStars(analysisImageData);
            let analysisImageCentroid = calculateStarArrayCentroid(stars);
            
            if (analysisImageCentroid) {
                method = `star-based (${stars.length} stars detected, analysis on ${analysisWidth}x${analysisHeight}${analysisScaleFactor < 1.0 ? ' [scaled]' : ''})`;
                successfulStarAlignments++;
            } else {
              const reason = stars.length < MIN_STARS_FOR_ALIGNMENT ? `only ${stars.length} stars detected (min ${MIN_STARS_FOR_ALIGNMENT} needed)` : "star detection/centroid calculation failed";
              method = `brightness-based fallback (${reason}, analysis on ${analysisWidth}x${analysisHeight}${analysisScaleFactor < 1.0 ? ' [scaled]' : ''})`;
              console.warn(`Star-based centroid failed for ${fileNameForLog} (${reason}). Falling back to brightness-based centroid.`);
              analysisImageCentroid = calculateBrightnessCentroid(analysisImageData);
            }
            
            if (analysisImageCentroid) {
              const nativeEquivalentCentroid = {
                  x: analysisImageCentroid.x / analysisScaleFactor,
                  y: analysisImageCentroid.y / analysisScaleFactor,
              };
              finalScaledCentroid = {
                  x: nativeEquivalentCentroid.x * (targetWidth / imgEl.naturalWidth),
                  y: nativeEquivalentCentroid.y * (targetHeight / imgEl.naturalHeight),
              };
            }
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
        
        if (!finalScaledCentroid) {
            console.error(`Could not determine any centroid for ${fileNameForLog}. It will be aligned to target geometric center.`);
            toast({
                title: "Centroid Failed",
                description: `Could not determine centroid for ${fileNameForLog}. It may not align optimally.`,
                variant: "destructive"
            });
            finalScaledCentroid = { x: targetWidth / 2, y: targetHeight / 2 };
            method = method.includes("_error") ? `${method}_fallback` : "geometric_center_fallback";
        }
        console.log(`Image ${i} (${fileNameForLog}) centroid method: ${method}, Scaled to Target Coords:`, finalScaledCentroid);
        centroids.push(finalScaledCentroid);
        await yieldToEventLoop(dynamicDelayMs); 
      }

      const referenceCentroid = centroids[0];
      if (!referenceCentroid) {
        toast({ title: "Alignment Failed", description: "Could not determine alignment reference for the first image. Stacking cannot proceed.", variant: "destructive" });
        setIsProcessing(false);
        return;
      }
      
      const finalImageData = ctx.createImageData(targetWidth, targetHeight);
      let validImagesStackedCount = 0;

      console.log(`Starting band processing. Band height: ${STACKING_BAND_HEIGHT}px. Dynamic yield delay: ${dynamicDelayMs}ms. Mode: ${stackingMode}`);

      for (let yBandStart = 0; yBandStart < targetHeight; yBandStart += STACKING_BAND_HEIGHT) {
        const currentBandHeight = Math.min(STACKING_BAND_HEIGHT, targetHeight - yBandStart);

        const bandPixelDataCollector: Array<{ r: number[], g: number[], b: number[] }> = [];
        for (let i = 0; i < targetWidth * currentBandHeight; i++) {
          bandPixelDataCollector.push({ r: [], g: [], b: [] });
        }

        let imagesContributingToBand = 0;
        for (let i = 0; i < imageElements.length; i++) {
          const img = imageElements[i];
          if (!img || img.naturalWidth === 0 || img.naturalHeight === 0) {
            continue;
          }
          const currentCentroid = centroids[i];
          
          let dx = 0;
          let dy = 0;
          
          if (currentCentroid) {
            dx = referenceCentroid.x - currentCentroid.x;
            dy = referenceCentroid.y - currentCentroid.y;
          } else {
            const nativeGeoCenterX = img.naturalWidth / 2;
            const nativeGeoCenterY = img.naturalHeight / 2;
            const targetEquivalentGeoCenterX = nativeGeoCenterX * (targetWidth / img.naturalWidth);
            const targetEquivalentGeoCenterY = nativeGeoCenterY * (targetHeight / img.naturalHeight);
            dx = referenceCentroid.x - targetEquivalentGeoCenterX;
            dy = referenceCentroid.y - targetEquivalentGeoCenterY;
          }
          
          ctx.clearRect(0, 0, targetWidth, targetHeight); 
          ctx.drawImage(img, dx, dy, targetWidth, targetHeight); 
          
          try {
            const bandFrameImageData = ctx.getImageData(0, yBandStart, targetWidth, currentBandHeight);
            const bandData = bandFrameImageData.data;
            
            for (let j = 0; j < bandData.length; j += 4) {
              const bandPixelIndex = j / 4;
              if (bandPixelDataCollector[bandPixelIndex]) { 
                  bandPixelDataCollector[bandPixelIndex].r.push(bandData[j]);
                  bandPixelDataCollector[bandPixelIndex].g.push(bandData[j + 1]);
                  bandPixelDataCollector[bandPixelIndex].b.push(bandData[j + 2]);
              }
            }
            if (yBandStart === 0) { 
              imagesContributingToBand++;
            }
          } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            console.error(`Error getting image data for band (img ${i}, bandY ${yBandStart}): ${errorMsg}`);
            toast({
              title: `Stacking Error on Band Processing`,
              description: `Could not process pixel data for ${filesToProcess[i]?.file.name || `image ${i}`} for band starting at row ${yBandStart}.`,
              variant: "destructive"
            });
          }
           await yieldToEventLoop(dynamicDelayMs);
        }
        if (yBandStart === 0) validImagesStackedCount = imagesContributingToBand;


        for (let yInBand = 0; yInBand < currentBandHeight; yInBand++) {
          for (let x = 0; x < targetWidth; x++) {
              const bandPixelIndex = yInBand * targetWidth + x;
              const finalPixelGlobalIndex = ((yBandStart + yInBand) * targetWidth + x) * 4;

              if (bandPixelDataCollector[bandPixelIndex]) {
                if (stackingMode === 'median') {
                  finalImageData.data[finalPixelGlobalIndex] = getMedian(bandPixelDataCollector[bandPixelIndex].r);
                  finalImageData.data[finalPixelGlobalIndex + 1] = getMedian(bandPixelDataCollector[bandPixelIndex].g);
                  finalImageData.data[finalPixelGlobalIndex + 2] = getMedian(bandPixelDataCollector[bandPixelIndex].b);
                } else { // sigmaClip
                  finalImageData.data[finalPixelGlobalIndex] = applySigmaClip(bandPixelDataCollector[bandPixelIndex].r);
                  finalImageData.data[finalPixelGlobalIndex + 1] = applySigmaClip(bandPixelDataCollector[bandPixelIndex].g);
                  finalImageData.data[finalPixelGlobalIndex + 2] = applySigmaClip(bandPixelDataCollector[bandPixelIndex].b);
                }
                finalImageData.data[finalPixelGlobalIndex + 3] = 255; 
              } else {
                  finalImageData.data[finalPixelGlobalIndex] = 0;
                  finalImageData.data[finalPixelGlobalIndex + 1] = 0;
                  finalImageData.data[finalPixelGlobalIndex + 2] = 0;
                  finalImageData.data[finalPixelGlobalIndex + 3] = 255;
              }
          }
        }
        if (yBandStart % (STACKING_BAND_HEIGHT * 5) === 0 || yBandStart + currentBandHeight >= targetHeight ) { 
             console.log(`Processed band: rows ${yBandStart} to ${yBandStart + currentBandHeight - 1}. Yielding.`);
        }
        await yieldToEventLoop(dynamicDelayMs); 
      }


      if (validImagesStackedCount === 0 && imageElements.length > 0) {
        toast({ title: "Stacking Failed", description: "No images could be successfully processed during band stacking.", variant: "destructive" });
        setIsProcessing(false);
        return;
      }
      
      ctx.putImageData(finalImageData, 0, 0);
      const resultDataUrl = offscreenCanvas.toDataURL('image/png');
      
      if (!resultDataUrl || resultDataUrl === "data:," || resultDataUrl.length < MIN_VALID_DATA_URL_LENGTH) {
        console.error("Failed to generate a valid data URL from canvas. Preview will be empty.");
        toast({
          title: "Preview Generation Failed",
          description: "Could not generate a valid image preview. The image might be too large or an internal error occurred.",
          variant: "destructive",
        });
        setStackedImage(null);
      } else {
        setStackedImage(resultDataUrl);
        const alignmentMessage = successfulStarAlignments > 0
          ? `${successfulStarAlignments}/${imageElements.length} images primarily aligned using star-based centroids. Others used fallbacks.`
          : `All images aligned using brightness-based centroids or geometric centers.`;
        
        const stackingMethodUsed = stackingMode === 'median' ? 'Median' : 'Sigma Clip';
        toast({
          title: `${stackingMethodUsed} Stacking Complete`,
          description: `${alignmentMessage} ${validImagesStackedCount} image(s) (out of ${imageElements.length} processed) stacked using ${stackingMode === 'median' ? 'median' : 'sigma clipping'} (banded processing). Dimension: ${targetWidth}x${targetHeight}.`,
          duration: 10000, 
        });
      }

    } catch (error) {
      console.error("Unhandled error in handleStackImages:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast({
        title: "Stacking Process Failed",
        description: `An unexpected error occurred: ${errorMessage}. Check console for details.`,
        variant: "destructive",
      });
      setStackedImage(null);
    } finally {
      setIsProcessing(false);
      console.log("Image stacking process finished.");
    }
  };
  
  useEffect(() => {
    return () => {
    };
  }, []);

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <AppHeader />
      <main className="flex-grow container mx-auto py-6 px-2 sm:px-4 md:px-6">
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="w-full lg:w-2/5 xl:w-1/3 space-y-6">
            <Card className="shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center text-xl font-headline">
                  <StarIcon className="mr-2 h-5 w-5 text-accent" />
                  Upload & Align Images
                </CardTitle>
                <CardDescription>
                  Add PNG, JPG, GIF, or WEBP. TIFF/DNG files require manual pre-conversion. Images are aligned using stars (min {MIN_STARS_FOR_ALIGNMENT} required) or brightness centroids then stacked.
                  Median stacking uses median pixel values. Sigma Clip stacking iteratively removes outliers and averages the rest. Both processed in bands for stability.
                  Analysis for star detection on images larger than {ANALYSIS_MAX_DIMENSION}px is scaled.
                  Max image load: {MAX_IMAGE_LOAD_DIMENSION}px.
                  Stacking resolution capped near {MAX_STACKING_SIDE_LENGTH}px. Max {MAX_IMAGES_TO_STACK} images.
                  Processing can be slow/intensive. Sigma Clip is generally slower than Median.
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
                            key={index} 
                            file={uploadedFile.file}
                            previewUrl={uploadedFile.previewUrl}
                            onRemove={() => handleRemoveImage(index)}
                            isProcessing={isProcessing}
                          />
                        ))}
                      </div>
                    </ScrollArea>

                    <div className="space-y-2 pt-2">
                      <Label className="text-base font-semibold text-foreground">Stacking Mode</Label>
                      <RadioGroup
                        value={stackingMode}
                        onValueChange={(value: string) => setStackingMode(value as StackingMode)}
                        className="flex space-x-4"
                        disabled={isProcessing}
                      >
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="median" id="median-stack" />
                          <Label htmlFor="median-stack" className="cursor-pointer">Median</Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="sigmaClip" id="sigma-clip-stack" />
                          <Label htmlFor="sigma-clip-stack" className="cursor-pointer">Sigma Clip</Label>
                        </div>
                      </RadioGroup>
                       <p className="text-xs text-muted-foreground">
                        Median is generally faster. Sigma Clip can be better for outlier rejection but is more computationally intensive.
                       </p>
                    </div>

                    <Button
                      onClick={handleStackImages}
                      disabled={isProcessing || uploadedFiles.length < 2}
                      className="w-full bg-accent hover:bg-accent/90 text-accent-foreground"
                      title={uploadedFiles.length < 2 ? "Upload at least two images for stacking" : `Align & Stack using ${stackingMode === 'median' ? 'Median' : 'Sigma Clip'}`}
                    >
                      <Wand2 className="mr-2 h-5 w-5" />
                      {isProcessing ? 'Processing...' : `Align & ${stackingMode === 'median' ? 'Median' : 'Sigma Clip'} Stack (${Math.min(uploadedFiles.length, MAX_IMAGES_TO_STACK)})`}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

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
    
