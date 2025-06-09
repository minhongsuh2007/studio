
"use client";

import type React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { fileToDataURL } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';

import { AppHeader } from '@/components/astrostacker/AppHeader';
import { ImageUploadArea } from '@/components/astrostacker/ImageUploadArea';
import { ImageQueueItem } from '@/components/astrostacker/ImageQueueItem';
import { ImagePreview } from '@/components/astrostacker/ImagePreview';
import { ImagePostProcessEditor } from '@/components/astrostacker/ImagePostProcessEditor';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Star as StarIcon, ListChecks, CheckCircle, RefreshCcw, Edit3, Loader2, Settings2, Orbit, Trash2, CopyCheck, AlertTriangle, Wand2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { StarAnnotationCanvas, type Star } from '@/components/astrostacker/StarAnnotationCanvas';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

// import { FitsParser } from "fitsjs"; // FITS processing removed
// import TIFF from "tiff.js"; // Removed static import, will be dynamically imported


interface LogEntry {
  id: number;
  timestamp: string;
  message: string;
}

export type StarSelectionMode = 'auto' | 'manual';

export interface ImageStarEntry {
  id: string;
  file: File;
  previewUrl: string;
  analysisStars: Star[];
  initialAutoStars: Star[];
  analysisDimensions: { width: number; height: number };
  userReviewed: boolean;
  isAnalyzed: boolean;
  isAnalyzing: boolean;
  starSelectionMode: StarSelectionMode;
}


type StackingMode = 'median' | 'sigmaClip';
type PreviewFitMode = 'contain' | 'cover';
type OutputFormat = 'png' | 'jpeg';

const MIN_VALID_DATA_URL_LENGTH = 100;
const STACKING_BAND_HEIGHT = 50;

const SIGMA_CLIP_THRESHOLD = 2.0;
const SIGMA_CLIP_ITERATIONS = 2;
const MIN_STARS_FOR_ALIGNMENT = 3;

const PROGRESS_INITIAL_SETUP = 5;
const PROGRESS_CENTROID_CALCULATION_TOTAL = 30;
const PROGRESS_BANDED_STACKING_TOTAL = 65;

const DEFAULT_STAR_BRIGHTNESS_THRESHOLD_COMBINED = 200;
const DEFAULT_STAR_LOCAL_CONTRAST_FACTOR = 1.6;
const BRIGHTNESS_CENTROID_FALLBACK_THRESHOLD_GRAYSCALE_EQUIVALENT = 30;

const STAR_ANNOTATION_MAX_DISPLAY_WIDTH = 500;
const STAR_CLICK_TOLERANCE_ON_DISPLAY_CANVAS_PX = 10;

const IS_LARGE_IMAGE_THRESHOLD_MP = 12;
const MAX_DIMENSION_DOWNSCALED = 2048;

const yieldToEventLoop = async (delayMs: number) => {
  await new Promise(resolve => setTimeout(resolve, delayMs));
};

const applyImageAdjustmentsToDataURL = async (
  baseDataUrl: string,
  brightness: number,
  exposure: number,
  saturation: number,
  outputFormat: 'png' | 'jpeg' = 'png',
  jpegQuality = 0.92
): Promise<string> => {
  if (!baseDataUrl) return baseDataUrl;

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error("Could not get canvas context for image adjustments."));
        return;
      }

      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      const bFactor = brightness / 100;
      const eFactor = Math.pow(2, exposure / 100);

      for (let i = 0; i < data.length; i += 4) {
        let r = data[i];
        let g = data[i + 1];
        let b = data[i + 2];

        r = Math.min(255, Math.max(0, r * eFactor * bFactor));
        g = Math.min(255, Math.max(0, g * eFactor * bFactor));
        b = Math.min(255, Math.max(0, b * eFactor * bFactor));

        if (saturation !== 100) {
          const sFactor = saturation / 100;
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          r = Math.min(255, Math.max(0, gray + sFactor * (r - gray)));
          g = Math.min(255, Math.max(0, gray + sFactor * (g - gray)));
          b = Math.min(255, Math.max(0, gray + sFactor * (b - gray)));
        }

        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      }
      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL(outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png', outputFormat === 'jpeg' ? jpegQuality : undefined));
    };
    img.onerror = (err) => {
      console.error("Error loading image for adjustments:", err);
      reject(new Error("Failed to load image for adjustments."));
    };
    img.src = baseDataUrl;
  });
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
    console.warn(`Detected a large number of stars (${stars.length}) during analysis.`);
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
  const variance = arr.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (arr.length -1);
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

  if (!currentValues.length) {
    return calculateMean(initialValues);
  }
  return calculateMean(currentValues);
};


