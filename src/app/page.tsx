
"use client";

import type React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { fileToDataURL } from '@/lib/utils';

import { AppHeader } from '@/components/astrostacker/AppHeader';
import { ImageUploadArea } from '@/components/astrostacker/ImageUploadArea';
import { ImageQueueItem } from '@/components/astrostacker/ImageQueueItem';
import { ImagePreview } from '@/components/astrostacker/ImagePreview';
import { DownloadButton } from '@/components/astrostacker/DownloadButton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Star as StarIcon, Wand2, ListChecks, CheckCircle, RefreshCcw, Edit3 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { StarAnnotationCanvas, type Star } from '@/components/astrostacker/StarAnnotationCanvas';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface LogEntry {
  id: number;
  timestamp: string;
  message: string;
}

interface UploadedFile {
  file: File;
  previewUrl: string;
}

// Star interface moved to StarAnnotationCanvas.tsx and imported

type StackingMode = 'median' | 'sigmaClip';
type PreviewFitMode = 'contain' | 'cover';
type OutputFormat = 'png' | 'jpeg';

const MAX_IMAGE_LOAD_DIMENSION = 8192;
const ANALYSIS_MAX_DIMENSION = 1000; // Increased for potentially better star detail
const MAX_STACKING_SIDE_LENGTH = 3500;
const MIN_VALID_DATA_URL_LENGTH = 100;
const STACKING_BAND_HEIGHT = 50;

const SIGMA_CLIP_THRESHOLD = 2.0;
const SIGMA_CLIP_ITERATIONS = 2;
const MIN_STARS_FOR_ALIGNMENT = 3; // Reduced for flexibility

const PROGRESS_INITIAL_SETUP = 5;
const PROGRESS_CENTROID_CALCULATION_TOTAL = 30;
const PROGRESS_BANDED_STACKING_TOTAL = 65; // Remainder of progress

const DEFAULT_STAR_BRIGHTNESS_THRESHOLD_COMBINED = 200; // Base for auto-detection and manual add
const DEFAULT_STAR_LOCAL_CONTRAST_FACTOR = 1.6; // Stricter
const BRIGHTNESS_CENTROID_FALLBACK_THRESHOLD_GRAYSCALE_EQUIVALENT = 30;

const STAR_CLICK_TOLERANCE_ANALYSIS_UNITS_SQUARED = (10 * 10) * ((ANALYSIS_MAX_DIMENSION / 600)**2); // 10px on a 600px canvas, scaled to analysis size

const yieldToEventLoop = async (delayMs: number) => {
  await new Promise(resolve => setTimeout(resolve, delayMs));
};

function detectStars(
  imageData: ImageData,
  brightnessThresholdCombined: number = DEFAULT_STAR_BRIGHTNESS_THRESHOLD_COMBINED,
  localContrastFactor: number = DEFAULT_STAR_LOCAL_CONTRAST_FACTOR
): Star[] {
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

      if (currentPixelBrightness > brightnessThresholdCombined) {
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
    console.warn(`Detected a large number of stars (${stars.length}) during analysis. This might slow down initial sorting for brightest star selection or indicate a noisy image. Consider adjusting detection parameters if results are suboptimal.`);
  } else if (stars.length === 0) {
    console.warn(`No stars detected with current parameters (Combined Threshold: ${brightnessThresholdCombined}, Contrast Factor: ${localContrastFactor}).`);
  }
  return stars;
}

function calculateStarArrayCentroid(starsInput: Star[], addLog: (message: string) => void): { x: number; y: number } | null {
  if (starsInput.length < MIN_STARS_FOR_ALIGNMENT) {
     const message = `Not enough stars (${starsInput.length}) detected for star-based centroid. Need at least ${MIN_STARS_FOR_ALIGNMENT}.`;
     console.warn(message);
     addLog(`[ALIGN] ${message}`);
     return null;
  }

  // Sort by brightness, then take up to MIN_STARS_FOR_ALIGNMENT * 2, or all if fewer than that
  const sortedStars = [...starsInput].sort((a, b) => b.brightness - a.brightness);
  const brightestStarsToUse = sortedStars.slice(0, Math.min(starsInput.length, Math.max(MIN_STARS_FOR_ALIGNMENT, MIN_STARS_FOR_ALIGNMENT * 2)));


  const message = `Using ${brightestStarsToUse.length} brightest stars (out of ${starsInput.length} available, min ${MIN_STARS_FOR_ALIGNMENT} required) for centroid.`;
  console.log(message);
  addLog(`[ALIGN] ${message}`);

  let totalBrightness = 0;
  let weightedX = 0;
  let weightedY = 0;

  for (const star of brightestStarsToUse) {
    weightedX += star.x * star.brightness;
    weightedY += star.y * star.brightness;
    totalBrightness += star.brightness;
  }

  if (totalBrightness === 0) {
    if (brightestStarsToUse.length > 0) {
        const warnMsg = "Total brightness of selected brightest stars is zero. Using simple average of their positions.";
        console.warn(warnMsg);
        addLog(`[ALIGN WARN] ${warnMsg}`);
        let sumX = 0;
        let sumY = 0;
        for (const star of brightestStarsToUse) {
            sumX += star.x;
            sumY += star.y;
        }
        return { x: sumX / brightestStarsToUse.length, y: sumY / brightestStarsToUse.length};
    }
    addLog(`[ALIGN WARN] Total brightness of selected stars is zero and no stars to average. Cannot calculate star centroid.`);
    return null;
  }

  return {
    x: weightedX / totalBrightness,
    y: weightedY / totalBrightness,
  };
}

function calculateBrightnessCentroid(imageData: ImageData, addLog: (message: string) => void, brightnessThreshold: number = BRIGHTNESS_CENTROID_FALLBACK_THRESHOLD_GRAYSCALE_EQUIVALENT): { x: number; y: number } | null {
    const { data, width, height } = imageData;
    if (width === 0 || height === 0) {
        const warnMsg = "calculateBrightnessCentroid called with zero-dimension imageData.";
        console.warn(warnMsg);
        addLog(`[ALIGN WARN] ${warnMsg}`);
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
        const brightness = 0.299 * r + 0.587 * g + 0.114 * b; // Grayscale equivalent

        if (brightness > brightnessThreshold) {
          weightedX += x * brightness;
          weightedY += y * brightness;
          totalBrightness += brightness;
          brightPixels++;
        }
      }
    }

    if (totalBrightness === 0 || brightPixels === 0) {
      const warnMsg = `No bright pixels (above ${brightnessThreshold}) found for brightness centroid. Falling back to geometric center.`;
      console.warn(warnMsg);
      addLog(`[ALIGN WARN] ${warnMsg}`);
      return { x: width / 2, y: height / 2 };
    }

    addLog(`[ALIGN] Brightness centroid: ${brightPixels} pixels over threshold ${brightnessThreshold}.`);
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
  const variance = arr.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (arr.length -1); // sample std dev
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
    if (currentValues.length < 2) break; // Need at least 2 points to calculate std dev

    const mean = calculateMean(currentValues);
    const stdDev = calculateStdDev(currentValues, mean);

    if (stdDev === 0) break; // No variation, no clipping needed

    const lowerBound = mean - sigmaThreshold * stdDev;
    const upperBound = mean + sigmaThreshold * stdDev;

    const nextValues = currentValues.filter(val => val >= lowerBound && val <= upperBound);

    if (nextValues.length === currentValues.length) { // No values were clipped
      break;
    }
    currentValues = nextValues;
  }

  // If all values were clipped, fall back to the mean of the original set
  if (!currentValues.length) {
    // This scenario should be rare with good data but is a safeguard
    return calculateMean(initialValues);
  }
  return calculateMean(currentValues); // Return mean of the clipped set
};


export default function AstroStackerPage() {
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [stackedImage, setStackedImage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false); // True during actual stacking
  const [isAnalyzingForStars, setIsAnalyzingForStars] = useState(false); // True during initial star detection for editing
  const [stackingMode, setStackingMode] = useState<StackingMode>('median');
  const [previewFitMode, setPreviewFitMode] = useState<PreviewFitMode>('contain');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('png');
  const [jpegQuality, setJpegQuality] = useState<number>(92);
  const [progressPercent, setProgressPercent] = useState(0);
  const { toast } = useToast();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const logIdCounter = useRef(0);

  // State for interactive star selection
  const [isAwaitingStarConfirmation, setIsAwaitingStarConfirmation] = useState(false);
  const [referenceImagePreviewForStarEditing, setReferenceImagePreviewForStarEditing] = useState<string | null>(null);
  const [currentAnalysisStars, setCurrentAnalysisStars] = useState<Star[]>([]);
  const [currentAnalysisImageDimensions, setCurrentAnalysisImageDimensions] = useState<{width: number, height: number} | null>(null);
  const initialAutoDetectedStarsRef = useRef<Star[]>([]); // To store original auto-detected stars for reset

  const addLog = useCallback((message: string) => {
    setLogs(prevLogs => {
      const newLog = {
        id: logIdCounter.current++,
        timestamp: new Date().toLocaleTimeString(),
        message
      };
      const updatedLogs = [newLog, ...prevLogs];
      return updatedLogs.slice(0, 100); 
    });
  }, []);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = 0;
    }
  }, [logs]);


  const handleFilesAdded = async (files: File[]) => {
    setIsProcessing(true); // General processing indicator
    setProgressPercent(0);

    const newUploadedFiles: UploadedFile[] = [];
    const acceptedWebTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    let fileProcessingMessage = `Attempting to add ${files.length} file(s).`;
    if (files.length > 0) {
        fileProcessingMessage += ` First file: ${files[0].name}`;
    }
    addLog(fileProcessingMessage);

    for (const file of files) {
      try {
        const fileType = file.type.toLowerCase();
        const fileName = file.name.toLowerCase();
        addLog(`Processing file: ${file.name} (Type: ${fileType || 'unknown'})`);

        if (fileType === 'image/tiff' || fileName.endsWith('.tiff') || fileName.endsWith('.tif') ||
            fileType === 'image/x-adobe-dng' || fileType === 'image/x-raw' || fileName.endsWith('.dng')) {
          const tiffMsg = `${file.name} is a TIFF/DNG. Manual conversion needed.`;
          addLog(`[WARN] ${tiffMsg}`);
          toast({
            title: "Manual Conversion Required",
            description: `${tiffMsg} Try: https://convertio.co/kr/tiff-png/`,
            variant: "default",
            duration: 8000,
          });
          continue;
        }

        if (!acceptedWebTypes.includes(fileType)) {
            const unsupportedMsg = `${file.name} is unsupported. Use JPG, PNG, GIF, or WEBP.`;
            addLog(`[ERROR] ${unsupportedMsg}`);
            toast({
                title: "Unsupported File Type",
                description: unsupportedMsg,
                variant: "destructive",
            });
            continue;
        }
        const previewUrl = await fileToDataURL(file);
        newUploadedFiles.push({ file, previewUrl });
        addLog(`Successfully added ${file.name} to queue.`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        addLog(`[ERROR] Could not read ${file.name}: ${errorMessage}`);
        toast({
          title: "Error Reading File",
          description: `Could not read ${file.name}: ${errorMessage}`,
          variant: "destructive",
        });
      }
    }
    setUploadedFiles(prev => [...prev, ...newUploadedFiles]);
    addLog(`Finished adding files. ${newUploadedFiles.length} new files queued. Total: ${uploadedFiles.length + newUploadedFiles.length}.`);
    setIsProcessing(false);
  };

  const handleRemoveImage = (indexToRemove: number) => {
    const fileName = uploadedFiles[indexToRemove]?.file?.name || `image at index ${indexToRemove}`;
    setUploadedFiles(prev => prev.filter((_, index) => index !== indexToRemove));
    addLog(`Removed ${fileName} from queue.`);
  };

  const loadImage = (file: File): Promise<HTMLImageElement> => {
    addLog(`Loading image into memory: ${file.name}`);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (!event.target?.result) {
          addLog(`[ERROR] FileReader failed for ${file.name}.`);
          reject(new Error(`FileReader failed to produce a result for ${file.name}.`));
          return;
        }
        const img = new Image();
        img.onload = () => {
          if (img.naturalWidth === 0 || img.naturalHeight === 0) {
            addLog(`[ERROR] Image ${file.name} loaded with 0x0 dimensions.`);
            reject(new Error(`Image ${file.name} loaded with zero dimensions (0x0). Its data cannot be processed.`));
          } else if (img.naturalWidth > MAX_IMAGE_LOAD_DIMENSION || img.naturalHeight > MAX_IMAGE_LOAD_DIMENSION) {
            addLog(`[ERROR] Image ${file.name} (${img.naturalWidth}x${img.naturalHeight}) exceeds max load size ${MAX_IMAGE_LOAD_DIMENSION}px.`);
            reject(new Error(`Image ${file.name} dimensions (${img.naturalWidth}x${img.naturalHeight}) exceed max allowed load size of ${MAX_IMAGE_LOAD_DIMENSION}px. It cannot be processed.`));
          } else {
            addLog(`Successfully loaded ${file.name} (${img.naturalWidth}x${img.naturalHeight}) into memory.`);
            resolve(img);
          }
        };
        img.onerror = (e) => {
          const errorMsg = typeof e === 'string' ? e : (e as Event)?.type || 'unknown image load error';
          addLog(`[ERROR] Failed to load image ${file.name}: ${errorMsg}`);
          reject(new Error(`Failed to load image ${file.name}: ${errorMsg}`));
        };
        img.src = event.target.result as string;
      };
      reader.onerror = () => {
        const readerError = reader.error?.name || 'unknown error';
        addLog(`[ERROR] FileReader failed for ${file.name}: ${readerError}`);
        reject(new Error(`FileReader failed to read ${file.name}. Error: ${readerError}`));
      };
      reader.readAsDataURL(file);
    });
  };

  // Step 1: Initial call to analyze reference image for star editing
  const handleAnalyzeAndEditStars = async () => {
    if (uploadedFiles.length === 0) {
      toast({ title: "No Images", description: "Please upload at least one image." });
      return;
    }
    setIsAnalyzingForStars(true);
    setLogs([]);
    logIdCounter.current = 0;
    addLog("Starting star analysis for reference image...");

    const referenceFile = uploadedFiles[0].file;
    try {
      const imgEl = await loadImage(referenceFile);
      const dataUrl = await fileToDataURL(referenceFile); // For display

      const tempAnalysisCanvas = document.createElement('canvas');
      const tempAnalysisCtx = tempAnalysisCanvas.getContext('2d', { willReadFrequently: true });
      if (!tempAnalysisCtx) throw new Error("Could not get analysis canvas context.");

      let analysisWidth = imgEl.naturalWidth;
      let analysisHeight = imgEl.naturalHeight;
      if (imgEl.naturalWidth > ANALYSIS_MAX_DIMENSION || imgEl.naturalHeight > ANALYSIS_MAX_DIMENSION) {
        const scaleFactor = (imgEl.naturalWidth > imgEl.naturalHeight)
          ? ANALYSIS_MAX_DIMENSION / imgEl.naturalWidth
          : ANALYSIS_MAX_DIMENSION / imgEl.naturalHeight;
        analysisWidth = Math.round(imgEl.naturalWidth * scaleFactor);
        analysisHeight = Math.round(imgEl.naturalHeight * scaleFactor);
      }
      analysisWidth = Math.max(1, analysisWidth);
      analysisHeight = Math.max(1, analysisHeight);
      
      tempAnalysisCanvas.width = analysisWidth;
      tempAnalysisCanvas.height = analysisHeight;
      tempAnalysisCtx.drawImage(imgEl, 0, 0, analysisWidth, analysisHeight);
      const analysisImageData = tempAnalysisCtx.getImageData(0, 0, analysisWidth, analysisHeight);
      
      const detectedStars = detectStars(analysisImageData);
      addLog(`Auto-detected ${detectedStars.length} stars in reference image (${referenceFile.name}).`);
      
      setCurrentAnalysisStars(detectedStars);
      initialAutoDetectedStarsRef.current = [...detectedStars]; // Save for reset
      setReferenceImagePreviewForStarEditing(dataUrl);
      setCurrentAnalysisImageDimensions({ width: analysisWidth, height: analysisHeight });
      setIsAwaitingStarConfirmation(true);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLog(`[ERROR] Failed to analyze reference image: ${errorMessage}`);
      toast({ title: "Analysis Failed", description: errorMessage, variant: "destructive" });
    } finally {
      setIsAnalyzingForStars(false);
    }
  };
  
  const handleStarAnnotationClick = (clickedX: number, clickedY: number) => {
    if (!currentAnalysisImageDimensions) return;

    let starFoundAndRemoved = false;
    const updatedStars = currentAnalysisStars.filter(star => {
      const dx = star.x - clickedX;
      const dy = star.y - clickedY;
      const distSq = dx * dx + dy * dy;
      if (distSq < STAR_CLICK_TOLERANCE_ANALYSIS_UNITS_SQUARED) {
        starFoundAndRemoved = true;
        addLog(`Removed star at (${star.x.toFixed(0)}, ${star.y.toFixed(0)}).`);
        return false; // Remove this star
      }
      return true; // Keep this star
    });

    if (!starFoundAndRemoved) {
      const newStar: Star = {
        x: clickedX,
        y: clickedY,
        brightness: DEFAULT_STAR_BRIGHTNESS_THRESHOLD_COMBINED + 1, // Give it a decent brightness
        isManuallyAdded: true,
      };
      updatedStars.push(newStar);
      addLog(`Added manual star at (${clickedX.toFixed(0)}, ${clickedY.toFixed(0)}). Total stars: ${updatedStars.length}`);
    } else {
       addLog(`Total stars after removal: ${updatedStars.length}`);
    }
    setCurrentAnalysisStars(updatedStars);
  };

  const handleResetStars = () => {
    setCurrentAnalysisStars([...initialAutoDetectedStarsRef.current]);
    addLog(`Stars reset to ${initialAutoDetectedStarsRef.current.length} auto-detected stars.`);
    toast({title: "Stars Reset", description: "Star selection has been reset to automatically detected."});
  };

  // Step 2: Main stacking logic, now called after star confirmation
  const handleConfirmStarsAndStack = async () => {
    setIsAwaitingStarConfirmation(false); // Exit editing mode
    setIsProcessing(true); // Start actual stacking
    setProgressPercent(0);
    // Logs were reset in handleAnalyzeAndEditStars or should be selectively cleared.
    // For now, we'll append. If handleAnalyzeAndEditStars resets logs, this is fine.
    // If not, consider adding: setLogs([]); logIdCounter.current = 0; here for stacking specific logs.

    addLog(`Starting image stacking with user-confirmed/modified stars for reference. Mode: ${stackingMode}. Output: ${outputFormat.toUpperCase()}. Files: ${uploadedFiles.length}.`);
    addLog(`Using ${currentAnalysisStars.length} stars for reference image alignment.`);
    addLog(`Star Alignment: Min Stars = ${MIN_STARS_FOR_ALIGNMENT}.`);
    addLog(`Star Detection Params (for other images): Combined Brightness Threshold = ${DEFAULT_STAR_BRIGHTNESS_THRESHOLD_COMBINED}, Local Contrast Factor = ${DEFAULT_STAR_LOCAL_CONTRAST_FACTOR}.`);
    addLog(`Brightness Centroid Fallback Threshold: ${BRIGHTNESS_CENTROID_FALLBACK_THRESHOLD_GRAYSCALE_EQUIVALENT} (grayscale equivalent).`);

    if (typeof window === 'undefined' || typeof document === 'undefined') {
        const envErrorMsg = "Stacking cannot proceed outside a browser environment.";
        addLog(`[ERROR] ${envErrorMsg}`);
        toast({ title: "Environment Error", description: envErrorMsg, variant: "destructive" });
        setIsProcessing(false);
        return;
    }

    if (uploadedFiles.length < 2 && currentAnalysisStars.length > 0) {
        addLog("[INFO] Only one image uploaded. Will process it as a single frame (no stacking). Useful for previewing alignment points on a single image if desired, though alignment isn't applied to one image.");
        // Potentially allow "stacking" a single image to just save it in the target format/size
        // For now, let's assume stacking needs >=2 or user is just testing star selection
    } else if (uploadedFiles.length < 2) {
         const notEnoughMsg = "Please upload at least two images for stacking.";
         addLog(`[WARN] ${notEnoughMsg}`);
         toast({ title: "Not Enough Images", description: notEnoughMsg });
         setIsProcessing(false);
         return;
    }


    const filesToProcess = uploadedFiles;
    setProgressPercent(PROGRESS_INITIAL_SETUP);
    addLog(`Initial setup complete. Progress: ${PROGRESS_INITIAL_SETUP}%.`);

    try {
      let imageElements: HTMLImageElement[] = [];
      addLog(`Loading ${filesToProcess.length} image elements...`);
      for (const f of filesToProcess) {
        try {
          const imgEl = await loadImage(f.file);
          imageElements.push(imgEl);
        } catch (loadError) {
           const errorMessage = loadError instanceof Error ? loadError.message : String(loadError);
           addLog(`[LOAD ERROR] ${f.file.name}: ${errorMessage}`);
           toast({ title: `Error Loading ${f.file.name}`, description: errorMessage, variant: "destructive" });
        }
      }
      addLog(`Successfully loaded ${imageElements.length} out of ${filesToProcess.length} images into HTMLImageElements.`);

      if (imageElements.length < 2) {
        const notEnoughValidMsg = `Need at least two valid images (out of ${filesToProcess.length} processed) for stacking after filtering. Found ${imageElements.length}.`;
        addLog(`[ERROR] ${notEnoughValidMsg}`);
        toast({ title: "Not Enough Valid Images", description: notEnoughValidMsg, variant: "destructive" });
        setIsProcessing(false);
        setProgressPercent(0);
        return;
      }

      const firstImage = imageElements[0];
      if (!firstImage || firstImage.naturalWidth === 0 || firstImage.naturalHeight === 0) {
        const invalidRefMsg = `The first image (${filesToProcess[0]?.file.name || 'unknown'}) is invalid or empty. Cannot proceed.`;
        addLog(`[ERROR] ${invalidRefMsg}`);
        toast({ title: "Invalid Reference Image", description: invalidRefMsg, variant: "destructive" });
        setIsProcessing(false);
        setProgressPercent(0);
        return;
      }

      let targetWidth = firstImage.naturalWidth;
      let targetHeight = firstImage.naturalHeight;
      addLog(`Reference image dimensions: ${targetWidth}x${targetHeight}.`);

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
        const capMsg = `Stacking resolution capped to ${targetWidth}x${targetHeight} (original: ${firstImage.naturalWidth}x${firstImage.naturalHeight}).`;
        addLog(`[INFO] ${capMsg}`);
        toast({ title: "Stacking Resolution Capped", description: capMsg, duration: 9000 });
      }
      addLog(`Target stacking dimensions: ${targetWidth}x${targetHeight}.`);
      if (targetWidth === 0 || targetHeight === 0) {
        const zeroDimMsg = "Calculated target stacking dimensions are zero. Cannot proceed.";
        addLog(`[ERROR] ${zeroDimMsg}`);
        toast({ title: "Error", description: zeroDimMsg, variant: "destructive" });
        setIsProcessing(false);
        setProgressPercent(0);
        return;
      }

      const numImages = imageElements.length;
      const totalPixels = targetWidth * targetHeight;
      const normalizedImageFactor = Math.min(1, numImages / 20); // Normalize based on 20 images being "a lot"
      const maxPossiblePixels = (MAX_STACKING_SIDE_LENGTH || 1) * (MAX_STACKING_SIDE_LENGTH || 1); // Avoid division by zero
      const normalizedPixelFactor = Math.min(1, totalPixels / maxPossiblePixels);
      const loadScore = (0.3 * normalizedImageFactor) + (0.7 * normalizedPixelFactor); // Weight pixels more
      const dynamicDelayMs = Math.max(1, Math.min(50, 1 + Math.floor(loadScore * 49))); // Scale between 1ms and 50ms
      addLog(`Calculated dynamic yield delay: ${dynamicDelayMs}ms (Load score: ${loadScore.toFixed(2)}, Images: ${numImages}, Pixels: ${totalPixels})`);


      const offscreenCanvas = document.createElement('canvas');
      offscreenCanvas.width = targetWidth;
      offscreenCanvas.height = targetHeight;
      const ctx = offscreenCanvas.getContext('2d', { willReadFrequently: true });

      const tempAnalysisCanvas = document.createElement('canvas'); // Re-use for each image analysis
      const tempAnalysisCtx = tempAnalysisCanvas.getContext('2d', { willReadFrequently: true });

      if (!ctx || !tempAnalysisCtx) {
        const canvasError = "Could not get canvas contexts for stacking.";
        addLog(`[ERROR] ${canvasError}`);
        throw new Error(canvasError);
      }
      addLog(`Canvas contexts obtained.`);

      const centroids: ({ x: number; y: number } | null)[] = [];
      let successfulStarAlignments = 0;
      const centroidProgressIncrement = imageElements.length > 0 ? PROGRESS_CENTROID_CALCULATION_TOTAL / imageElements.length : 0;

      addLog(`Starting centroid calculation for ${imageElements.length} images...`);
      for (let i = 0; i < imageElements.length; i++) {
        const imgEl = imageElements[i];
        const fileNameForLog = filesToProcess[i]?.file?.name || `image ${i}`;
        let finalScaledCentroid: { x: number; y: number } | null = null;
        let method = "unknown";
        let starsForThisImage: Star[] = [];

        if (!imgEl || imgEl.naturalWidth === 0 || imgEl.naturalHeight === 0) {
            const skipMsg = `Skipping analysis for invalid image element ${i}: ${fileNameForLog}. Using target geometric center.`;
            console.warn(skipMsg);
            addLog(`[ALIGN WARN] ${skipMsg}`);
            finalScaledCentroid = { x: targetWidth / 2, y: targetHeight / 2 }; // Use target center
            method = "invalid_element_fallback";
            centroids.push(finalScaledCentroid);
            addLog(`[ALIGN] Image ${i} (${fileNameForLog}) centroid (scaled to target): ${finalScaledCentroid.x.toFixed(2)}, ${finalScaledCentroid.y.toFixed(2)} (Method: ${method})`);
            await yieldToEventLoop(dynamicDelayMs);
            setProgressPercent(prev => Math.min(100, prev + centroidProgressIncrement));
            continue;
        }

        try {
          addLog(`[ALIGN] Analyzing image ${i} (${fileNameForLog}): ${imgEl.naturalWidth}x${imgEl.naturalHeight}`);
          let analysisWidth = imgEl.naturalWidth;
          let analysisHeight = imgEl.naturalHeight;
          let analysisScaleFactor = 1.0; // Scale from original image to analysis image

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
            addLog(`[ALIGN] Image ${fileNameForLog} scaled for analysis to ${analysisWidth.toFixed(0)}x${analysisHeight.toFixed(0)} (factor: ${analysisScaleFactor.toFixed(3)})`);
          }
          analysisWidth = Math.max(1, Math.round(analysisWidth));
          analysisHeight = Math.max(1, Math.round(analysisHeight));
          
          if (i === 0 && currentAnalysisStars.length > 0 && currentAnalysisImageDimensions) {
             // Use user-confirmed stars for the reference image
            starsForThisImage = currentAnalysisStars;
            // Ensure analysisWidth/Height match what currentAnalysisStars were based on
            analysisWidth = currentAnalysisImageDimensions.width;
            analysisHeight = currentAnalysisImageDimensions.height;
            // analysisScaleFactor needs to be recalculated if imgEl natural dims were different from currentAnalysisImageDimensions basis
            // This assumes currentAnalysisImageDimensions ARE the dimensions of the analysis image.
            if (imgEl.naturalWidth !== analysisWidth || imgEl.naturalHeight !== analysisHeight) {
                // This case should ideally not happen if currentAnalysisImageDimensions is set correctly.
                // We might need to re-calc analysisScaleFactor if imgEl.natural * scaleFactor = analysisWidth/Height from currentAnalysisImageDimensions
                 analysisScaleFactor = analysisWidth / imgEl.naturalWidth; // Assuming aspect ratio is maintained
            }

            addLog(`[ALIGN] Using ${starsForThisImage.length} user-confirmed/modified stars for reference image ${fileNameForLog}.`);
          } else {
            // Auto-detect for other images or if reference image had no user stars
            tempAnalysisCanvas.width = analysisWidth;
            tempAnalysisCanvas.height = analysisHeight;
            tempAnalysisCtx.clearRect(0, 0, analysisWidth, analysisHeight);
            tempAnalysisCtx.drawImage(imgEl, 0, 0, analysisWidth, analysisHeight);
            let analysisImageData: ImageData | null = null;
            try {
                analysisImageData = tempAnalysisCtx.getImageData(0, 0, analysisWidth, analysisHeight);
            } catch (getImageDataError) {
                 const err = getImageDataError instanceof Error ? getImageDataError.message : String(getImageDataError);
                 const getImageDataMsg = `Error getting image data for analysis canvas (${fileNameForLog}): ${err}. Aligning to geometric center.`;
                 console.error(getImageDataMsg);
                 addLog(`[ALIGN ERROR] ${getImageDataMsg}`);
                 toast({ title: `Analysis Error (getImageData) for ${fileNameForLog}`, description: `Could not get pixel data for analysis. It may not align optimally. Error: ${err}`, variant: "destructive"});
                method = "getImageData_error";
            }
            if (analysisImageData) {
                starsForThisImage = detectStars(analysisImageData);
                addLog(`[ALIGN] Auto-detected ${starsForThisImage.length} star(s) in ${fileNameForLog} (analysis size ${analysisWidth}x${analysisHeight}).`);
            }
          }
          
          let analysisImageCentroid = calculateStarArrayCentroid(starsForThisImage, addLog);

          if (analysisImageCentroid) {
              method = i === 0 && currentAnalysisStars.length > 0 ? `user-star-based` : `auto-star-based`;
              successfulStarAlignments++;
          } else {
            const reason = starsForThisImage.length < MIN_STARS_FOR_ALIGNMENT ? `only ${starsForThisImage.length} stars (min ${MIN_STARS_FOR_ALIGNMENT} required)` : "star detection/centroid failed";
            method = `brightness-based fallback (${reason})`;
            addLog(`[ALIGN WARN] Star-based centroid failed for ${fileNameForLog} (${reason}). Falling back to brightness-based centroid.`);
            
            // Ensure tempAnalysisCanvas has the image data if not already drawn (e.g. for i===0 with user stars)
            if (!(i === 0 && currentAnalysisStars.length > 0)) { // if it wasn't user stars, it was drawn
              // it was drawn already by auto-detect path
            } else { // for i===0 with user stars, analysisImageData might not be populated for brightness fallback yet
                tempAnalysisCanvas.width = analysisWidth;
                tempAnalysisCanvas.height = analysisHeight;
                tempAnalysisCtx.clearRect(0, 0, analysisWidth, analysisHeight);
                tempAnalysisCtx.drawImage(imgEl, 0, 0, analysisWidth, analysisHeight);
            }
            const fallbackImageData = tempAnalysisCtx.getImageData(0, 0, analysisWidth, analysisHeight);
            analysisImageCentroid = calculateBrightnessCentroid(fallbackImageData, addLog);
          }

          if (analysisImageCentroid) {
            // Convert centroid from analysis image coords back to original image coords
            const nativeEquivalentCentroid = {
                x: analysisImageCentroid.x / analysisScaleFactor,
                y: analysisImageCentroid.y / analysisScaleFactor,
            };
            // Scale native centroid to target stacking dimensions
            finalScaledCentroid = {
                x: nativeEquivalentCentroid.x * (targetWidth / imgEl.naturalWidth),
                y: nativeEquivalentCentroid.y * (targetHeight / imgEl.naturalHeight),
            };
          }

        } catch (imgAnalysisError) {
            const errorMessage = imgAnalysisError instanceof Error ? imgAnalysisError.message : String(imgAnalysisError);
            addLog(`[ALIGN ERROR] Error analyzing image ${fileNameForLog}: ${errorMessage}. Aligning to geometric center.`);
            toast({ title: `Analysis Error for ${fileNameForLog}`, description: `Could not analyze image: ${errorMessage}. It may not align optimally.`, variant: "destructive" });
            method = "analysis_error";
        }

        if (!finalScaledCentroid) {
            const noCentroidMsg = `Could not determine any centroid for ${fileNameForLog}. It will be aligned to target geometric center.`;
            addLog(`[ALIGN ERROR] ${noCentroidMsg}`);
            toast({ title: "Centroid Failed", description: noCentroidMsg, variant: "destructive" });
            finalScaledCentroid = { x: targetWidth / 2, y: targetHeight / 2 }; // Fallback to target geometric center
            method = method.includes("_error") || method === "unknown" ? `${method}_geometric_fallback` : "geometric_center_fallback";
        }
        addLog(`[ALIGN] Image ${i} (${fileNameForLog}) centroid (scaled to target): ${finalScaledCentroid.x.toFixed(2)}, ${finalScaledCentroid.y.toFixed(2)} (Method: ${method})`);
        centroids.push(finalScaledCentroid);
        setProgressPercent(prev => Math.min(100, prev + centroidProgressIncrement));
        await yieldToEventLoop(dynamicDelayMs);
      }
      addLog(`Centroid calculation complete. ${successfulStarAlignments}/${imageElements.length} images primarily used star-based alignment.`);

      const referenceCentroid = centroids[0];
      if (!referenceCentroid) {
        const noRefMsg = "Could not determine alignment reference for the first image. Stacking cannot proceed.";
        addLog(`[ERROR] ${noRefMsg}`);
        toast({ title: "Alignment Failed", description: noRefMsg, variant: "destructive" });
        setIsProcessing(false);
        setProgressPercent(0);
        return;
      }
      addLog(`[ALIGN] Reference centroid (from image 0): ${referenceCentroid.x.toFixed(2)}, ${referenceCentroid.y.toFixed(2)}`);

      const finalImageData = ctx.createImageData(targetWidth, targetHeight);
      let validImagesStackedCount = 0;

      addLog(`Starting band processing for stacking. Band height: ${STACKING_BAND_HEIGHT}px. Mode: ${stackingMode}.`);

      const numBands = targetHeight > 0 ? Math.ceil(targetHeight / STACKING_BAND_HEIGHT) : 0;
      const bandProgressIncrement = numBands > 0 ? PROGRESS_BANDED_STACKING_TOTAL / numBands : 0;

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
            addLog(`[STACK SKIP] Skipping invalid image element ${i} during band processing.`);
            continue;
          }
          const currentCentroid = centroids[i];

          let dx = 0;
          let dy = 0;

          if (currentCentroid) {
            dx = referenceCentroid.x - currentCentroid.x;
            dy = referenceCentroid.y - currentCentroid.y;
          } else {
            addLog(`[STACK WARN] Image ${i} (${filesToProcess[i]?.file?.name}) had no centroid for offset calculation. Using 0,0 offset (no alignment).`);
          }
          
          // Draw the current image (shifted) onto the offscreenCanvas's context (ctx)
          // which is sized to targetWidth, targetHeight
          ctx.clearRect(0, 0, targetWidth, targetHeight); // Clear for current image draw
          ctx.drawImage(img, dx, dy, targetWidth, targetHeight); // Draw shifted & scaled

          try {
            // Get pixel data for the current band from the offscreenCanvas
            const bandFrameImageData = ctx.getImageData(0, yBandStart, targetWidth, currentBandHeight);
            const bandData = bandFrameImageData.data;

            for (let j = 0; j < bandData.length; j += 4) {
              const bandPixelIndex = j / 4; // Index within the bandPixelDataCollector array
              if (bandPixelDataCollector[bandPixelIndex]) { // Ensure index is valid
                  bandPixelDataCollector[bandPixelIndex].r.push(bandData[j]);
                  bandPixelDataCollector[bandPixelIndex].g.push(bandData[j + 1]);
                  bandPixelDataCollector[bandPixelIndex].b.push(bandData[j + 2]);
              }
            }
            if (yBandStart === 0) { // Only count for the first band to get a general sense
              imagesContributingToBand++;
            }
          } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            const bandErrorMsg = `Error getting image data for band (img ${i}, bandY ${yBandStart}): ${errorMsg}`;
            addLog(`[STACK ERROR] ${bandErrorMsg}`);
            toast({ title: `Stacking Error on Band Processing`, description: `Could not process pixel data for ${filesToProcess[i]?.file.name || `image ${i}`} for band at row ${yBandStart}.`, variant: "destructive"});
          }
           await yieldToEventLoop(dynamicDelayMs); // Yield inside the image loop for very large images/many images
        }
        if (yBandStart === 0) { // Log count after processing all images for the first band
            validImagesStackedCount = imagesContributingToBand;
            addLog(`[STACK] ${validImagesStackedCount} images contributed to the first band.`);
        }

        // Process collected pixel data for the band
        for (let yInBand = 0; yInBand < currentBandHeight; yInBand++) {
          for (let x = 0; x < targetWidth; x++) {
              const bandPixelIndex = yInBand * targetWidth + x;
              const finalPixelGlobalIndex = ((yBandStart + yInBand) * targetWidth + x) * 4;

              if (bandPixelDataCollector[bandPixelIndex] && bandPixelDataCollector[bandPixelIndex].r.length > 0) {
                if (stackingMode === 'median') {
                  finalImageData.data[finalPixelGlobalIndex] = getMedian(bandPixelDataCollector[bandPixelIndex].r);
                  finalImageData.data[finalPixelGlobalIndex + 1] = getMedian(bandPixelDataCollector[bandPixelIndex].g);
                  finalImageData.data[finalPixelGlobalIndex + 2] = getMedian(bandPixelDataCollector[bandPixelIndex].b);
                } else { // sigmaClip
                  finalImageData.data[finalPixelGlobalIndex] = applySigmaClip(bandPixelDataCollector[bandPixelIndex].r);
                  finalImageData.data[finalPixelGlobalIndex + 1] = applySigmaClip(bandPixelDataCollector[bandPixelIndex].g);
                  finalImageData.data[finalPixelGlobalIndex + 2] = applySigmaClip(bandPixelDataCollector[bandPixelIndex].b);
                }
                finalImageData.data[finalPixelGlobalIndex + 3] = 255; // Alpha
              } else {
                  // Fallback for pixels with no data (should be rare if images cover area)
                  finalImageData.data[finalPixelGlobalIndex] = 0;
                  finalImageData.data[finalPixelGlobalIndex + 1] = 0;
                  finalImageData.data[finalPixelGlobalIndex + 2] = 0;
                  finalImageData.data[finalPixelGlobalIndex + 3] = 255;
              }
          }
        }
        // Log progress periodically and yield
        if (yBandStart % (STACKING_BAND_HEIGHT * 5) === 0 || yBandStart + currentBandHeight >= targetHeight ) {
             addLog(`Processed band: rows ${yBandStart} to ${yBandStart + currentBandHeight - 1}. Yielding.`);
        }
        setProgressPercent(prev => Math.min(100, prev + bandProgressIncrement));
        await yieldToEventLoop(dynamicDelayMs); // Yield after each band is fully processed
      }

      setProgressPercent(100); // Mark as 100% before final image generation
      addLog(`All bands processed. Finalizing image.`);

      if (validImagesStackedCount === 0 && imageElements.length > 0) {
        const noStackMsg = "No images could be successfully processed during band stacking.";
        addLog(`[ERROR] ${noStackMsg}`);
        toast({ title: "Stacking Failed", description: noStackMsg, variant: "destructive" });
        setIsProcessing(false);
        setProgressPercent(0);
        return;
      }
      
      // Put the final composited image data onto the offscreenCanvas
      ctx.putImageData(finalImageData, 0, 0);

      let resultDataUrl: string;
      let outputMimeType = 'image/png';
      if (outputFormat === 'jpeg') {
        outputMimeType = 'image/jpeg';
        resultDataUrl = offscreenCanvas.toDataURL(outputMimeType, jpegQuality / 100);
        addLog(`Generated JPEG image (Quality: ${jpegQuality}%).`);
      } else { // PNG
        resultDataUrl = offscreenCanvas.toDataURL(outputMimeType);
        addLog(`Generated PNG image.`);
      }

      if (!resultDataUrl || resultDataUrl === "data:," || resultDataUrl.length < MIN_VALID_DATA_URL_LENGTH) {
        const previewFailMsg = `Could not generate a valid image preview in ${outputFormat.toUpperCase()} format.`;
        addLog(`[ERROR] ${previewFailMsg}`);
        toast({ title: "Preview Generation Failed", description: previewFailMsg, variant: "destructive" });
        setStackedImage(null);
      } else {
        setStackedImage(resultDataUrl);
        const alignmentMessage = successfulStarAlignments > 0
          ? `${successfulStarAlignments}/${imageElements.length} images primarily aligned using star-based centroids.`
          : `All images aligned using brightness-based centroids or geometric centers.`;
        
        const stackingMethodUsed = stackingMode === 'median' ? 'Median' : 'Sigma Clip';
        const successToastMsg = `${alignmentMessage} ${validImagesStackedCount} image(s) (out of ${imageElements.length} processed) stacked. Dim: ${targetWidth}x${targetHeight}.`;
        addLog(`Stacking complete. ${successToastMsg}`);
        toast({
          title: `${stackingMethodUsed} Stacking Complete (${outputFormat.toUpperCase()})`,
          description: successToastMsg,
          duration: 10000,
        });
      }

    } catch (error) {
      console.error("Unhandled error in handleStackImages:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLog(`[FATAL ERROR] Stacking Process Failed: ${errorMessage}.`);
      toast({
        title: "Stacking Process Failed",
        description: `An unexpected error occurred: ${errorMessage}. Check console and logs.`,
        variant: "destructive",
      });
      setStackedImage(null); // Clear any previous stacked image
    } finally {
      setIsProcessing(false); // Stacking finished
      setProgressPercent(0); // Reset progress
      addLog("Image stacking process finished.");
      console.log("Image stacking process finished.");
    }
  };
  

  useEffect(() => {
    // Cleanup if needed when component unmounts
    return () => {
      // e.g., revoke Object URLs if they were used
    };
  }, []);

  const canStartStacking = uploadedFiles.length > 0;
  const isUiDisabled = isProcessing || isAnalyzingForStars || isAwaitingStarConfirmation;


  return (
    <div className="flex flex-col min-h-screen bg-background">
      <AppHeader />
      <main className="flex-grow container mx-auto py-6 px-2 sm:px-4 md:px-6">
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Control Panel Column */}
          <div className="w-full lg:w-2/5 xl:w-1/3 space-y-6">
            <Card className="shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center text-xl font-headline">
                  <StarIcon className="mr-2 h-5 w-5 text-accent" />
                  Upload & Align Images
                </CardTitle>
                <CardDescription>
                 Add PNG, JPG, GIF, or WEBP. TIFF/DNG files require manual pre-conversion (e.g., using <a href="https://convertio.co/kr/tiff-png/" target="_blank" rel="noopener noreferrer" className="underline hover:text-accent">Convertio</a>). 
                 Images are aligned using star-based centroids or brightness centroids.
                 Edit detected stars on the reference image after uploading.
                  Median stacking uses median pixel values. Sigma Clip stacking iteratively removes outliers and averages the rest. Both processed in bands for stability.
                  Star detection: Brightness Threshold (Combined R+G+B) = {DEFAULT_STAR_BRIGHTNESS_THRESHOLD_COMBINED}, Local Contrast Factor = {DEFAULT_STAR_LOCAL_CONTRAST_FACTOR}. Min Stars for Alignment = {MIN_STARS_FOR_ALIGNMENT}.
                  Brightness centroid fallback threshold: {BRIGHTNESS_CENTROID_FALLBACK_THRESHOLD_GRAYSCALE_EQUIVALENT} (grayscale equivalent).
                  Analysis for star detection on images larger than {ANALYSIS_MAX_DIMENSION}px is scaled (current max analysis side: {ANALYSIS_MAX_DIMENSION}px).
                  Max image load: {MAX_IMAGE_LOAD_DIMENSION}px.
                  Stacking resolution capped near {MAX_STACKING_SIDE_LENGTH}px.
                  Processing can be slow/intensive. Sigma Clip is generally slower than Median.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {!isAwaitingStarConfirmation ? (
                  <>
                    <ImageUploadArea onFilesAdded={handleFilesAdded} isProcessing={isProcessing || isAnalyzingForStars} />

                    {(isProcessing || isAnalyzingForStars) && progressPercent > 0 && (
                      <div className="space-y-2">
                        <Progress value={progressPercent} className="w-full" />
                        <p className="text-sm text-center text-muted-foreground">{Math.round(progressPercent)}% Complete</p>
                      </div>
                    )}
                     {isAnalyzingForStars && !progressPercent && (
                        <div className="flex items-center justify-center space-x-2 py-2">
                            <RefreshCcw className="h-5 w-5 animate-spin text-accent" />
                            <p className="text-sm text-muted-foreground">Analyzing reference image for stars...</p>
                        </div>
                    )}


                    {uploadedFiles.length > 0 && (
                      <>
                        <h3 className="text-lg font-semibold mt-4 text-foreground">Image Queue ({uploadedFiles.length})</h3>
                        <ScrollArea className="h-64 border rounded-md p-2 bg-background/30">
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {uploadedFiles.map((uploadedFile, index) => (
                              <ImageQueueItem
                                key={`${uploadedFile.file.name}-${index}`} // Ensure unique key
                                file={uploadedFile.file}
                                previewUrl={uploadedFile.previewUrl}
                                onRemove={() => handleRemoveImage(index)}
                                isProcessing={isUiDisabled}
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
                            disabled={isUiDisabled}
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

                        <div className="space-y-2 pt-2">
                          <Label className="text-base font-semibold text-foreground">Preview Fit (Final Image)</Label>
                          <RadioGroup
                            value={previewFitMode}
                            onValueChange={(value: string) => setPreviewFitMode(value as PreviewFitMode)}
                            className="flex space-x-4"
                            disabled={isUiDisabled}
                          >
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="contain" id="fit-contain" />
                              <Label htmlFor="fit-contain" className="cursor-pointer">Fit (Show Full)</Label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="cover" id="fit-cover" />
                              <Label htmlFor="fit-cover" className="cursor-pointer">Fill (Cover Area)</Label>
                            </div>
                          </RadioGroup>
                          <p className="text-xs text-muted-foreground">
                            'Fit' shows the entire image. 'Fill' covers the preview area, potentially cropping.
                          </p>
                        </div>

                        <div className="space-y-2 pt-2">
                          <Label className="text-base font-semibold text-foreground">Output Format</Label>
                          <RadioGroup
                            value={outputFormat}
                            onValueChange={(value: string) => setOutputFormat(value as OutputFormat)}
                            className="flex space-x-4"
                            disabled={isUiDisabled}
                          >
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="png" id="format-png" />
                              <Label htmlFor="format-png" className="cursor-pointer">PNG</Label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="jpeg" id="format-jpeg" />
                              <Label htmlFor="format-jpeg" className="cursor-pointer">JPG</Label>
                            </div>
                          </RadioGroup>
                          <p className="text-xs text-muted-foreground">
                            PNG offers lossless quality. JPG is smaller but lossy.
                          </p>
                        </div>

                        {outputFormat === 'jpeg' && (
                          <div className="space-y-2 pt-2">
                            <Label htmlFor="jpegQualitySlider" className="text-base font-semibold text-foreground">
                              JPG Quality: {jpegQuality}%
                            </Label>
                            <Slider
                              id="jpegQualitySlider"
                              min={10}
                              max={100}
                              step={1}
                              value={[jpegQuality]}
                              onValueChange={(value) => setJpegQuality(value[0])}
                              disabled={isUiDisabled}
                              className="w-[60%]"
                            />
                             <p className="text-xs text-muted-foreground">
                              Higher quality means larger file size. Recommended: 85-95.
                            </p>
                          </div>
                        )}

                        <Button
                          onClick={handleAnalyzeAndEditStars}
                          disabled={!canStartStacking || isUiDisabled}
                          className="w-full bg-accent hover:bg-accent/90 text-accent-foreground mt-4"
                          title={!canStartStacking ? "Upload at least one image" : (uploadedFiles.length < 2 ? "Edit stars for single image (stacking needs >=2)" : "Edit Stars & Proceed to Stack")}
                        >
                          <Edit3 className="mr-2 h-5 w-5" />
                          {isAnalyzingForStars ? 'Analyzing Stars...' : (uploadedFiles.length < 2 ? 'Edit Stars on Reference' : 'Edit Stars & Stack')}
                        </Button>
                      </>
                    )}
                  </>
                ) : (
                  // Star Editing UI
                  <div className="space-y-4">
                     <Alert>
                        <StarIcon className="h-4 w-4 text-accent" />
                        <AlertTitle>Edit Stars for Reference Image</AlertTitle>
                        <AlertDescription>
                            Click on the image to add a star (cyan circle). Click an existing star (red/cyan) to remove it.
                            Reference image: {uploadedFiles[0]?.file.name || 'Unknown'}.
                            Stars found/selected: {currentAnalysisStars.length}.
                        </AlertDescription>
                    </Alert>
                    {referenceImagePreviewForStarEditing && currentAnalysisImageDimensions && (
                      <StarAnnotationCanvas
                        imageUrl={referenceImagePreviewForStarEditing}
                        stars={currentAnalysisStars}
                        analysisWidth={currentAnalysisImageDimensions.width}
                        analysisHeight={currentAnalysisImageDimensions.height}
                        onCanvasClick={handleStarAnnotationClick}
                        canvasDisplayWidth={Math.min(500, currentAnalysisImageDimensions.width)} // Control display size
                      />
                    )}
                    <div className="flex flex-col sm:flex-row gap-2 pt-2">
                       <Button onClick={handleResetStars} variant="outline" className="flex-1">
                         <RefreshCcw className="mr-2 h-4 w-4" /> Reset to Auto-Detected
                       </Button>
                       <Button 
                        onClick={handleConfirmStarsAndStack} 
                        className="flex-1 bg-green-600 hover:bg-green-700 text-white"
                        disabled={uploadedFiles.length < 2 && currentAnalysisStars.length === 0} // Disable if only one image and no stars selected (stacking won't happen)
                        title={uploadedFiles.length < 2 ? "Stacking requires at least 2 images. Add more or this will just prepare the reference." : `Proceed to stack ${uploadedFiles.length} images`}
                       >
                         <CheckCircle className="mr-2 h-4 w-4" />
                         Confirm Stars & {uploadedFiles.length < 2 ? 'Prepare Reference' : `Stack (${uploadedFiles.length})`}
                       </Button>
                    </div>
                     <Button onClick={() => setIsAwaitingStarConfirmation(false)} variant="ghost" className="w-full text-muted-foreground">
                        Cancel Star Editing
                     </Button>
                  </div>
                )}

                {/* Processing Logs - shown in both modes if logs exist */}
                {logs.length > 0 && (
                  <Card className="mt-4">
                    <CardHeader className="p-3 border-b">
                      <CardTitle className="text-base flex items-center">
                        <ListChecks className="mr-2 h-4 w-4" />
                        Processing Logs
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      <ScrollArea ref={logContainerRef} className="h-48 p-3 text-xs bg-muted/20 rounded-b-md">
                        {logs.map((log) => (
                          <div key={log.id} className="mb-1 font-mono">
                            <span className="text-muted-foreground mr-2">{log.timestamp}</span>
                            <span className={log.message.startsWith('[ERROR]') ? 'text-destructive' : (log.message.startsWith('[WARN]') ? 'text-yellow-500' : 'text-foreground/80')}>{log.message}</span>
                          </div>
                        ))}
                      </ScrollArea>
                    </CardContent>
                  </Card>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Image Preview Column */}
          <div className="w-full lg:w-3/5 xl:w-2/3 flex flex-col space-y-6">
            <ImagePreview
              imageUrl={stackedImage}
              fitMode={previewFitMode}
            />
            <DownloadButton imageUrl={stackedImage} isProcessing={isProcessing || isAnalyzingForStars || isAwaitingStarConfirmation} />
          </div>
        </div>
      </main>
      <footer className="py-4 text-center text-sm text-muted-foreground border-t border-border">
        AstroStacker &copy; {new Date().getFullYear()}
      </footer>
    </div>
  );
}