export default function AstroStackerPage() {
  const { t } = useLanguage();
  const [allImageStarData, setAllImageStarData] = useState<ImageStarEntry[]>([]);
  const [stackedImage, setStackedImage] = useState<string | null>(null);
  const [isProcessingStack, setIsProcessingStack] = useState(false);
  const [stackingMode, setStackingMode] = useState<StackingMode>('median');
  const [previewFitMode, setPreviewFitMode] = useState<PreviewFitMode>('contain');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('png');
  const [jpegQuality, setJpegQuality] = useState<number>(92);
  const [progressPercent, setProgressPercent] = useState(0);
  const { toast } = useToast();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const logIdCounter = useRef(0);

  const [isStarEditingMode, setIsStarEditingMode] = useState(false);
  const [currentEditingImageIndex, setCurrentEditingImageIndex] = useState<number | null>(null);

  const [showApplyToAllDialog, setShowApplyToAllDialog] = useState(false);
  const [starsToApplyToAll, setStarsToApplyToAll] = useState<Star[] | null>(null);
  const [sourceImageIdForApplyToAll, setSourceImageIdForApplyToAll] = useState<string | null>(null);
  const [analysisDimensionsToApplyToAll, setAnalysisDimensionsToApplyToAll] = useState<{width: number, height: number} | null>(null);

  const [showPostProcessEditor, setShowPostProcessEditor] = useState(false);
  const [imageForPostProcessing, setImageForPostProcessing] = useState<string | null>(null);
  const [editedPreviewUrl, setEditedPreviewUrl] = useState<string | null>(null);
  const [isApplyingAdvancedStars, setIsApplyingAdvancedStars] = useState(false);
  const [brightness, setBrightness] = useState(100);
  const [exposure, setExposure] = useState(0);
  const [saturation, setSaturation] = useState(100);
  const [isApplyingAdjustments, setIsApplyingAdjustments] = useState(false);

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

  useEffect(() => {
    if (!imageForPostProcessing || !showPostProcessEditor) {
      return;
    }

    const applyAdjustments = async () => {
      setIsApplyingAdjustments(true);
      try {
        const adjustedUrl = await applyImageAdjustmentsToDataURL(
          imageForPostProcessing,
          brightness,
          exposure,
          saturation,
          outputFormat,
          jpegQuality / 100
        );
        setEditedPreviewUrl(adjustedUrl);
      } catch (error) {
        console.error("Error applying image adjustments:", error);
        toast({
          title: "Adjustment Error",
          description: "Could not apply image adjustments.",
          variant: "destructive",
        });
        setEditedPreviewUrl(imageForPostProcessing);
      } finally {
        setIsApplyingAdjustments(false);
      }
    };

    const debounceTimeout = setTimeout(applyAdjustments, 300);
    return () => clearTimeout(debounceTimeout);

  }, [imageForPostProcessing, brightness, exposure, saturation, showPostProcessEditor, outputFormat, jpegQuality, toast]);


  const handleFilesAdded = async (files: File[]) => {
    let fileProcessingMessage = `Attempting to add ${files.length} file(s).`;
    if (files.length > 0) {
        fileProcessingMessage += ` First file: ${files[0].name}`;
    }
    addLog(fileProcessingMessage);

    const newEntriesPromises = files.map(async (file): Promise<ImageStarEntry | null> => {
      try {
        const fileType = file.type.toLowerCase();
        const fileName = file.name.toLowerCase();
        addLog(`Processing file: ${file.name} (Type: ${fileType || 'unknown'})`);

        const acceptedWebTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

        if (fileType === 'image/x-adobe-dng' || fileName.endsWith('.dng')) {
          const dngMsg = `${file.name} is a DNG. Manual conversion to JPG/PNG is recommended.`;
          addLog(`[WARN] ${dngMsg}`);
          toast({
            title: "DNG File Detected",
            description: dngMsg,
            variant: "default",
            duration: 8000,
          });
        }

        let originalPreviewUrl: string | null = null;
        let rawWidth = 0;
        let rawHeight = 0;

        if (fileName.endsWith(".fits")) {
            addLog(`[WARN] FITS file (${file.name}) processing is currently disabled. Please use other formats.`);
            toast({
              title: "FITS Processing Disabled",
              description: `FITS file (${file.name}) handling is currently unavailable. Please try other image formats like JPG, PNG, or TIFF.`,
              variant: "default",
            });
            return null; 
            // const buffer = await file.arrayBuffer();
            // const parser = new FitsParser(); // Usage of FitsParser
            // parser.parse(buffer); // Usage of FitsParser
            // const hdu = parser.getHDU(0); 
            // if (!hdu || !hdu.data || !hdu.data.data) throw new Error("Invalid FITS data structure.");

            // const dataUnit = hdu.data;
            // rawWidth = dataUnit.width;
            // rawHeight = dataUnit.height;
            // const floatData = Float32Array.from(dataUnit.data);

            // const canvas = document.createElement('canvas');
            // canvas.width = rawWidth;
            // canvas.height = rawHeight;
            // const ctx = canvas.getContext('2d');
            // if (!ctx) throw new Error('Could not get canvas context for FITS.');
            // const imageData = ctx.createImageData(rawWidth, rawHeight);

            // let min = floatData[0], max = floatData[0];
            // for (let k = 1; k < floatData.length; k++) {
            //     if (floatData[k] < min) min = floatData[k];
            //     if (floatData[k] > max) max = floatData[k];
            // }
            // const range = max - min === 0 ? 1 : max - min;

            // for (let k = 0; k < floatData.length; k++) {
            //     const norm = ((floatData[k] - min) / range) * 255;
            //     imageData.data[k * 4 + 0] = norm;
            //     imageData.data[k * 4 + 1] = norm;
            //     imageData.data[k * 4 + 2] = norm;
            //     imageData.data[k * 4 + 3] = 255;
            // }
            // ctx.putImageData(imageData, 0, 0);
            // originalPreviewUrl = canvas.toDataURL('image/png');
            // addLog(`FITS file ${file.name} processed to 8-bit PNG preview (${rawWidth}x${rawHeight}).`);

        } else if (fileName.endsWith(".tif") || fileName.endsWith(".tiff")) {
            addLog(`Processing TIFF file: ${file.name}`);
            const buffer = await file.arrayBuffer();
            const TIFFModule = (await import('tiff.js')).default;
            const tiff = new TIFFModule({ buffer });
            rawWidth = tiff.width();
            rawHeight = tiff.height();

            let floatData: Float32Array;

            if (tiff.isGrayscale()) {
                const samples = tiff.readSamples();
                if (samples && samples.length > 0 && samples[0]) {
                    const sampleData = samples[0];
                     if (sampleData instanceof Float32Array || sampleData instanceof Float64Array) {
                        floatData = Float32Array.from(sampleData);
                    } else {
                        floatData = new Float32Array(sampleData.length);
                        let maxVal = 0;
                        if (sampleData instanceof Uint16Array) maxVal = 65535;
                        else if (sampleData instanceof Uint32Array) maxVal = 4294967295;
                        else maxVal = 255;

                        for(let k=0; k < sampleData.length; k++) {
                           floatData[k] = sampleData[k] / maxVal;
                        }
                    }
                } else {
                    throw new Error("Could not read grayscale samples from TIFF.");
                }
            } else {
                const rgba = tiff.readRGBAImage();
                floatData = new Float32Array(rawWidth * rawHeight);
                for (let k = 0; k < floatData.length; k++) {
                    const r = rgba[k * 4 + 0];
                    const g = rgba[k * 4 + 1];
                    const b = rgba[k * 4 + 2];
                    floatData[k] = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
                }
            }

            const canvas = document.createElement('canvas');
            canvas.width = rawWidth;
            canvas.height = rawHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Could not get canvas context for TIFF.');
            const imageData = ctx.createImageData(rawWidth, rawHeight);

            let min = floatData[0], max = floatData[0];
            for (let k = 1; k < floatData.length; k++) {
                if (floatData[k] < min) min = floatData[k];
                if (floatData[k] > max) max = floatData[k];
            }
            const range = max - min === 0 ? 1 : max - min;

            for (let k = 0; k < floatData.length; k++) {
                const norm = ((floatData[k] - min) / range) * 255;
                imageData.data[k * 4 + 0] = norm;
                imageData.data[k * 4 + 1] = norm;
                imageData.data[k * 4 + 2] = norm;
                imageData.data[k * 4 + 3] = 255;
            }
            ctx.putImageData(imageData, 0, 0);
            originalPreviewUrl = canvas.toDataURL('image/png');
            addLog(`TIFF file ${file.name} processed to 8-bit PNG preview (${rawWidth}x${rawHeight}).`);

        } else if (acceptedWebTypes.includes(fileType)) {
            originalPreviewUrl = await fileToDataURL(file);
        } else {
            const unsupportedMsg = `${file.name} is unsupported. Use JPG, PNG, GIF, WEBP, FITS, or TIFF.`;
            addLog(`[ERROR] ${unsupportedMsg}`);
            toast({
                title: "Unsupported File Type",
                description: unsupportedMsg,
                variant: "destructive",
            });
            return null;
        }

        if (!originalPreviewUrl) {
             addLog(`[ERROR] Could not generate initial preview for ${file.name}.`);
             return null;
        }


        return new Promise<ImageStarEntry | null>((resolveEntry) => {
            const img = new Image();
            img.onload = async () => {
                const { naturalWidth, naturalHeight } = img;
                let processedPreviewUrl = originalPreviewUrl!;
                let finalDimensions = { width: naturalWidth, height: naturalHeight };

                if ((naturalWidth * naturalHeight) / (1000 * 1000) > IS_LARGE_IMAGE_THRESHOLD_MP) {
                    if (window.confirm(t('downscalePrompt', { fileName: file.name, width: naturalWidth, height: naturalHeight, maxSize: MAX_DIMENSION_DOWNSCALED }))) {
                        addLog(`User approved downscaling for ${file.name}. Original preview: ${naturalWidth}x${naturalHeight}`);
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        if (!ctx) {
                            toast({ title: "Downscale Error", description: `Could not get canvas context for ${file.name}. Using original preview.`, variant: "destructive" });
                        } else {
                            let targetWidth = naturalWidth;
                            let targetHeight = naturalHeight;

                            if (naturalWidth > MAX_DIMENSION_DOWNSCALED || naturalHeight > MAX_DIMENSION_DOWNSCALED) {
                                if (naturalWidth > naturalHeight) {
                                    targetWidth = MAX_DIMENSION_DOWNSCALED;
                                    targetHeight = Math.round((naturalHeight / naturalWidth) * MAX_DIMENSION_DOWNSCALED);
                                } else {
                                    targetHeight = MAX_DIMENSION_DOWNSCALED;
                                    targetWidth = Math.round((naturalWidth / naturalHeight) * MAX_DIMENSION_DOWNSCALED);
                                }
                            }
                            canvas.width = targetWidth;
                            canvas.height = targetHeight;
                            ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

                            processedPreviewUrl = canvas.toDataURL('image/png');
                            finalDimensions = { width: targetWidth, height: targetHeight };
                            addLog(`Downscaled ${file.name} preview to ${targetWidth}x${targetHeight}.`);
                        }
                    } else {
                        addLog(`User declined downscaling for ${file.name}. Using original preview resolution: ${naturalWidth}x${naturalHeight}.`);
                    }
                }

                resolveEntry({
                    id: `${file.name}-${Date.now()}-${Math.random()}`,
                    file,
                    previewUrl: processedPreviewUrl,
                    analysisStars: [],
                    initialAutoStars: [],
                    analysisDimensions: finalDimensions,
                    userReviewed: false,
                    isAnalyzed: false,
                    isAnalyzing: false,
                    starSelectionMode: 'auto',
                });
            };
            img.onerror = () => {
                const errorMessage = `Could not load generated preview image ${file.name} to check dimensions.`;
                addLog(`[ERROR] ${errorMessage}`);
                toast({ title: "Error Reading Preview", description: errorMessage, variant: "destructive" });
                resolveEntry(null);
            };
            img.src = originalPreviewUrl!;
        });

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        addLog(`[ERROR] Could not read or process ${file.name}: ${errorMessage}`);
        toast({
          title: `Error Processing ${file.name}`,
          description: errorMessage,
          variant: "destructive",
        });
        return null;
      }
    });

    const newEntriesResults = await Promise.all(newEntriesPromises);
    const validNewEntries = newEntriesResults.filter(entry => entry !== null) as ImageStarEntry[];

    if (validNewEntries.length > 0) {
        setAllImageStarData(prev => [...prev, ...validNewEntries]);
    }
    addLog(`Finished adding files. ${validNewEntries.length} new files queued. Total: ${allImageStarData.length + validNewEntries.length}.`);
  };

  const handleRemoveImage = (idToRemove: string) => {
    const entry = allImageStarData.find(entry => entry.id === idToRemove);
    const fileName = entry?.file?.name || `image with id ${idToRemove}`;
    setAllImageStarData(prev => prev.filter(item => item.id !== idToRemove));
    addLog(`Removed ${fileName} from queue.`);
  };

  const loadImage = (dataUrl: string, imageNameForLog: string): Promise<HTMLImageElement> => {
    addLog(`Loading image data into memory for: ${imageNameForLog}`);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        if (img.naturalWidth === 0 || img.naturalHeight === 0) {
          addLog(`[ERROR] Image ${imageNameForLog} loaded with 0x0 dimensions from data URL.`);
          reject(new Error(`Image ${imageNameForLog} loaded with zero dimensions (0x0) from its data URL. Its data cannot be processed.`));
        } else {
          addLog(`Successfully loaded ${imageNameForLog} (${img.naturalWidth}x${img.naturalHeight}) from data URL into memory.`);
          resolve(img);
        }
      };
      img.onerror = (e) => {
        const errorMsg = typeof e === 'string' ? e : (e as Event)?.type || 'unknown image load error';
        addLog(`[ERROR] Failed to load image ${imageNameForLog} from data URL: ${errorMsg}`);
        reject(new Error(`Failed to load image ${imageNameForLog} from data URL: ${errorMsg}`));
      };
      img.src = dataUrl;
    });
  };

  const analyzeImageForStars = useCallback(async (imageIndex: number): Promise<boolean> => {
    const currentEntry = allImageStarData[imageIndex];
    if (!currentEntry || currentEntry.isAnalyzing) return false;

    setAllImageStarData(prev => prev.map((entry, idx) => idx === imageIndex ? { ...entry, isAnalyzing: true } : entry));
    addLog(`Starting star analysis for: ${currentEntry.file.name} (from previewUrl)...`);

    try {
      const imgEl = await loadImage(currentEntry.previewUrl, currentEntry.file.name);

      const tempAnalysisCanvas = document.createElement('canvas');
      const tempAnalysisCtx = tempAnalysisCanvas.getContext('2d', { willReadFrequently: true });
      if (!tempAnalysisCtx) throw new Error("Could not get analysis canvas context.");

      const analysisWidth = imgEl.naturalWidth;
      const analysisHeight = imgEl.naturalHeight;

      tempAnalysisCanvas.width = analysisWidth;
      tempAnalysisCanvas.height = analysisHeight;
      tempAnalysisCtx.drawImage(imgEl, 0, 0, analysisWidth, analysisHeight);
      const analysisImageData = tempAnalysisCtx.getImageData(0, 0, analysisWidth, analysisHeight);

      const detectedStars = detectStars(analysisImageData);
      addLog(`Auto-detected ${detectedStars.length} stars in ${currentEntry.file.name} (at ${analysisWidth}x${analysisHeight}).`);

      setAllImageStarData(prev => prev.map((entry, idx) => {
        if (idx === imageIndex) {
          const newEntry = {
            ...entry,
            initialAutoStars: [...detectedStars],
            analysisDimensions: { width: analysisWidth, height: analysisHeight },
            isAnalyzed: true,
            isAnalyzing: false,
          };
          if (newEntry.starSelectionMode === 'auto' || (newEntry.starSelectionMode === 'manual' && !newEntry.userReviewed)) {
            newEntry.analysisStars = [...detectedStars];
          }
          return newEntry;
        }
        return entry;
      }));
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLog(`[ERROR] Failed to analyze ${currentEntry.file.name}: ${errorMessage}`);
      toast({ title: `Analysis Failed for ${currentEntry.file.name}`, description: errorMessage, variant: "destructive" });
      setAllImageStarData(prev => prev.map((entry, idx) =>
        idx === imageIndex ? {
          ...entry,
          isAnalyzing: false,
          isAnalyzed: false,
          analysisStars: [],
          initialAutoStars: []
        } : entry
      ));
      return false;
    }
  }, [allImageStarData, addLog, toast]);


  const handleToggleStarSelectionMode = async (imageId: string) => {
    let imageIndex = -1;
    setAllImageStarData(prev => prev.map((entry, idx) => {
      if (entry.id === imageId) {
        imageIndex = idx;
        const newMode = entry.starSelectionMode === 'auto' ? 'manual' : 'auto';
        addLog(`Star selection mode for ${entry.file.name} changed to ${newMode}.`);

        const updatedEntry: ImageStarEntry = {
          ...entry,
          starSelectionMode: newMode,
          userReviewed: false 
        };

        if (newMode === 'auto') {
          updatedEntry.analysisStars = [...entry.initialAutoStars];
        } else { 
          if ((!entry.analysisStars || entry.analysisStars.length === 0) && entry.initialAutoStars.length > 0) {
             updatedEntry.analysisStars = [...entry.initialAutoStars];
          }
        }
        return updatedEntry;
      }
      return entry;
    }));
    
    setAllImageStarData(currentData => {
        if (imageIndex !== -1) {
            const entryToCheck = currentData.find((e, i) => i === imageIndex);
            if (entryToCheck && entryToCheck.starSelectionMode === 'manual' && !entryToCheck.isAnalyzed && !entryToCheck.isAnalyzing) {
                addLog(`Image ${entryToCheck.file.name} switched to manual mode, and needs analysis. Analyzing now...`);
                analyzeImageForStars(imageIndex); 
            }
        }
        return currentData;
    });
  };

  const handleEditStarsRequest = async (imageIndex: number) => {
    const currentEntry = allImageStarData[imageIndex];
    if (!currentEntry) return;

    let entryForEditing = {...currentEntry};

    if (entryForEditing.starSelectionMode === 'auto' ||
        (entryForEditing.starSelectionMode === 'manual' && !entryForEditing.userReviewed && entryForEditing.analysisStars.length === 0)) {
      addLog(`Switching ${entryForEditing.file.name} to manual mode for editing (or preparing unreviewed manual).`);
      entryForEditing.starSelectionMode = 'manual';
      if (!entryForEditing.isAnalyzed || entryForEditing.initialAutoStars.length > 0) { 
          entryForEditing.analysisStars = [...entryForEditing.initialAutoStars];
      }
      entryForEditing.userReviewed = false; 

      setAllImageStarData(prev => prev.map((e, idx) => idx === imageIndex ? entryForEditing : e));
      await yieldToEventLoop(10); 
    }

    const updatedEntryForAnalysisCheck = allImageStarData.find(e => e.id === entryForEditing.id) || entryForEditing;

    if (!updatedEntryForAnalysisCheck.isAnalyzed && !updatedEntryForAnalysisCheck.isAnalyzing) {
      addLog(`Analyzing ${updatedEntryForAnalysisCheck.file.name} before editing stars.`);
      const analysisSuccess = await analyzeImageForStars(imageIndex);
      if (!analysisSuccess) {
        return; 
      }
      await yieldToEventLoop(100); 
    } else if (updatedEntryForAnalysisCheck.isAnalyzing) {
      toast({title: "Analysis in Progress", description: `Still analyzing ${updatedEntryForAnalysisCheck.file.name}. Please wait.`});
      return;
    }

    const finalEntryForEditing = allImageStarData.find(e => e.id === updatedEntryForAnalysisCheck.id);

    if (finalEntryForEditing && finalEntryForEditing.isAnalyzed && finalEntryForEditing.analysisDimensions) {
      let starsToEdit = [...finalEntryForEditing.analysisStars];
      if (finalEntryForEditing.starSelectionMode === 'manual' && starsToEdit.length === 0 && finalEntryForEditing.initialAutoStars.length > 0) {
          starsToEdit = [...finalEntryForEditing.initialAutoStars];
          addLog(`Populating editor for ${finalEntryForEditing.file.name} with ${starsToEdit.length} auto-detected stars as a base for manual editing.`);
      }

      setAllImageStarData(prev => prev.map((e, idx) =>
          idx === imageIndex ? {...e, analysisStars: starsToEdit, starSelectionMode: 'manual' } : e
      ));
      setCurrentEditingImageIndex(imageIndex);
      setIsStarEditingMode(true);
      addLog(`Opened star editor for ${finalEntryForEditing.file.name}. Mode: Manual. Initial stars for edit: ${starsToEdit.length}. Dim: ${finalEntryForEditing.analysisDimensions.width}x${finalEntryForEditing.analysisDimensions.height}`);
    } else {
       console.warn(`Cannot edit stars for ${finalEntryForEditing?.file.name || 'image'}: Analysis or dimension data incomplete or failed.`);
    }
  };

  const handleStarAnnotationClick = (clickedX: number, clickedY: number) => {
    if (currentEditingImageIndex === null) return;

    const entry = allImageStarData[currentEditingImageIndex];
    if (!entry || !entry.analysisDimensions) return;

    const effectiveCanvasDisplayWidth = Math.min(STAR_ANNOTATION_MAX_DISPLAY_WIDTH, entry.analysisDimensions.width);
    const clickToleranceInAnalysisUnits = effectiveCanvasDisplayWidth > 0 ? (STAR_CLICK_TOLERANCE_ON_DISPLAY_CANVAS_PX / effectiveCanvasDisplayWidth) * entry.analysisDimensions.width : STAR_CLICK_TOLERANCE_ON_DISPLAY_CANVAS_PX;
    const dynamicClickToleranceSquared = clickToleranceInAnalysisUnits * clickToleranceInAnalysisUnits;

    setAllImageStarData(prev => prev.map((item, idx) => {
      if (idx === currentEditingImageIndex) {
        let starFoundAndRemoved = false;
        const updatedStars = item.analysisStars.filter(star => {
          const dx = star.x - clickedX;
          const dy = star.y - clickedY;
          const distSq = dx * dx + dy * dy;
          if (distSq < dynamicClickToleranceSquared) {
            starFoundAndRemoved = true;
            addLog(`Removed star at (${star.x.toFixed(0)}, ${star.y.toFixed(0)}) from ${item.file.name}.`);
            return false; 
          }
          return true; 
        });

        if (!starFoundAndRemoved) {
          const newStar: Star = {
            x: clickedX,
            y: clickedY,
            brightness: DEFAULT_STAR_BRIGHTNESS_THRESHOLD_COMBINED + 1, 
            isManuallyAdded: true,
          };
          updatedStars.push(newStar);
          addLog(`Added manual star at (${clickedX.toFixed(0)}, ${clickedY.toFixed(0)}) to ${item.file.name}. Total stars: ${updatedStars.length}`);
        } else {
          addLog(`Total stars for ${item.file.name} after removal: ${updatedStars.length}`);
        }
        return { ...item, analysisStars: updatedStars, userReviewed: false }; 
      }
      return item;
    }));
  };

  const handleResetStars = () => {
    if (currentEditingImageIndex === null) return;
    setAllImageStarData(prev => prev.map((entry, idx) => {
      if (idx === currentEditingImageIndex) {
        addLog(`Stars reset to ${entry.initialAutoStars.length} auto-detected stars for ${entry.file.name}.`);
        return { ...entry, analysisStars: [...entry.initialAutoStars], userReviewed: false }; 
      }
      return entry;
    }));
    toast({title: "Stars Reset", description: "Star selection has been reset to automatically detected for the current image."});
  };

  const handleWipeAllStarsForCurrentImage = () => {
    if (currentEditingImageIndex === null) return;
    const currentImageName = allImageStarData[currentEditingImageIndex]?.file.name || "current image";
    setAllImageStarData(prev => prev.map((entry, idx) => {
      if (idx === currentEditingImageIndex) {
        addLog(`All stars wiped for ${currentImageName}.`);
        return { ...entry, analysisStars: [], userReviewed: false }; 
      }
      return entry;
    }));
    toast({title: "All Stars Wiped", description: `All stars have been cleared for ${currentImageName}.`});
  };


  const handleConfirmStarsForCurrentImage = () => {
    if (currentEditingImageIndex === null) return;

    const confirmedEntry = allImageStarData[currentEditingImageIndex];
    if (!confirmedEntry) return;

    const currentImageName = confirmedEntry.file.name || "current image";
    addLog(`Confirmed star selection for ${currentImageName}. Total stars: ${confirmedEntry.analysisStars.length}. Mode: Manual.`);

    setAllImageStarData(prev => prev.map((entry, idx) =>
      idx === currentEditingImageIndex ? { ...entry, userReviewed: true, starSelectionMode: 'manual' } : entry
    ));
    setIsStarEditingMode(false);
    setCurrentEditingImageIndex(null);
    toast({title: "Stars Confirmed", description: `Star selection saved for ${currentImageName}.`});

    if (allImageStarData.length > 1 && confirmedEntry.analysisStars && confirmedEntry.analysisDimensions) {
      setStarsToApplyToAll([...confirmedEntry.analysisStars]); 
      setAnalysisDimensionsToApplyToAll({...confirmedEntry.analysisDimensions}); 
      setSourceImageIdForApplyToAll(confirmedEntry.id);
      setShowApplyToAllDialog(true);
    }
  };

  const handleApplyStarsToAllImages = () => {
    if (!starsToApplyToAll || !sourceImageIdForApplyToAll || !analysisDimensionsToApplyToAll) return;

    addLog(`Applying star selection from image ID ${sourceImageIdForApplyToAll} to all other images.`);
    setAllImageStarData(prev => prev.map(entry => {
      if (entry.id !== sourceImageIdForApplyToAll &&
          entry.analysisDimensions.width === analysisDimensionsToApplyToAll.width &&
          entry.analysisDimensions.height === analysisDimensionsToApplyToAll.height) {
        return {
          ...entry,
          analysisStars: [...starsToApplyToAll], 
          starSelectionMode: 'manual' as StarSelectionMode,
          userReviewed: true, 
          isAnalyzed: true, 
        };
      } else if (entry.id !== sourceImageIdForApplyToAll) {
        addLog(`[WARN] Skipped applying stars to ${entry.file.name} due to dimension mismatch. Source: ${analysisDimensionsToApplyToAll.width}x${analysisDimensionsToApplyToAll.height}, Target: ${entry.analysisDimensions.width}x${entry.analysisDimensions.height}`);
      }
      return entry;
    }));

    toast({title: "Stars Applied", description: "The selected stars have been applied to other images with matching dimensions."});
    setShowApplyToAllDialog(false);
    setStarsToApplyToAll(null);
    setAnalysisDimensionsToApplyToAll(null);
    setSourceImageIdForApplyToAll(null);
  };

  const handleCancelApplyToAll = () => {
    setShowApplyToAllDialog(false);
    setStarsToApplyToAll(null);
    setAnalysisDimensionsToApplyToAll(null);
    setSourceImageIdForApplyToAll(null);
    addLog("User chose not to apply star selection to all other images.");
  };

  const handleAdvancedApplyStars = async () => {
    if (currentEditingImageIndex === null) return;

    setIsApplyingAdvancedStars(true);
    addLog("Starting advanced star application...");

    const sourceEntry = allImageStarData[currentEditingImageIndex];
    if (!sourceEntry || !sourceEntry.analysisDimensions) {
      addLog("[ERROR] Advanced apply failed: Could not get source image data.");
      toast({ title: "Advanced Apply Failed", description: "Could not get source image data.", variant: "destructive" });
      setIsApplyingAdvancedStars(false);
      return;
    }

    const sourceStars = sourceEntry.analysisStars;
    const { width: sourceWidth, height: sourceHeight } = sourceEntry.analysisDimensions;
    const sourceAspectRatio = sourceWidth / sourceHeight;

    if (sourceStars.length === 0) {
        addLog("[WARN] Advanced apply skipped: Source image has no stars selected.");
        toast({ title: "Advanced Apply", description: "Source image has no stars selected to apply.", variant: "default" });
         setIsApplyingAdvancedStars(false);
        return;
    }

    const updatedImageStarData = await Promise.all(allImageStarData.map(async (targetEntry, index) => {
      if (targetEntry.id === sourceEntry.id) {
        return targetEntry; 
      }

      if (!targetEntry.analysisDimensions) {
         addLog(`[WARN] Skipping advanced apply for ${targetEntry.file.name}: Dimension data not available.`);
         return targetEntry;
      }

      const { width: targetWidth, height: targetHeight } = targetEntry.analysisDimensions;
      const targetAspectRatio = targetWidth / targetHeight;

      const aspectRatioTolerance = 0.01; 

      if (Math.abs(sourceAspectRatio - targetAspectRatio) < aspectRatioTolerance) {
        addLog(`Applying stars to ${targetEntry.file.name} (Matching aspect ratio)...`);
        const transformedStars = sourceStars.map(star => ({
          x: (star.x / sourceWidth) * targetWidth,
          y: (star.y / sourceHeight) * targetHeight,
          brightness: star.brightness, 
          isManuallyAdded: true, 
        }));

        addLog(`Successfully applied ${transformedStars.length} stars to ${targetEntry.file.name}.`);
        return {
          ...targetEntry,
          analysisStars: transformedStars,
          starSelectionMode: 'manual' as StarSelectionMode,
          userReviewed: true,
          isAnalyzed: targetEntry.isAnalyzed || true, 
        };
      } else {
        addLog(`[WARN] Skipping advanced apply for ${targetEntry.file.name}: Aspect ratio mismatch. Source ${sourceWidth}x${sourceHeight}, Target ${targetWidth}x${targetHeight}.`);
        return targetEntry;
      }
    }));

    setAllImageStarData(updatedImageStarData);
    addLog("Advanced star application process finished.");
    toast({ title: "Advanced Apply Complete", description: "Stars proportionally applied to images with matching aspect ratios."});
    setIsApplyingAdvancedStars(false);
  };


  const handleStackAllImages = async () => {
    if (allImageStarData.length < 2) {
         const notEnoughMsg = "Please upload at least two images for stacking.";
         addLog(`[WARN] ${notEnoughMsg}`);
         toast({ title: "Not Enough Images", description: notEnoughMsg });
         setIsProcessingStack(false);
         return;
    }

    setIsProcessingStack(true);
    setProgressPercent(0);
    setLogs([]); 
    logIdCounter.current = 0; 

    setStackedImage(null);
    setShowPostProcessEditor(false);
    setImageForPostProcessing(null);
    setEditedPreviewUrl(null);


    addLog(`Starting image stacking. Mode: ${stackingMode}. Output: ${outputFormat.toUpperCase()}. Files: ${allImageStarData.length}.`);
    addLog(`Star Alignment: Min Stars = ${MIN_STARS_FOR_ALIGNMENT}.`);
    addLog(`Star Detection Params: Combined Brightness Threshold = ${DEFAULT_STAR_BRIGHTNESS_THRESHOLD_COMBINED}, Local Contrast Factor = ${DEFAULT_STAR_LOCAL_CONTRAST_FACTOR}.`);
    addLog(`Brightness Centroid Fallback Threshold: ${BRIGHTNESS_CENTROID_FALLBACK_THRESHOLD_GRAYSCALE_EQUIVALENT} (grayscale equivalent).`);

    if (typeof window === 'undefined' || typeof document === 'undefined') {
        const envErrorMsg = "Stacking cannot proceed outside a browser environment.";
        addLog(`[ERROR] ${envErrorMsg}`);
        toast({ title: "Environment Error", description: envErrorMsg, variant: "destructive" });
        setIsProcessingStack(false);
        return;
    }

    setProgressPercent(PROGRESS_INITIAL_SETUP);
    addLog(`Initial setup complete. Progress: ${PROGRESS_INITIAL_SETUP}%.`);

    const updatedStarDataForStacking = [...allImageStarData];

    addLog(`Starting pre-stack analysis for ${updatedStarDataForStacking.length} images if needed...`);
    for (let i = 0; i < updatedStarDataForStacking.length; i++) {
        let entry = updatedStarDataForStacking[i];
        if (!entry.isAnalyzed && !entry.isAnalyzing) {
            addLog(`Image ${entry.file.name} (${entry.id}) not analyzed. Analyzing now...`);

            setAllImageStarData(prev => prev.map((e) => e.id === entry.id ? {...e, isAnalyzing: true} : e));

            const analysisSuccess = await analyzeImageForStars(i); 

            const potentiallyUpdatedEntryFromState = allImageStarData.find(e => e.id === entry.id);

            if (analysisSuccess && potentiallyUpdatedEntryFromState && potentiallyUpdatedEntryFromState.isAnalyzed) {
                addLog(`Analysis successful for ${entry.file.name}. isAnalyzed: ${potentiallyUpdatedEntryFromState.isAnalyzed}`);
                updatedStarDataForStacking[i] = { ...potentiallyUpdatedEntryFromState }; 
                entry = updatedStarDataForStacking[i]; 
            } else {
                const analyzeFailMsg = `Analysis failed for ${entry.file.name}. It will be processed with fallback alignment.`;
                addLog(`[WARN] ${analyzeFailMsg} (Details: analysisSuccess=${analysisSuccess}, entryFound=${!!potentiallyUpdatedEntryFromState}, entryAnalyzed=${potentiallyUpdatedEntryFromState?.isAnalyzed})`);
                toast({ title: `Analysis Warning for ${entry.file.name}`, description: analyzeFailMsg, variant: "default"});

                updatedStarDataForStacking[i] = {
                    ...(potentiallyUpdatedEntryFromState || entry), 
                    isAnalyzed: false, 
                    isAnalyzing: false, 
                    analysisStars: [], 
                    initialAutoStars: [] 
                };
                entry = updatedStarDataForStacking[i];
            }
             setAllImageStarData(prev => prev.map((e) => e.id === entry.id ? {...e, isAnalyzing: false, isAnalyzed: entry.isAnalyzed } : e));
        }

        if (entry.starSelectionMode === 'auto') {
            if (JSON.stringify(entry.analysisStars) !== JSON.stringify(entry.initialAutoStars)) {
                 updatedStarDataForStacking[i] = { ...entry, analysisStars: [...entry.initialAutoStars] };
                 addLog(`For auto mode image ${entry.file.name}, ensuring analysis stars are set from initial auto-detected (${entry.initialAutoStars.length} stars).`);
            }
        } else if (entry.starSelectionMode === 'manual') {
            if (!entry.userReviewed) {
                if ((!entry.analysisStars || entry.analysisStars.length === 0) && entry.initialAutoStars.length > 0) {
                    updatedStarDataForStacking[i] = { ...entry, analysisStars: [...entry.initialAutoStars] };
                    addLog(`For unreviewed manual image ${entry.file.name}, using initial auto-detected (${entry.initialAutoStars.length} stars) as analysisStars was empty.`);
                } else if (entry.analysisStars && entry.analysisStars.length > 0) {
                    addLog(`For unreviewed manual image ${entry.file.name}, using its existing ${entry.analysisStars.length} analysis stars.`);
                } else {
                     addLog(`For unreviewed manual image ${entry.file.name}, no stars available. Will use fallback alignment.`);
                }
            } else {
                 addLog(`For reviewed manual image ${entry.file.name}, using its ${entry.analysisStars.length} user-confirmed stars.`);
            }
        }
         await yieldToEventLoop(10); 
    }

    setAllImageStarData(updatedStarDataForStacking);
    addLog("Pre-stack analysis and star-list preparation finished.");
    await yieldToEventLoop(100); 

    try {
      let imageElements: HTMLImageElement[] = [];
      addLog(`Loading ${allImageStarData.length} image elements from their previewUrls...`);
      for (const entry of allImageStarData) {
        try {
          const imgEl = await loadImage(entry.previewUrl, entry.file.name);
          imageElements.push(imgEl);
        } catch (loadError) {
           const errorMessage = loadError instanceof Error ? loadError.message : String(loadError);
           addLog(`[LOAD ERROR] ${entry.file.name}: ${errorMessage}`);
           toast({ title: `Error Loading ${entry.file.name}`, description: errorMessage, variant: "destructive" });
        }
      }
      addLog(`Successfully loaded ${imageElements.length} out of ${allImageStarData.length} images into HTMLImageElements.`);

      if (imageElements.length < 2) {
        const notEnoughValidMsg = `Need at least two valid images for stacking after filtering. Found ${imageElements.length}.`;
        addLog(`[ERROR] ${notEnoughValidMsg}`);
        toast({ title: "Not Enough Valid Images", description: notEnoughValidMsg, variant: "destructive" });
        setIsProcessingStack(false);
        setProgressPercent(0);
        return;
      }

      const firstImage = imageElements[0];
      const firstImageEntry = allImageStarData[0]; 

      if (!firstImage || firstImage.naturalWidth === 0 || firstImage.naturalHeight === 0 || !firstImageEntry?.analysisDimensions) {
        const invalidRefMsg = `The first image (${firstImageEntry?.file.name || 'unknown'}) is invalid or its dimensions are missing. Cannot proceed.`;
        addLog(`[ERROR] ${invalidRefMsg}`);
        toast({ title: "Invalid Reference Image", description: invalidRefMsg, variant: "destructive" });
        setIsProcessingStack(false);
        setProgressPercent(0);
        return;
      }

      let targetWidth = firstImageEntry.analysisDimensions.width;
      let targetHeight = firstImageEntry.analysisDimensions.height;
      addLog(`Target stacking dimensions (from first image's analysisDimensions): ${targetWidth}x${targetHeight}.`);


      if (targetWidth === 0 || targetHeight === 0) {
        const zeroDimMsg = "Calculated target stacking dimensions are zero. Cannot proceed.";
        addLog(`[ERROR] ${zeroDimMsg}`);
        toast({ title: "Error", description: zeroDimMsg, variant: "destructive" });
        setIsProcessingStack(false);
        setProgressPercent(0);
        return;
      }

      const numImages = imageElements.length;
      const totalPixels = targetWidth * targetHeight;
      const normalizedImageFactor = Math.min(1, numImages / 20); 
      const veryLargePixelCount = 10000 * 10000; 
      const normalizedPixelFactor = Math.min(1, totalPixels / veryLargePixelCount);
      const loadScore = (0.3 * normalizedImageFactor) + (0.7 * normalizedPixelFactor); 
      const dynamicDelayMs = Math.max(10, Math.min(100, 10 + Math.floor(loadScore * 90))); 
      addLog(`Calculated dynamic yield delay: ${dynamicDelayMs}ms (Load score: ${loadScore.toFixed(2)}, Images: ${numImages}, Pixels: ${totalPixels})`);


      const offscreenCanvas = document.createElement('canvas');
      offscreenCanvas.width = targetWidth;
      offscreenCanvas.height = targetHeight;
      const ctx = offscreenCanvas.getContext('2d', { willReadFrequently: true });

      const tempAnalysisCanvasForFallback = document.createElement('canvas');
      const tempAnalysisCtxForFallback = tempAnalysisCanvasForFallback.getContext('2d', { willReadFrequently: true });

      if (!ctx || !tempAnalysisCtxForFallback) {
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
        const entryData = allImageStarData[i]; 
        const fileNameForLog = entryData.file.name;
        let finalScaledCentroid: { x: number; y: number } | null = null;
        let method = "unknown";

        if (!imgEl || imgEl.naturalWidth === 0 || imgEl.naturalHeight === 0 || !entryData.analysisDimensions || !entryData.isAnalyzed) {
            const reason = !entryData.isAnalyzed ? "analysis failed or skipped" : "invalid image element or data";
            const skipMsg = `Centroid for ${fileNameForLog} (${reason}): using target geometric center.`;
            console.warn(skipMsg);
            addLog(`[ALIGN WARN] ${skipMsg}`);
            finalScaledCentroid = { x: targetWidth / 2, y: targetHeight / 2 }; 
            method = `${reason}_geometric_fallback`;
            centroids.push(finalScaledCentroid);
            addLog(`[ALIGN] Image ${i} (${fileNameForLog}) centroid (scaled to target): ${finalScaledCentroid.x.toFixed(2)}, ${finalScaledCentroid.y.toFixed(2)} (Method: ${method})`);
            await yieldToEventLoop(dynamicDelayMs);
            setProgressPercent(prev => Math.min(100, prev + centroidProgressIncrement));
            continue;
        }

        const {width: analysisWidth, height: analysisHeight} = entryData.analysisDimensions;

        try {
          const starsForCentroid = entryData.analysisStars; 
          addLog(`[ALIGN] Analyzing image ${i} (${fileNameForLog}): ${analysisWidth}x${analysisHeight} using ${starsForCentroid.length} stars (Mode: ${entryData.starSelectionMode}, Reviewed: ${entryData.userReviewed}).`);

          let analysisImageCentroid = calculateStarArrayCentroid(starsForCentroid, addLog);

          if (analysisImageCentroid) {
              method = entryData.starSelectionMode === 'manual' && entryData.userReviewed ? `user-manual-star-based` : `auto-star-based (${entryData.initialAutoStars.length} initial auto)`;
              if(entryData.starSelectionMode === 'manual' && !entryData.userReviewed && starsForCentroid.length > 0) { 
                method = `unreviewed-manual-star-based (${starsForCentroid.length} stars)`;
              }
              successfulStarAlignments++;
          } else {
            const reason = starsForCentroid.length < MIN_STARS_FOR_ALIGNMENT ? `only ${starsForCentroid.length} stars (min ${MIN_STARS_FOR_ALIGNMENT} required)` : "star centroid failed";
            method = `brightness-based fallback (${reason})`;
            addLog(`[ALIGN WARN] Star-based centroid failed for ${fileNameForLog} (${reason}). Falling back to brightness-based centroid.`);

            tempAnalysisCanvasForFallback.width = analysisWidth; 
            tempAnalysisCanvasForFallback.height = analysisHeight;
            tempAnalysisCtxForFallback.clearRect(0, 0, analysisWidth, analysisHeight);
            tempAnalysisCtxForFallback.drawImage(imgEl, 0, 0, analysisWidth, analysisHeight); 
            const fallbackImageData = tempAnalysisCtxForFallback.getImageData(0, 0, analysisWidth, analysisHeight);
            analysisImageCentroid = calculateBrightnessCentroid(fallbackImageData, addLog);
          }

          if (analysisImageCentroid) {
             finalScaledCentroid = {
                x: (analysisImageCentroid.x / analysisWidth) * targetWidth,
                y: (analysisImageCentroid.y / analysisHeight) * targetHeight,
            };
          }

        } catch (imgAnalysisError) {
            const errorMessage = imgAnalysisError instanceof Error ? imgAnalysisError.message : String(imgAnalysisError);
            addLog(`[ALIGN ERROR] Error during centroid phase for ${fileNameForLog}: ${errorMessage}. Aligning to geometric center.`);
            toast({ title: `Centroid Error for ${fileNameForLog}`, description: `Could not determine centroid: ${errorMessage}.`, variant: "destructive" });
            method = "analysis_error";
        }

        if (!finalScaledCentroid) {
            const noCentroidMsg = `Could not determine any centroid for ${fileNameForLog}. It will be aligned to target geometric center.`;
            addLog(`[ALIGN ERROR] ${noCentroidMsg}`);
            finalScaledCentroid = { x: targetWidth / 2, y: targetHeight / 2 };
            method = method.includes("_error") || method === "unknown" ? `${method}_geometric_fallback` : "geometric_center_fallback";
        }
        addLog(`[ALIGN] Image ${i} (${fileNameForLog}) centroid (in target ${targetWidth}x${targetHeight} space): ${finalScaledCentroid.x.toFixed(2)}, ${finalScaledCentroid.y.toFixed(2)} (Method: ${method})`);
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
        setIsProcessingStack(false);
        setProgressPercent(0);
        return;
      }
      addLog(`[ALIGN] Reference centroid (from image 0, in target space): ${referenceCentroid.x.toFixed(2)}, ${referenceCentroid.y.toFixed(2)}`);

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
          const currentCentroid = centroids[i];

          if (!img || img.naturalWidth === 0 || img.naturalHeight === 0) {
            addLog(`[STACK SKIP] Skipping invalid image element ${i} during band processing.`);
            continue;
          }

          let dx = 0;
          let dy = 0;

          if (currentCentroid) {
            dx = referenceCentroid.x - currentCentroid.x;
            dy = referenceCentroid.y - currentCentroid.y;
          } else {
            addLog(`[STACK WARN] Image ${i} (${allImageStarData[i]?.file?.name}) had no centroid for offset calculation. Using 0,0 offset.`);
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
            const bandErrorMsg = `Error getting image data for band (img ${i}, bandY ${yBandStart}): ${errorMsg}`;
            addLog(`[STACK ERROR] ${bandErrorMsg}`);
            toast({ title: `Stacking Error on Band Processing`, description: `Could not process pixel data for ${allImageStarData[i]?.file?.name || `image ${i}`} for band at row ${yBandStart}.`, variant: "destructive"});
          }
           await yieldToEventLoop(dynamicDelayMs); 
        }
        if (yBandStart === 0) { 
            validImagesStackedCount = imagesContributingToBand;
            addLog(`[STACK] ${validImagesStackedCount} images contributed to the first band.`);
        }

        for (let yInBand = 0; yInBand < currentBandHeight; yInBand++) {
          for (let x = 0; x < targetWidth; x++) {
              const bandPixelIndex = yInBand * targetWidth + x;
              const finalPixelGlobalIndex = ((yBandStart + yInBand) * targetWidth + x) * 4;

              if (bandPixelDataCollector[bandPixelIndex] && bandPixelDataCollector[bandPixelIndex].r.length > 0) {
                if (stackingMode === 'median') {
                  finalImageData.data[finalPixelGlobalIndex] = getMedian(bandPixelDataCollector[bandPixelIndex].r);
                  finalImageData.data[finalPixelGlobalIndex + 1] = getMedian(bandPixelDataCollector[bandPixelIndex].g);
                  finalImageData.data[finalPixelGlobalIndex + 2] = getMedian(bandPixelDataCollector[bandPixelIndex].b);
                } else { 
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
             addLog(`Processed band: rows ${yBandStart} to ${yBandStart + currentBandHeight - 1}. Progress: ${Math.round(progressPercent + bandProgressIncrement * ((yBandStart + currentBandHeight) / targetHeight * numBands) )}%. Yielding.`);
        }
        setProgressPercent(prev => Math.min(100, prev + bandProgressIncrement));
        await yieldToEventLoop(dynamicDelayMs); 
      }

      setProgressPercent(100); 
      addLog(`All bands processed. Finalizing image.`);

      if (validImagesStackedCount === 0 && imageElements.length > 0) { 
        const noStackMsg = "No images could be successfully processed during band stacking.";
        addLog(`[ERROR] ${noStackMsg}`);
        toast({ title: "Stacking Failed", description: noStackMsg, variant: "destructive" });
        setIsProcessingStack(false);
        setProgressPercent(0);
        return;
      }

      ctx.putImageData(finalImageData, 0, 0);

      let resultDataUrl: string;
      let outputMimeType = 'image/png';
      if (outputFormat === 'jpeg') {
        outputMimeType = 'image/jpeg';
        resultDataUrl = offscreenCanvas.toDataURL(outputMimeType, jpegQuality / 100);
        addLog(`Generated JPEG image (Quality: ${jpegQuality}%).`);
      } else {
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
        setImageForPostProcessing(resultDataUrl); 
        setEditedPreviewUrl(resultDataUrl); 
        setShowPostProcessEditor(true); 

        setBrightness(100);
        setExposure(0);
        setSaturation(100);

        const alignmentMessage = successfulStarAlignments > 0
          ? `${successfulStarAlignments}/${imageElements.length} images primarily aligned using star-based centroids.`
          : `All images aligned using brightness-based centroids or geometric centers.`;

        const stackingMethodUsed = stackingMode === 'median' ? 'Median' : 'Sigma Clip';
        const successToastMsg = `${alignmentMessage} ${validImagesStackedCount} image(s) (out of ${imageElements.length} processed) stacked. Dim: ${targetWidth}x${targetHeight}. Ready for post-processing.`;
        addLog(`Stacking complete. ${successToastMsg}`);
        toast({
          title: `${stackingMethodUsed} Stacking Complete (${outputFormat.toUpperCase()})`,
          description: successToastMsg,
          duration: 10000,
        });
      }

    } catch (error) {
      console.error("Unhandled error in handleStackAllImages:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLog(`[FATAL ERROR] Stacking Process Failed: ${errorMessage}.`);
      toast({
        title: "Stacking Process Failed",
        description: `An unexpected error occurred: ${errorMessage}. Check console and logs. Very large images may cause browser instability or errors.`,
        variant: "destructive",
      });
      setStackedImage(null); 
    } finally {
      setIsProcessingStack(false);
      setProgressPercent(0); 
      setAllImageStarData(prev => prev.map(e => ({...e, isAnalyzing: false})));
      addLog("Image stacking process finished.");
      console.log("Image stacking process finished."); 
    }
  };

  const handleOpenPostProcessEditor = () => {
    if (stackedImage) {
      setImageForPostProcessing(stackedImage);
      setEditedPreviewUrl(stackedImage); 
      setBrightness(100);
      setExposure(0);
      setSaturation(100);
      setShowPostProcessEditor(true);
    } else {
      toast({ title: "No Image", description: "Stack images first to enable post-processing." });
    }
  };

  const handleResetAdjustments = () => {
    setBrightness(100);
    setExposure(0);
    setSaturation(100);
    if (imageForPostProcessing) { 
      setEditedPreviewUrl(imageForPostProcessing); 
    }
  };


  const canStartStacking = allImageStarData.length >= 2 && !isApplyingAdvancedStars;
  const isUiDisabled = isProcessingStack || (currentEditingImageIndex !== null && allImageStarData[currentEditingImageIndex]?.isAnalyzing);

  const currentImageForEditing = currentEditingImageIndex !== null ? allImageStarData[currentEditingImageIndex] : null;
  const sourceImageForDialog = allImageStarData.find(img => img.id === sourceImageIdForApplyToAll);

  const currentYear = new Date().getFullYear();

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <AppHeader />
      <main className="flex-grow container mx-auto py-6 px-2 sm:px-4 md:px-6">
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Left Column: Controls and Queue */}
          <div className="w-full lg:w-2/5 xl:w-1/3 space-y-6">
            <Card className="shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center text-xl font-headline">
                  <StarIcon className="mr-2 h-5 w-5 text-accent" />
                  {t('uploadAndConfigure')}
                </CardTitle>
                 <CardDescription className="text-sm max-h-32 overflow-y-auto">
                   {t('cardDescription')}
                 </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {!isStarEditingMode ? (
                  <>
                    <ImageUploadArea onFilesAdded={handleFilesAdded} isProcessing={isUiDisabled} />

                    {isProcessingStack && progressPercent > 0 && (
                      <div className="space-y-2 my-4">
                        <Progress value={progressPercent} className="w-full h-3" />
                        <p className="text-sm text-center text-muted-foreground">{t('stackingProgress', {progressPercent: Math.round(progressPercent)})}</p>
                      </div>
                    )}

                    {allImageStarData.length > 0 && (
                      <>
                        <h3 className="text-lg font-semibold mt-4 text-foreground">{t('imageQueueCount', {count: allImageStarData.length})}</h3>
                        <ScrollArea className="h-60 border rounded-md p-2 bg-background/30">
                          <div className="grid grid-cols-1 gap-3">
                            {allImageStarData.map((entry, index) => (
                              <ImageQueueItem
                                key={entry.id}
                                id={entry.id}
                                file={entry.file}
                                previewUrl={entry.previewUrl}
                                isAnalyzing={entry.isAnalyzing || (currentEditingImageIndex === index && allImageStarData[currentEditingImageIndex]?.isAnalyzing)}
                                isReviewed={entry.userReviewed}
                                starSelectionMode={entry.starSelectionMode}
                                onRemove={() => handleRemoveImage(entry.id)}
                                onEditStars={() => handleEditStarsRequest(index)}
                                onToggleStarSelectionMode={() => handleToggleStarSelectionMode(entry.id)}
                                isProcessing={isUiDisabled}
                                isAnalyzed={entry.isAnalyzed}
                                analysisDimensions={entry.analysisDimensions}
                              />
                            ))}
                          </div>
                        </ScrollArea>

                        {/* Stacking Options */}
                        <div className="space-y-2 pt-2">
                          <Label className="text-base font-semibold text-foreground">{t('stackingMode')}</Label>
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
                        </div>

                        <div className="space-y-2 pt-2">
                          <Label className="text-base font-semibold text-foreground">{t('previewFit')}</Label>
                          <RadioGroup
                            value={previewFitMode}
                            onValueChange={(value: string) => setPreviewFitMode(value as PreviewFitMode)}
                            className="flex space-x-4"
                            disabled={isUiDisabled}
                          >
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="contain" id="fit-contain" />
                              <Label htmlFor="fit-contain" className="cursor-pointer">{t('fitContain')}</Label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="cover" id="fit-cover" />
                              <Label htmlFor="fit-cover" className="cursor-pointer">{t('fitCover')}</Label>
                            </div>
                          </RadioGroup>
                        </div>

                        <div className="space-y-2 pt-2">
                          <Label className="text-base font-semibold text-foreground">{t('outputFormat')}</Label>
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
                        </div>

                        {outputFormat === 'jpeg' && (
                          <div className="space-y-2 pt-2">
                            <Label htmlFor="jpegQualitySlider" className="text-base font-semibold text-foreground">
                              {t('jpgQuality', {jpegQuality})}
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
                          </div>
                        )}

                        <Button
                          onClick={handleStackAllImages}
                          disabled={!canStartStacking || isUiDisabled || isProcessingStack}
                          className="w-full bg-accent hover:bg-accent/90 text-accent-foreground mt-4"
                          title={!canStartStacking ? "Upload at least two images to enable stacking." : "Stack All Images"}
                        >
                          {isProcessingStack ? <><Loader2 className="mr-2 h-5 w-5 animate-spin" />{t('stackingButtonInProgress')}</> : <><CheckCircle className="mr-2 h-5 w-5" />{t('stackImagesButton', { count: allImageStarData.length })}</>}
                        </Button>
                      </>
                    )}
                  </>
                ) : (
                  // Star Editing Mode
                  currentImageForEditing && currentImageForEditing.analysisDimensions && (
                    <div className="space-y-4">
                      <Alert>
                          <StarIcon className="h-4 w-4 text-accent" />
                          <AlertTitle>{t('editStarsFor', {fileName: currentImageForEditing.file.name})}</AlertTitle>
                          <AlertDescription>
                            {t('editStarsDescription', {starCount: currentImageForEditing.analysisStars.length, width: currentImageForEditing.analysisDimensions.width, height: currentImageForEditing.analysisDimensions.height })}
                          </AlertDescription>
                      </Alert>
                      <StarAnnotationCanvas
                        imageUrl={currentImageForEditing.previewUrl}
                        stars={currentImageForEditing.analysisStars}
                        analysisWidth={currentImageForEditing.analysisDimensions.width}
                        analysisHeight={currentImageForEditing.analysisDimensions.height}
                        onCanvasClick={handleStarAnnotationClick}
                        canvasDisplayWidth={STAR_ANNOTATION_MAX_DISPLAY_WIDTH}
                      />
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2">
                        <Button onClick={handleResetStars} variant="outline" className="w-full" disabled={isUiDisabled}>
                          <RefreshCcw className="mr-2 h-4 w-4" /> {t('resetToAuto')}
                        </Button>
                        <Button onClick={handleWipeAllStarsForCurrentImage} variant="destructive" className="w-full" disabled={isUiDisabled}>
                          <Trash2 className="mr-2 h-4 w-4" /> {t('wipeAllStars')}
                        </Button>
                         <Button onClick={handleAdvancedApplyStars} variant="outline" className="w-full sm:col-span-3 lg:col-span-1" disabled={isUiDisabled || isApplyingAdvancedStars}>
                          {isApplyingAdvancedStars ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Settings2 className="mr-2 h-4 w-4" /> }
                           Advanced Apply
                        </Button>
                        <Button
                          onClick={handleConfirmStarsForCurrentImage}
                          className="w-full bg-green-600 hover:bg-green-700 text-white sm:col-span-3 lg:col-span-1"
                          disabled={isUiDisabled}
                        >
                          <CheckCircle className="mr-2 h-4 w-4" />

                          {t('confirmAndClose')}
                        </Button>
                      </div>
                      <Button onClick={() => {setIsStarEditingMode(false); setCurrentEditingImageIndex(null);}} variant="ghost" className="w-full text-muted-foreground" disabled={isUiDisabled}>
                          {t('cancelEditing')}
                      </Button>
                    </div>
                  )
                )}

                {/* Logs Section */}
                {logs.length > 0 && (
                  <Card className="mt-4">
                    <CardHeader className="p-3 border-b">
                      <CardTitle className="text-base flex items-center">
                        <ListChecks className="mr-2 h-4 w-4" />
                        {t('processingLogs')}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      <ScrollArea ref={logContainerRef} className="h-48 p-3 text-xs bg-muted/20 rounded-b-md">
                        {logs.map((log) => (
                          <div key={log.id} className="mb-1 font-mono">
                            <span className="text-muted-foreground mr-2">{log.timestamp}</span>
                            <span className={log.message.startsWith('[ERROR]') ? 'text-destructive' : (log.message.startsWith('[WARN]') || log.message.includes('Warning:') ? 'text-yellow-500' : 'text-foreground/80')}>{log.message}</span>
                          </div>
                        ))}
                      </ScrollArea>
                    </CardContent>
                  </Card>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Right Column: Image Preview */}
          <div className="w-full lg:w-3/5 xl:w-2/3 flex flex-col space-y-6">
            <ImagePreview
              imageUrl={showPostProcessEditor ? editedPreviewUrl : stackedImage}
              fitMode={previewFitMode}
            />
            {stackedImage && !showPostProcessEditor && ( 
               <Button
                onClick={handleOpenPostProcessEditor}
                className="w-full bg-purple-600 hover:bg-purple-700 text-white"
                size="lg"
                disabled={isProcessingStack} 
              >
                <Wand2 className="mr-2 h-5 w-5" />
                {t('finalizeAndDownload')}
              </Button>
            )}
          </div>
        </div>
      </main>
      <footer className="py-6 text-center text-sm text-muted-foreground border-t border-border">
        <div>{t('creditsLine1', {year: currentYear})}</div>
        <div className="mt-2 px-4">
        {t('creditsLine2Part1')}
        </div>
      </footer>

      {/* Apply Stars to All Dialog */}
      {showApplyToAllDialog && sourceImageForDialog && (
        <AlertDialog open={showApplyToAllDialog} onOpenChange={setShowApplyToAllDialog}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle className="flex items-center">
                        <CopyCheck className="mr-2 h-5 w-5 text-accent" />
                        {t('applyStarsToOther')}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('applyStarsDescription', {
                        fileName: sourceImageForDialog.file.name,
                        starCount: starsToApplyToAll?.length || 0,
                        width: analysisDimensionsToApplyToAll?.width,
                        height: analysisDimensionsToApplyToAll?.height,
                        otherImageCount: allImageStarData.filter(img =>
                            img.id !== sourceImageIdForApplyToAll &&
                            img.analysisDimensions.width === analysisDimensionsToApplyToAll?.width &&
                            img.analysisDimensions.height === analysisDimensionsToApplyToAll?.height
                        ).length
                      })}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel onClick={handleCancelApplyToAll}>{t('noKeepIndividual')}</AlertDialogCancel>
                    <AlertDialogAction onClick={handleApplyStarsToAllImages} className="bg-accent hover:bg-accent/90 text-accent-foreground">
                        {t('yesApplyToAll')}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
      )}

    {/* Post-Processing Editor Dialog */}
    {showPostProcessEditor && imageForPostProcessing && (
        <ImagePostProcessEditor
          isOpen={showPostProcessEditor}
          onClose={() => setShowPostProcessEditor(false)}
          baseImageUrl={imageForPostProcessing} 
          editedImageUrl={editedPreviewUrl} 
          brightness={brightness}
          setBrightness={setBrightness}
          exposure={exposure}
          setExposure={setExposure}
          saturation={saturation}
          setSaturation={setSaturation}
          onResetAdjustments={handleResetAdjustments}
          isAdjusting={isApplyingAdjustments}
          outputFormat={outputFormat}
          jpegQuality={jpegQuality}
        />
      )}

    </div>
  );
}
