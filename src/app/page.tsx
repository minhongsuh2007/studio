
"use client";

import type React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { fileToDataURL } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';
import { estimateAffineTransform, warpImage, type Point as AstroAlignPoint } from '@/lib/astro-align';


import { AppHeader } from '@/components/astrostacker/AppHeader';
import { ImageUploadArea } from '@/components/astrostacker/ImageUploadArea';
import { ImageQueueItem } from '@/components/astrostacker/ImageQueueItem';
import { ImagePreview } from '@/components/astrostacker/ImagePreview';
import { ImagePostProcessEditor } from '@/components/astrostacker/ImagePostProcessEditor';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Star as StarIcon, ListChecks, CheckCircle, RefreshCcw, Edit3, Loader2, Orbit, Trash2, CopyCheck, AlertTriangle, Wand2, ShieldOff, UploadCloud, Layers, Baseline, X, FileImage, ChevronRight, SkipForward } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { StarAnnotationCanvas } from '@/components/astrostacker/StarAnnotationCanvas';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Switch } from '@/components/ui/switch';
import NextImage from 'next/image';


interface LogEntry {
  id: number;
  timestamp: string;
  message: string;
}

export type StarSelectionMode = 'auto' | 'manual';

// Application-wide Star interface (for UI and general use)
export interface Star {
  x: number;
  y: number;
  brightness: number;
  isManuallyAdded?: boolean;
  fwhm?: number;
}

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

interface SourceImageForApplyMenu {
  id: string;
  fileName: string;
  stars: Star[];
  dimensions: { width: number; height: number };
}


type StackingMode = 'median' | 'sigmaClip';
type PreviewFitMode = 'contain' | 'cover';
type OutputFormat = 'png' | 'jpeg';

const MIN_VALID_DATA_URL_LENGTH = 100;
const STACKING_BAND_HEIGHT = 50;

const SIGMA_CLIP_THRESHOLD = 2.0;
const SIGMA_CLIP_ITERATIONS = 2;
const MIN_STARS_FOR_CENTROID_ALIGNMENT = 3;
const MIN_STARS_FOR_AFFINE_ALIGNMENT = 5; // Min stars for affine transform
const NUM_STARS_TO_USE_FOR_AFFINE_MATCHING = 10; // How many top stars to consider for matching
const AUTO_ALIGN_TARGET_STAR_COUNT = 10; // Number of stars to use from auto-detection for centroid fallback


const BRIGHTNESS_CENTROID_FALLBACK_THRESHOLD_GRAYSCALE_EQUIVALENT = 30;
const STAR_ANNOTATION_MAX_DISPLAY_WIDTH = 500;
const STAR_CLICK_TOLERANCE_ON_DISPLAY_CANVAS_PX = 10;
const MANUAL_STAR_CLICK_CENTROID_RADIUS = 10;
const MANUAL_STAR_CLICK_CENTROID_BRIGHTNESS_THRESHOLD = 30;

const IS_LARGE_IMAGE_THRESHOLD_MP = 12;
const MAX_DIMENSION_DOWNSCALED = 2048;

const FLAT_FIELD_CORRECTION_MAX_SCALE_FACTOR = 5;
const ASPECT_RATIO_TOLERANCE = 0.01;

const PROGRESS_INITIAL_SETUP = 5;
const PROGRESS_CENTROID_CALCULATION_TOTAL = 35;
const PROGRESS_BANDED_STACKING_TOTAL = 60;

// Constants for filtering stars used in Affine Alignment
const ALIGNMENT_STAR_MIN_FWHM = 2.0;
const ALIGNMENT_STAR_MAX_FWHM = 4.0;


// ==== New Star Detector (Self-Contained) Configuration ====
const DETECTOR_MIN_CONTRAST = 20;
const DETECTOR_MIN_BRIGHTNESS = 40;
const DETECTOR_MAX_BRIGHTNESS = 220;
const DETECTOR_MIN_DISTANCE = 6;
const DETECTOR_MAX_STARS = 10; // Reduced from 75
const DETECTOR_MIN_FWHM = 1.5;
const DETECTOR_MAX_FWHM = 5.0;
const DETECTOR_ANNULUS_INNER_RADIUS = 4;
const DETECTOR_ANNULUS_OUTER_RADIUS = 8;
const DETECTOR_FWHM_PROFILE_HALF_WIDTH = 5;
const DETECTOR_MARGIN = 6;
const DETECTOR_FLATNESS_TOLERANCE = 2;

// Type for the new detector
type DetectedStarPoint = { x: number; y: number; value: number; contrast: number; fwhm: number };


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
      
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

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


// --- New Star Detector (Self-Contained) Functions ---

function getGrayscaleArrayFromCanvas(ctx: CanvasRenderingContext2D, addLog?: (message: string) => void): number[][] {
  const { width, height } = ctx.canvas;
  if (width === 0 || height === 0) {
    if (addLog) addLog(`[DETECTOR CANVAS] Canvas dimensions are ${width}x${height}. Cannot extract grayscale data.`);
    return [];
  }
  if (addLog) addLog(`[DETECTOR CANVAS] Extracting grayscale data from canvas: ${width}x${height}`);
  const imgData = ctx.getImageData(0, 0, width, height).data;
  const gray: number[][] = [];

  for (let y = 0; y < height; y++) {
    gray[y] = [];
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = imgData[i];
      const g = imgData[i + 1];
      const b = imgData[i + 2];
      gray[y][x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  if (addLog) addLog(`[DETECTOR CANVAS] Grayscale data extraction complete for ${width}x${height}.`);
  return gray;
}

function estimateLocalBackground(
  image: number[][],
  x: number,
  y: number,
  innerRadius = DETECTOR_ANNULUS_INNER_RADIUS,
  outerRadius = DETECTOR_ANNULUS_OUTER_RADIUS,
  addLog?: (message: string) => void
): number {
  const height = image.length;
  const width = image[0]?.length || 0;
  let sum = 0;
  let count = 0;

  if (width === 0 || height === 0) {
    if (addLog) addLog("[DETECTOR BG] Empty image or row for background estimation.");
    return 0;
  }

  for (let dy = -outerRadius; dy <= outerRadius; dy++) {
    for (let dx = -outerRadius; dx <= outerRadius; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= innerRadius && dist <= outerRadius) {
        const px = x + dx;
        const py = y + dy;
        if (px >= 0 && px < width && py >= 0 && py < height && image[py] !== undefined) {
          sum += image[py][px];
          count++;
        }
      }
    }
  }
  const backgroundValue = count > 0 ? sum / count : 0;
  return backgroundValue;
}

function getLocalContrast(
    image: number[][],
    x: number,
    y: number,
    addLog?: (message: string) => void
): number {
  const pixelValue = image[y][x];
  const background = estimateLocalBackground(image, x, y, DETECTOR_ANNULUS_INNER_RADIUS, DETECTOR_ANNULUS_OUTER_RADIUS, addLog);
  const contrast = pixelValue - background;
  return contrast;
}

function estimateFWHM(
    image: number[][],
    x: number,
    y: number,
    profileHalfWidth = DETECTOR_FWHM_PROFILE_HALF_WIDTH,
    addLog?: (message: string) => void
): number {
  const profile: number[] = [];
  const imageWidth = image[0]?.length || 0;
  const imageHeight = image.length;

  if (imageWidth === 0 || imageHeight === 0 || y < 0 || y >= imageHeight) {
    if (addLog) addLog(`[FWHM EST] Invalid image or y-coordinate for FWHM estimation at (${x},${y}).`);
    return 0;
  }

  for (let dx = -profileHalfWidth; dx <= profileHalfWidth; dx++) {
    const px = x + dx;
    if (px >= 0 && px < imageWidth) {
      profile.push(image[y][px]);
    } else {
      profile.push(0);
    }
  }

  if (profile.length === 0) {
    if (addLog) addLog(`[FWHM EST] Profile array is empty at (${x},${y}).`);
    return 0;
  }

  const peak = Math.max(...profile);
  if (peak === 0) {
     if (addLog) addLog(`[FWHM EST] Peak value in profile is 0 at (${x},${y}). Profile: ${profile.map(p=>p.toFixed(1)).join(',')}`);
     return 0;
  }
  const halfMax = peak / 2;

  let left = -1, right = -1;

  // Find left edge (interpolated)
  for (let i = 0; i < profile.length - 1; i++) {
      if (profile[i] >= halfMax && profile[i + 1] < halfMax) { // Crosses HM downwards
          left = i + (profile[i] - halfMax) / (profile[i] - profile[i + 1]);
          break;
      }
  }
  // Handle case where peak is at the very start of profile and is above halfMax
  if (left === -1 && profile[0] >= halfMax && profile.length > 1 && profile[0] > profile[1]) {
      left = 0;
  }


  // Find right edge (interpolated)
  for (let i = profile.length - 1; i > 0; i--) {
      if (profile[i] >= halfMax && profile[i - 1] < halfMax) { // Crosses HM downwards when looking from right
          right = i - (profile[i] - halfMax) / (profile[i] - profile[i - 1]);
          break;
      }
  }
   // Handle case where peak is at the very end of profile and is above halfMax
   if (right === -1 && profile[profile.length - 1] >= halfMax && profile.length > 1 && profile[profile.length - 1] > profile[profile.length - 2]) {
      right = profile.length - 1;
  }


  const fwhm = (left !== -1 && right !== -1 && right > left) ? Math.abs(right - left) : 0;
  if (addLog && fwhm > 0 && peak > (DETECTOR_MIN_BRIGHTNESS * 1.5)) { // Log only for reasonably bright peaks
     addLog(`[FWHM EST] At (${x},${y}): Peak=${peak.toFixed(1)}, HM=${halfMax.toFixed(1)}, L=${left.toFixed(2)}, R=${right.toFixed(2)}, FWHM=${fwhm.toFixed(2)}`);
  } else if (addLog && fwhm === 0 && peak > (DETECTOR_MIN_BRIGHTNESS * 1.5)) {
     addLog(`[FWHM EST WARN] At (${x},${y}): FWHM is 0. Peak=${peak.toFixed(1)}, L=${left.toFixed(1)}, R=${right.toFixed(1)}`);
  }
  return fwhm;
}


function isFarEnough(stars: DetectedStarPoint[], x: number, y: number, minDistance: number): boolean {
  for (const star of stars) {
    const dx = star.x - x;
    const dy = star.y - y;
    if (Math.sqrt(dx * dx + dy * dy) < minDistance) return false;
  }
  return true;
}

function detectStarsWithNewPipeline(
    grayscaleImage: number[][],
    addLog: (message: string) => void
): DetectedStarPoint[] {
  const height = grayscaleImage.length;
  const width = grayscaleImage[0]?.length || 0;

  if (height === 0 || width === 0) {
    addLog("[DETECTOR ERROR] Input grayscale image is empty. Cannot detect stars.");
    return [];
  }
  addLog(`[DETECTOR] Starting detection on ${width}x${height} grayscale. Config: MinContrast=${DETECTOR_MIN_CONTRAST}, MinBright=${DETECTOR_MIN_BRIGHTNESS}, MaxBright=${DETECTOR_MAX_BRIGHTNESS}, MinDist=${DETECTOR_MIN_DISTANCE}, MaxStars=${DETECTOR_MAX_STARS}, MinFWHM=${DETECTOR_MIN_FWHM}, MaxFWHM=${DETECTOR_MAX_FWHM}, Margin=${DETECTOR_MARGIN}, FlatTol=${DETECTOR_FLATNESS_TOLERANCE}`);

  const candidates: DetectedStarPoint[] = [];
  let consideredPixels = 0;
  let passedBrightness = 0;
  let passedContrast = 0;
  let passedFWHMCount = 0;
  let passedFlatnessAndLocalMax = 0;

  for (let y = DETECTOR_MARGIN; y < height - DETECTOR_MARGIN; y++) {
    for (let x = DETECTOR_MARGIN; x < width - DETECTOR_MARGIN; x++) {
      consideredPixels++;
      const value = grayscaleImage[y][x];

      if (value < DETECTOR_MIN_BRIGHTNESS || value > DETECTOR_MAX_BRIGHTNESS) {
        if (value > DETECTOR_MAX_BRIGHTNESS && value > (DETECTOR_MIN_BRIGHTNESS * 2) && addLog) addLog(`[DETECTOR REJECT BRIGHT] (${x},${y}) val ${value.toFixed(0)} > MAX_BRIGHTNESS ${DETECTOR_MAX_BRIGHTNESS}`);
        continue;
      }
      passedBrightness++;

      const contrast = getLocalContrast(grayscaleImage, x, y, addLog);
      if (contrast < DETECTOR_MIN_CONTRAST) {
        if (value > DETECTOR_MIN_BRIGHTNESS && addLog) addLog(`[DETECTOR REJECT CONTRAST] (${x},${y}) val ${value.toFixed(0)}, contrast ${contrast.toFixed(1)} < MIN_CONTRAST ${DETECTOR_MIN_CONTRAST}`);
        continue;
      }
      passedContrast++;
      
      const fwhm = estimateFWHM(grayscaleImage, x, y, DETECTOR_FWHM_PROFILE_HALF_WIDTH, addLog);
      if (fwhm < DETECTOR_MIN_FWHM || fwhm > DETECTOR_MAX_FWHM) {
        if (value > DETECTOR_MIN_BRIGHTNESS && fwhm !==0 && addLog) addLog(`[DETECTOR REJECT FWHM] (${x},${y}) val ${value.toFixed(0)}, FWHM ${fwhm.toFixed(1)} out of [${DETECTOR_MIN_FWHM}-${DETECTOR_MAX_FWHM}]`);
        else if (value > DETECTOR_MIN_BRIGHTNESS && fwhm === 0 && DETECTOR_MIN_FWHM > 0 && addLog) addLog(`[DETECTOR REJECT FWHM ZERO] (${x},${y}) val ${value.toFixed(0)}, FWHM is 0, less than MIN_FWHM ${DETECTOR_MIN_FWHM}`);
        continue;
      }
      passedFWHMCount++;

      // Local maximum and flatness check
      const neighbors = [
        grayscaleImage[y - 1][x], grayscaleImage[y + 1][x],
        grayscaleImage[y][x - 1], grayscaleImage[y][x + 1],
      ];
      const tooFlat = neighbors.every(n => Math.abs(n - value) <= DETECTOR_FLATNESS_TOLERANCE);
      if (tooFlat) {
        if (value > DETECTOR_MIN_BRIGHTNESS && addLog) addLog(`[DETECTOR REJECT FLAT] (${x},${y}) Too flat. Val: ${value.toFixed(0)}, N: ${neighbors.map(n=>n.toFixed(0)).join(',')}`);
        continue;
      }
      if (!(value > neighbors[0] && value > neighbors[1] && value > neighbors[2] && value > neighbors[3])) {
        if (value > DETECTOR_MIN_BRIGHTNESS && addLog) addLog(`[DETECTOR REJECT LOCALMAX] (${x},${y}) Not local max. Val: ${value.toFixed(0)}, N: ${neighbors.map(n=>n.toFixed(0)).join(',')}`);
           continue;
      }
      passedFlatnessAndLocalMax++;

      candidates.push({ x, y, value, contrast, fwhm });
    }
  }
  addLog(`[DETECTOR STATS] Considered: ${consideredPixels}, Passed Brightness: ${passedBrightness}, Contrast: ${passedContrast}, FWHM: ${passedFWHMCount}, Flatness/LocalMax: ${passedFlatnessAndLocalMax}, Initial Candidates: ${candidates.length}`);

  // Stable sort by significance (brightness * contrast)
  candidates.sort((a, b) => (b.value * b.contrast) - (a.value * a.contrast));

  const stars: DetectedStarPoint[] = [];
  for (const cand of candidates) {
    if (stars.length >= DETECTOR_MAX_STARS) break;
    if (isFarEnough(stars, cand.x, cand.y, DETECTOR_MIN_DISTANCE)) {
      stars.push(cand);
    }
  }

  if (stars.length > 0) {
    addLog(`[DETECTOR] Found ${stars.length} stars after all filters. Top star ex: (${stars[0]?.x}, ${stars[0]?.y}) Val:${stars[0]?.value.toFixed(1)} FWHM:${stars[0]?.fwhm.toFixed(1)} Contrast:${stars[0]?.contrast.toFixed(1)}`);
  } else {
    addLog(`[DETECTOR WARN] No stars found after all filters.`);
  }
  return stars;
}

// --- End of New Star Detector (Self-Contained) Functions ---


function calculateStarArrayCentroid(starsInput: Star[], addLog: (message: string) => void): { x: number; y: number } | null {
  if (!starsInput || starsInput.length === 0) {
    addLog(`[ALIGN WARN] No stars provided for star-based centroid calculation.`);
    return null;
  }
  if (starsInput.length < MIN_STARS_FOR_CENTROID_ALIGNMENT) {
     const message = `Not enough stars (${starsInput.length}) provided for star-based centroid. Need at least ${MIN_STARS_FOR_CENTROID_ALIGNMENT}.`;
     addLog(`[ALIGN] ${message}`);
     return null;
  }

  addLog(`[ALIGN] Calculating centroid from ${starsInput.length} provided stars for alignment.`);

  let totalBrightness = 0;
  let weightedX = 0;
  let weightedY = 0;

  for (const star of starsInput) {
    weightedX += star.x * star.brightness;
    weightedY += star.y * star.brightness;
    totalBrightness += star.brightness;
  }

  if (totalBrightness === 0) {
    if (starsInput.length > 0) {
        // If brightness is zero but stars exist, use simple average of positions
        const warnMsg = "Total brightness of provided stars is zero. Using simple average of their positions.";
        addLog(`[ALIGN WARN] ${warnMsg}`);
        let sumX = 0;
        let sumY = 0;
        for (const star of starsInput) {
            sumX += star.x;
            sumY += star.y;
        }
        return { x: sumX / starsInput.length, y: sumY / starsInput.length};
    }
    addLog(`[ALIGN WARN] Total brightness of provided stars is zero and no stars to average. Cannot calculate star centroid.`);
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
        return { x: 0, y: 0 }; // Should ideally be width/2, height/2 but if w/h is 0, this is tricky
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
      // Fallback to geometric center if no bright pixels found
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

// Calculate local brightness centroid for refining manual star clicks
function calculateLocalBrightnessCentroid(
  fullImageData: ImageData,
  cropRect: { x: number; y: number; width: number; height: number },
  addLog: (message: string) => void,
  brightnessThreshold: number = MANUAL_STAR_CLICK_CENTROID_BRIGHTNESS_THRESHOLD
): { x: number; y: number } | null {
  const { data: fullData, width: fullWidth, height: fullHeight } = fullImageData;
  const { x: cropOriginX, y: cropOriginY, width: cropW, height: cropH } = cropRect;

  let totalBrightnessVal = 0;
  let weightedXSum = 0;
  let weightedYSum = 0;
  let brightPixelCount = 0;

  if (cropW <= 0 || cropH <= 0) {
    addLog(`[LOCAL CENTROID WARN] Crop window has zero or negative dimensions (${cropW}x${cropH}). Cannot calculate centroid.`);
    return null;
  }

  for (let yInCrop = 0; yInCrop < cropH; yInCrop++) {
    for (let xInCrop = 0; xInCrop < cropW; xInCrop++) {
      const currentFullImageX = cropOriginX + xInCrop;
      const currentFullImageY = cropOriginY + yInCrop;

      // Boundary checks for the full image
      if (currentFullImageX < 0 || currentFullImageX >= fullWidth || currentFullImageY < 0 || currentFullImageY >= fullHeight) {
        continue; // Skip pixels outside the full image bounds
      }

      const pixelStartIndex = (currentFullImageY * fullWidth + currentFullImageX) * 4;
      const r = fullData[pixelStartIndex];
      const g = fullData[pixelStartIndex + 1];
      const b = fullData[pixelStartIndex + 2];
      const pixelBrightness = 0.299 * r + 0.587 * g + 0.114 * b; // Grayscale conversion

      if (pixelBrightness > brightnessThreshold) {
        weightedXSum += xInCrop * pixelBrightness; // xInCrop is relative to the crop window
        weightedYSum += yInCrop * pixelBrightness; // yInCrop is relative to the crop window
        totalBrightnessVal += pixelBrightness;
        brightPixelCount++;
      }
    }
  }

  if (totalBrightnessVal === 0 || brightPixelCount === 0) {
    addLog(`[LOCAL CENTROID WARN] No bright pixels (threshold > ${brightnessThreshold}) found in local area [${cropOriginX},${cropOriginY},${cropW},${cropH}]. Failed to find local centroid.`);
    return null;
  }
  
  // The returned x, y are relative to the cropRect's origin
  return {
    x: weightedXSum / totalBrightnessVal,
    y: weightedYSum / totalBrightnessVal,
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
  if (arr.length < 2) return 0; // Std dev of 1 item is undefined or 0, 0 is safer here.
  const mean = meanVal === undefined ? calculateMean(arr) : meanVal;
  // Use (arr.length -1) for sample standard deviation, or arr.length for population.
  // For sigma clipping, population std dev (arr.length) is often used if the sample is assumed to be the "population" for that pixel stack.
  // However, sample (arr.length - 1) is more common generally. Let's stick to sample.
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
    if (currentValues.length < 2) break; // Cannot calculate std dev with less than 2 values

    const mean = calculateMean(currentValues);
    const stdDev = calculateStdDev(currentValues, mean);

    if (stdDev === 0) break; // All values are the same, no more clipping needed

    const lowerBound = mean - sigmaThreshold * stdDev;
    const upperBound = mean + sigmaThreshold * stdDev;

    const nextValues = currentValues.filter(val => val >= lowerBound && val <= upperBound);

    if (nextValues.length === currentValues.length) {
      // No values were clipped in this iteration, convergence.
      break;
    }
    currentValues = nextValues;
  }

  // If all values were clipped (e.g., very noisy data), return mean of original values as fallback
  if (!currentValues.length) {
    // console.warn("Sigma clipping resulted in an empty array. Returning mean of original values.");
    return calculateMean(initialValues);
  }
  return calculateMean(currentValues);
};

// Basic FITS to PNG Data URL converter (simplified)
// This function is simplified and might not handle all FITS variations.
const processFitsFileToDataURL_custom = async (file: File, addLog: (message: string) => void): Promise<string | null> => {
  addLog(`[FITS] Starting custom FITS processing for: ${file.name}`);
  try {
    const arrayBuffer = await file.arrayBuffer();
    const dataView = new DataView(arrayBuffer);

    // Read FITS header (simplified - assumes simple FITS, one HDU)
    let headerText = "";
    let headerOffset = 0;
    const blockSize = 2880; // FITS block size

    addLog(`[FITS] Reading header blocks...`);
    while (headerOffset < arrayBuffer.byteLength) {
      const blockEnd = Math.min(headerOffset + blockSize, arrayBuffer.byteLength);
      const block = new TextDecoder().decode(arrayBuffer.slice(headerOffset, blockEnd));
      headerText += block;
      headerOffset = blockEnd;
      if (block.includes("END                                                                             ")) {
        // Basic check for END card
        break;
      }
      if (headerOffset >= arrayBuffer.byteLength) {
         addLog(`[FITS WARN] Reached end of file while reading header, END card not found precisely. Last block: ${block.substring(0,100)}...`);
         break; // Avoid infinite loop on malformed headers
      }
    }
    addLog(`[FITS] Header reading complete. Total header size: ${headerOffset} bytes.`);


    // Parse essential keywords (very basic parsing)
    const cards = headerText.match(/.{1,80}/g) || [];
    const headerMap: Record<string, string> = {};
    for (const card of cards) {
      if (card.trim() === "END") break;
      const parts = card.split("=");
      if (parts.length > 1) {
        const key = parts[0].trim();
        const valuePart = parts.slice(1).join("=").trim();
        headerMap[key] = valuePart.split("/")[0].trim().replace(/'/g, ""); // Remove comments and quotes
      } else {
         // Log non-empty cards that don't have an equals, excluding typical ones
         const cardType = card.substring(0,8).trim();
         if (card.trim() !== "" && !["COMMENT", "HISTORY", ""].includes(cardType)) {
            addLog(`[FITS HEADER WARN] Skipping card without '=' (potentially non-standard): '${card}' (Type: ${cardType})`);
         }
      }
    }
    addLog(`[FITS] Parsed ${Object.keys(headerMap).length} header cards.`);


    const bitpix = parseInt(headerMap["BITPIX"]);
    const naxis = parseInt(headerMap["NAXIS"]);
    let width = 0;
    let height = 0;

    if (naxis >= 1) width = parseInt(headerMap["NAXIS1"]);
    if (naxis >= 2) height = parseInt(headerMap["NAXIS2"]);
    if (naxis > 2) addLog(`[FITS WARN] NAXIS is ${naxis}. Will process first 2D plane (${width}x${height}).`);


    if (isNaN(bitpix) || isNaN(naxis) || isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
      addLog(`[FITS ERROR] Invalid or missing FITS header keywords: BITPIX=${bitpix}, NAXIS=${naxis}, NAXIS1=${width}, NAXIS2=${height}. Cannot process.`);
      console.error("Invalid FITS header data:", headerMap);
      return null;
    }
    addLog(`[FITS] Dimensions: ${width}x${height}, BITPIX: ${bitpix}`);


    const bytesPerPixel = Math.abs(bitpix) / 8;
    const pixelCount = width * height;
    const rawPixelData = new Float32Array(pixelCount); // Use Float32Array for easier math, then normalize

    const imageDataOffset = headerOffset; // Data starts after header blocks
    addLog(`[FITS] Image data starting at offset: ${imageDataOffset}`);


    if (imageDataOffset + pixelCount * bytesPerPixel > arrayBuffer.byteLength) {
      addLog(`[FITS ERROR] Calculated image data size (${pixelCount * bytesPerPixel} bytes at offset ${imageDataOffset}) exceeds file size (${arrayBuffer.byteLength} bytes). Header might be malformed or file truncated.`);
      return null;
    }

    const isBigEndian = true; // FITS standard is big-endian, but some files might vary. Defaulting to standard.

    // Read pixel data
    for (let i = 0; i < pixelCount; i++) {
      const pixelByteOffset = imageDataOffset + i * bytesPerPixel;
      try {
        if (bitpix === 8) { // Unsigned 8-bit integer
            rawPixelData[i] = dataView.getUint8(pixelByteOffset);
        } else if (bitpix === 16) { // Signed 16-bit integer
            rawPixelData[i] = dataView.getInt16(pixelByteOffset, !isBigEndian);
        } else if (bitpix === 32) { // Signed 32-bit integer
            rawPixelData[i] = dataView.getInt32(pixelByteOffset, !isBigEndian);
        } else if (bitpix === -32) { // IEEE 32-bit float
            rawPixelData[i] = dataView.getFloat32(pixelByteOffset, !isBigEndian);
        } else if (bitpix === -64) { // IEEE 64-bit float
            rawPixelData[i] = dataView.getFloat64(pixelByteOffset, !isBigEndian);
        }
         else {
          addLog(`[FITS ERROR] Unsupported BITPIX value: ${bitpix}. Cannot read pixel data. Reading first pixel and stopping.`);
          console.error("Unsupported BITPIX:", bitpix);
          return null; // Or handle specific common types if necessary
        }
      } catch (e) {
        addLog(`[FITS ERROR] Error reading pixel data at index ${i} (offset ${pixelByteOffset}): ${e instanceof Error ? e.message : String(e)}. File might be corrupted or BITPIX incorrect.`);
        return null;
      }
    }
    addLog(`[FITS] Raw pixel data read successfully.`);


    // Normalize pixel data to 0-255 for PNG (simple min-max scaling)
    let minVal = Infinity;
    let maxVal = -Infinity;
    for (let i = 0; i < pixelCount; i++) {
      if (rawPixelData[i] < minVal) minVal = rawPixelData[i];
      if (rawPixelData[i] > maxVal) maxVal = rawPixelData[i];
    }

    // Handle cases where min/max are problematic (e.g. all pixels same value, or NaNs)
    if (minVal === Infinity || maxVal === -Infinity || isNaN(minVal) || isNaN(maxVal) ) {
        addLog(`[FITS WARN] Could not determine valid min/max for normalization (min: ${minVal}, max: ${maxVal}). Image might be blank or contain only NaNs. Setting to default 0-255 range.`);
        minVal = 0;
        maxVal = 255; // Or could set image to black/gray
    }
    addLog(`[FITS] Normalization range: min=${minVal}, max=${maxVal}`);


    const normalizedPixels = new Uint8ClampedArray(pixelCount);
    const range = maxVal - minVal;
    if (range === 0) { // All pixels are the same value
      addLog(`[FITS WARN] Pixel data range is zero (all pixels are ${minVal}). Normalizing to mid-gray (128).`);
      for (let i = 0; i < pixelCount; i++) {
        normalizedPixels[i] = 128;
      }
    } else {
      for (let i = 0; i < pixelCount; i++) {
        normalizedPixels[i] = ((rawPixelData[i] - minVal) / range) * 255;
      }
    }
    addLog(`[FITS] Pixel data normalized to 0-255 range.`);

    // Create PNG data URL
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      addLog("[FITS ERROR] Could not get 2D context from canvas for FITS rendering.");
      return null;
    }

    const imgData = ctx.createImageData(width, height);
    for (let i = 0; i < pixelCount; i++) {
      const val = normalizedPixels[i];
      imgData.data[i * 4 + 0] = val; // R
      imgData.data[i * 4 + 1] = val; // G
      imgData.data[i * 4 + 2] = val; // B
      imgData.data[i * 4 + 3] = 255; // Alpha
    }
    ctx.putImageData(imgData, 0, 0);
    addLog(`[FITS] Image data rendered to canvas.`);

    const dataURL = canvas.toDataURL("image/png");
    addLog(`[FITS] Successfully converted ${file.name} to PNG data URL.`);
    return dataURL;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    addLog(`[FITS ERROR] Failed to process FITS file ${file.name}: ${errorMessage}`);
    console.error("FITS Processing Error:", error);
    return null;
  }
};


// Function to average multiple ImageData arrays into a master frame
// Used for creating master bias, dark, flat frames
const averageImageDataArrays = (imageDataArrays: ImageData[], targetWidth: number, targetHeight: number, addLog: (message: string) => void): Uint8ClampedArray | null => {
  if (!imageDataArrays || imageDataArrays.length === 0) {
    addLog("[CAL MASTER] No image data arrays provided for averaging.");
    return null;
  }

  const numImages = imageDataArrays.length;
  const totalPixels = targetWidth * targetHeight;
  const sumData = new Float32Array(totalPixels * 4); // Use Float32Array for sums to avoid clamping during summation

  let validImagesProcessed = 0;
  for (const imgData of imageDataArrays) {
    // Ensure dimensions match the target before processing
    if (imgData.width !== targetWidth || imgData.height !== targetHeight) {
      addLog(`[CAL MASTER WARN] Skipping image data in average due to dimension mismatch. Expected ${targetWidth}x${targetHeight}, got ${imgData.width}x${imgData.height}. This frame will not be part of the master.`);
      continue; // Skip this image data
    }
    for (let i = 0; i < imgData.data.length; i++) {
      sumData[i] += imgData.data[i];
    }
    validImagesProcessed++;
  }
  
  if (validImagesProcessed === 0) {
    addLog("[CAL MASTER ERROR] No valid images with matching dimensions found for averaging. Cannot create master frame.");
    return null;
  }

  const averagedData = new Uint8ClampedArray(totalPixels * 4);
  for (let i = 0; i < sumData.length; i++) {
    averagedData[i] = sumData[i] / validImagesProcessed; // Average and clamp
  }
  addLog(`[CAL MASTER] Averaged ${validImagesProcessed} image data arrays into a master frame.`);
  return averagedData;
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
  const [currentEditingImageData, setCurrentEditingImageData] = useState<ImageData | null>(null); // For precise manual star placement


  const [showApplyStarOptionsMenu, setShowApplyStarOptionsMenu] = useState(false);
  const [sourceImageForApplyMenu, setSourceImageForApplyMenu] = useState<SourceImageForApplyMenu | null>(null);
  const [isApplyingStarsFromMenu, setIsApplyingStarsFromMenu] = useState(false);


  // Post-processing state
  const [showPostProcessEditor, setShowPostProcessEditor] = useState(false);
  const [imageForPostProcessing, setImageForPostProcessing] = useState<string | null>(null);
  const [editedPreviewUrl, setEditedPreviewUrl] = useState<string | null>(null); // For live preview in editor

  const [brightness, setBrightness] = useState(100); // Percentage (0-200, 100 is no change)
  const [exposure, setExposure] = useState(0); // Stops (-100 to 100, 0 is no change)
  const [saturation, setSaturation] = useState(100); // Percentage (0-200, 100 is no change)
  const [isApplyingAdjustments, setIsApplyingAdjustments] = useState(false);

  // State for calibration frames
  const [darkFrameFiles, setDarkFrameFiles] = useState<File[]>([]);
  const [darkFramePreviewUrls, setDarkFramePreviewUrls] = useState<string[]>([]);
  const [originalDarkFrameDimensionsList, setOriginalDarkFrameDimensionsList] = useState<Array<{ width: number; height: number } | null>>([]);
  const [useDarkFrames, setUseDarkFrames] = useState<boolean>(false);
  const [isProcessingDarkFrames, setIsProcessingDarkFrames] = useState(false);

  const [flatFrameFiles, setFlatFrameFiles] = useState<File[]>([]);
  const [flatFramePreviewUrls, setFlatFramePreviewUrls] = useState<string[]>([]);
  const [originalFlatFrameDimensionsList, setOriginalFlatFrameDimensionsList] = useState<Array<{ width: number; height: number } | null>>([]);
  const [useFlatFrames, setUseFlatFrames] = useState<boolean>(false);
  const [isProcessingFlatFrames, setIsProcessingFlatFrames] = useState(false);

  const [biasFrameFiles, setBiasFrameFiles] = useState<File[]>([]);
  const [biasFramePreviewUrls, setBiasFramePreviewUrls] = useState<string[]>([]);
  const [originalBiasFrameDimensionsList, setOriginalBiasFrameDimensionsList] = useState<Array<{ width: number; height: number } | null>>([]);
  const [useBiasFrames, setUseBiasFrames] = useState<boolean>(false);
  const [isProcessingBiasFrames, setIsProcessingBiasFrames] = useState(false);


  const addLog = useCallback((message: string) => {
    setLogs(prevLogs => {
      const newLog = {
        id: logIdCounter.current++,
        timestamp: new Date().toLocaleTimeString(),
        message
      };
      const updatedLogs = [newLog, ...prevLogs];
      return updatedLogs.slice(0, 100); // Keep only the last 100 logs
    });
  }, []);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = 0; // Auto-scroll to top (newest log)
    }
  }, [logs]);

  // Effect for live updating post-processing preview
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
          outputFormat, // Use current output format for preview
          jpegQuality / 100 // Use current JPEG quality for preview
        );
        setEditedPreviewUrl(adjustedUrl);
      } catch (error) {
        console.error("Error applying image adjustments:", error);
        toast({
          title: "Adjustment Error",
          description: "Could not apply image adjustments.",
          variant: "destructive",
        });
        setEditedPreviewUrl(imageForPostProcessing); // Fallback to original on error
      } finally {
        setIsApplyingAdjustments(false);
      }
    };

    // Debounce adjustments to avoid excessive processing
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
        
        let originalPreviewUrl: string | null = null;

        if (fileName.endsWith(".fits") || fileName.endsWith(".fit")) {
            addLog(`[FITS] Detected FITS file: ${file.name}. Processing with custom parser...`);
            originalPreviewUrl = await processFitsFileToDataURL_custom(file, addLog);
            if (!originalPreviewUrl) {
                toast({
                    title: "FITS Processing Failed",
                    description: `Could not process FITS file ${file.name}. Please check logs.`,
                    variant: "destructive",
                    duration: 8000,
                });
                return null;
            }
             addLog(`[FITS] Successfully generated preview for ${file.name}.`);
        } else if (fileType === 'image/x-adobe-dng' || fileName.endsWith('.dng')) {
          // DNG files can be read by fileToDataURL to get *some* preview, but it's often just the embedded JPG.
          // Full DNG processing is beyond browser capabilities without heavy libraries.
          const dngMsg = `${file.name} is a DNG. Direct browser preview might be limited or slow. Manual conversion to JPG/PNG is recommended for best results.`;
          addLog(`[WARN] ${dngMsg}`);
          toast({
            title: "DNG File Detected",
            description: dngMsg,
            variant: "default", // "default" or a custom variant for warnings
            duration: 8000,
          });
          originalPreviewUrl = await fileToDataURL(file); // Attempt to get a basic preview

        } else if (acceptedWebTypes.includes(fileType)) {
            originalPreviewUrl = await fileToDataURL(file);
        } else {
            // Unsupported type
            const unsupportedMsg = `${file.name} is unsupported. Use JPG, PNG, GIF, WEBP or FITS.`;
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


        // Load the original preview to get dimensions and potentially downscale
        return new Promise<ImageStarEntry | null>((resolveEntry) => {
            const img = new Image();
            img.onload = async () => {
                const { naturalWidth, naturalHeight } = img;
                let processedPreviewUrl = originalPreviewUrl!; // Start with the original/FITS-converted URL
                let finalDimensions = { width: naturalWidth, height: naturalHeight };

                // Check if image is "large" and prompt for downscaling
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

                            // Calculate new dimensions maintaining aspect ratio
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
                            ctx.drawImage(img, 0, 0, targetWidth, targetHeight); // Draw the original image (from img.src) downscaled

                            processedPreviewUrl = canvas.toDataURL('image/png'); // Use PNG for downscaled preview to preserve quality
                            finalDimensions = { width: targetWidth, height: targetHeight };
                            addLog(`Downscaled ${file.name} preview to ${targetWidth}x${targetHeight}.`);
                        }
                    } else {
                        addLog(`User declined downscaling for ${file.name}. Using original preview resolution: ${naturalWidth}x${naturalHeight}.`);
                    }
                }

                resolveEntry({
                    id: `${file.name}-${Date.now()}-${Math.random()}`, // More unique ID
                    file,
                    previewUrl: processedPreviewUrl, // This is now the potentially downscaled preview
                    analysisStars: [],
                    initialAutoStars: [],
                    analysisDimensions: finalDimensions, // Store the dimensions of the previewUrl used for analysis
                    userReviewed: false,
                    isAnalyzed: false,
                    isAnalyzing: false,
                    starSelectionMode: 'auto',
                });
            };
            img.onerror = () => {
                // This error means the originalPreviewUrl (from fileToDataURL or FITS conversion) itself couldn't be loaded into an Image element
                const errorMessage = `Could not load generated preview image ${file.name} to check dimensions. This can happen if the data URL is invalid or too large. FITS files may produce large data URLs.`;
                addLog(`[ERROR] ${errorMessage}`);
                toast({ title: "Error Reading Preview", description: errorMessage, variant: "destructive" });
                resolveEntry(null);
            };
            img.src = originalPreviewUrl!; // Load the initial data URL (original or FITS-converted)
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


 const handleCalibrationFramesAdded = async (
    uploadedFiles: File[],
    frameType: 'dark' | 'flat' | 'bias',
    setFilesState: React.Dispatch<React.SetStateAction<File[]>>,
    setPreviewUrlsState: React.Dispatch<React.SetStateAction<string[]>>,
    setOriginalDimensionsListState: React.Dispatch<React.SetStateAction<Array<{ width: number; height: number } | null>>>,
    setIsProcessingState: React.Dispatch<React.SetStateAction<boolean>>
  ) => {
    if (uploadedFiles.length === 0) return;
    const frameTypeName = frameType.charAt(0).toUpperCase() + frameType.slice(1);
    addLog(`Processing ${uploadedFiles.length} ${frameType} frame(s)...`);
    setIsProcessingState(true);

    const newFiles: File[] = [];
    const newPreviewUrls: string[] = [];
    const newOriginalDimensions: Array<{ width: number; height: number } | null> = [];

    for (const file of uploadedFiles) {
      addLog(`[CAL] Processing ${frameType} frame: ${file.name}`);
      try {
        const fileType = file.type.toLowerCase();
        const fileName = file.name.toLowerCase();
        const acceptedWebTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        let previewUrl: string | null = null;

        if (fileName.endsWith(".fits") || fileName.endsWith(".fit")) {
          addLog(`[FITS] Detected FITS ${frameTypeName} frame: ${file.name}. Custom parsing...`);
          previewUrl = await processFitsFileToDataURL_custom(file, addLog);
          if (!previewUrl) {
            toast({ title: `FITS ${frameTypeName} Fail`, description: `Could not process FITS ${file.name}. Logs have details.`, variant: "destructive" });
            continue; // Skip this file
          }
        } else if (!acceptedWebTypes.includes(fileType)) {
          addLog(`[ERROR] Unsupported ${frameTypeName} frame ${file.name}. Use JPG, PNG, GIF, WEBP, or FITS.`);
          toast({ title: `Unsupported ${frameTypeName} Frame`, description: `${file.name} is unsupported.`, variant: "destructive" });
          continue; // Skip this file
        } else {
          previewUrl = await fileToDataURL(file);
        }

        if (!previewUrl) {
          addLog(`[ERROR] Could not generate preview for ${frameType} frame ${file.name}.`);
          continue; // Skip this file
        }
        
        // Get dimensions from the generated preview URL
        const img = new Image();
        const dimensions = await new Promise<{width: number, height: number} | null>((resolveDim) => {
            img.onload = () => resolveDim({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => {
                addLog(`[ERROR] Could not load ${frameType} frame ${file.name} to get dimensions.`);
                toast({ title: `Error Loading ${frameTypeName}`, description: `Could not load ${file.name}.`, variant: "destructive" });
                resolveDim(null);
            };
            img.src = previewUrl!;
        });

        if (dimensions) {
            newFiles.push(file);
            newPreviewUrls.push(previewUrl);
            newOriginalDimensions.push(dimensions);
            addLog(t(`log${frameTypeName}FrameLoaded` as any, { fileName: file.name, width: dimensions.width, height: dimensions.height }));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        addLog(`[ERROR] Processing ${frameType} frame ${file.name}: ${errorMessage}`);
        toast({ title: `Error Processing ${frameTypeName}`, description: errorMessage, variant: "destructive" });
      }
    }

    setFilesState(prev => [...prev, ...newFiles]);
    setPreviewUrlsState(prev => [...prev, ...newPreviewUrls]);
    setOriginalDimensionsListState(prev => [...prev, ...newOriginalDimensions]);
    setIsProcessingState(false);
    addLog(`Finished adding ${newFiles.length} ${frameType} frames.`);
  };

  const handleDarkFramesAdded = (files: File[]) => handleCalibrationFramesAdded(files, 'dark', setDarkFrameFiles, setDarkFramePreviewUrls, setOriginalDarkFrameDimensionsList, setIsProcessingDarkFrames);
  const handleFlatFramesAdded = (files: File[]) => handleCalibrationFramesAdded(files, 'flat', setFlatFrameFiles, setFlatFramePreviewUrls, setOriginalFlatFrameDimensionsList, setIsProcessingFlatFrames);
  const handleBiasFramesAdded = (files: File[]) => handleCalibrationFramesAdded(files, 'bias', setBiasFrameFiles, setBiasFramePreviewUrls, setOriginalBiasFrameDimensionsList, setIsProcessingBiasFrames);

  const handleRemoveImage = (idToRemove: string) => {
    const entry = allImageStarData.find(entry => entry.id === idToRemove);
    const fileName = entry?.file?.name || `image with id ${idToRemove}`;
    setAllImageStarData(prev => prev.filter(item => item.id !== idToRemove));
    addLog(`Removed ${fileName} from queue.`);
  };
  
  const handleRemoveCalibrationFrame = (
    indexToRemove: number,
    frameType: 'dark' | 'flat' | 'bias',
    setFilesState: React.Dispatch<React.SetStateAction<File[]>>,
    setPreviewUrlsState: React.Dispatch<React.SetStateAction<string[]>>,
    setOriginalDimensionsListState: React.Dispatch<React.SetStateAction<Array<{ width: number; height: number } | null>>>
  ) => {
    // Get filename before removing for logging
    const fileName = setFilesState(prev => {
        const file = prev[indexToRemove];
        return file ? file.name : `frame at index ${indexToRemove}`;
    }); 
    addLog(`Removing ${frameType} frame: ${fileName} at index ${indexToRemove}`);
    setFilesState(prev => prev.filter((_, index) => index !== indexToRemove));
    setPreviewUrlsState(prev => prev.filter((_, index) => index !== indexToRemove));
    setOriginalDimensionsListState(prev => prev.filter((_, index) => index !== indexToRemove));
  };

  const handleRemoveDarkFrame = (index: number) => handleRemoveCalibrationFrame(index, 'dark', setDarkFrameFiles, setDarkFramePreviewUrls, setOriginalDarkFrameDimensionsList);
  const handleRemoveFlatFrame = (index: number) => handleRemoveCalibrationFrame(index, 'flat', setFlatFrameFiles, setFlatFramePreviewUrls, setOriginalFlatFrameDimensionsList);
  const handleRemoveBiasFrame = (index: number) => handleRemoveCalibrationFrame(index, 'bias', setBiasFrameFiles, setBiasFramePreviewUrls, setOriginalBiasFrameDimensionsList);


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

  // Wrapper function to call the self-contained star detector
  // This function is intended to be the main entry point for star analysis of an ImageStarEntry
  const analyzeImageForStars = async (
    entryToAnalyze: ImageStarEntry,
    localAddLog: (message: string) => void
  ): Promise<ImageStarEntry> => { // Return the processed entry
    let workingEntry = { ...entryToAnalyze, isAnalyzing: true, isAnalyzed: false };
    localAddLog(`[ANALYZE] Starting analysis for: ${workingEntry.file.name}`);
  
    try {
      const imgEl = await loadImage(workingEntry.previewUrl, workingEntry.file.name);
  
      // Use a temporary canvas for analysis at the entry's analysisDimensions
      const tempAnalysisCanvas = document.createElement('canvas');
      const tempAnalysisCtx = tempAnalysisCanvas.getContext('2d', { willReadFrequently: true });
      if (!tempAnalysisCtx) {
        throw new Error("Could not get analysis canvas context.");
      }
  
      const analysisWidth = workingEntry.analysisDimensions.width;
      const analysisHeight = workingEntry.analysisDimensions.height;
  
      tempAnalysisCanvas.width = analysisWidth;
      tempAnalysisCanvas.height = analysisHeight;
      tempAnalysisCtx.drawImage(imgEl, 0, 0, analysisWidth, analysisHeight);
      
      localAddLog(`[ANALYZE] Canvas prepared for ${workingEntry.file.name} at ${analysisWidth}x${analysisHeight}.`);
  
      // Get grayscale data from this specific analysis canvas
      const grayscaleImageArray = getGrayscaleArrayFromCanvas(tempAnalysisCtx, localAddLog);
      if (grayscaleImageArray.length === 0 || grayscaleImageArray[0]?.length === 0) {
          localAddLog(`[ANALYZE ERROR] Failed to convert canvas to valid grayscale array for star detection.`);
          throw new Error("Failed to convert canvas to valid grayscale array for star detection.");
      }
      
      // Call the new self-contained pipeline
      const detectedPoints: DetectedStarPoint[] = detectStarsWithNewPipeline(grayscaleImageArray, localAddLog);
      
      localAddLog(`[ANALYZE] Detected ${detectedPoints.length} potential star points in ${workingEntry.file.name}.`);
      
      // Convert detected points to the application's Star interface
      const finalStars: Star[] = detectedPoints.map(pStar => ({
        x: pStar.x, // These are coordinates in the analysisDimensions space
        y: pStar.y, // These are coordinates in the analysisDimensions space
        brightness: pStar.value, // Using the 'value' from detector as brightness
        fwhm: pStar.fwhm,
        isManuallyAdded: false,
      }));
  
      workingEntry = {
        ...workingEntry,
        initialAutoStars: [...finalStars], // Store all auto-detected stars
        analysisDimensions: { width: analysisWidth, height: analysisHeight }, // Confirm dimensions used
        isAnalyzed: true,
        isAnalyzing: false,
      };

      // If mode is auto, or if manual but not yet reviewed, populate analysisStars
      if (workingEntry.starSelectionMode === 'auto' || (workingEntry.starSelectionMode === 'manual' && !workingEntry.userReviewed)) {
        workingEntry.analysisStars = [...finalStars];
      }
      localAddLog(`[ANALYZE] Analysis successful for ${workingEntry.file.name}. Stars detected: ${finalStars.length}. IsAnalyzed: true.`);
  
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      localAddLog(`[ANALYZE ERROR] Analysis failed for ${entryToAnalyze.file.name}: ${errorMessage}`);
      toast({ title: `Analysis Failed for ${entryToAnalyze.file.name}`, description: errorMessage, variant: "destructive" });
      workingEntry = {
        ...workingEntry,
        isAnalyzing: false,
        isAnalyzed: false, // Explicitly false on error
        analysisStars: [], // Clear stars on error
        initialAutoStars: [] // Clear initial stars on error
      };
    }
    
    // Update the global state for this specific entry
    setAllImageStarData(prev => prev.map(e => e.id === workingEntry.id ? workingEntry : e));
    return workingEntry; // Return the processed entry
  }


  const handleToggleStarSelectionMode = async (imageId: string) => {
    let imageIndex = -1;
    const entryToUpdate = allImageStarData.find((e, idx) => {
      if (e.id === imageId) {
        imageIndex = idx;
        return true;
      }
      return false;
    });

    if (!entryToUpdate || imageIndex === -1) return;

    const newMode = entryToUpdate.starSelectionMode === 'auto' ? 'manual' : 'auto';
    addLog(`Star selection mode for ${entryToUpdate.file.name} changed to ${newMode}.`);

    let updatedEntry: ImageStarEntry = {
      ...entryToUpdate,
      starSelectionMode: newMode,
      userReviewed: false, // Reset review status when mode changes
    };

    if (newMode === 'auto') {
      // If switching to auto, ensure analysisStars reflects initialAutoStars
      updatedEntry.analysisStars = [...updatedEntry.initialAutoStars];
      setAllImageStarData(prev => prev.map(e => e.id === imageId ? updatedEntry : e));
    } else { // Switching to manual
        // If switching to manual, and analysisStars is empty but initialAutoStars is not, populate it.
        // This provides a starting point for manual editing if auto-detection ran.
        if ((!updatedEntry.analysisStars || updatedEntry.analysisStars.length === 0) && updatedEntry.initialAutoStars.length > 0) {
           updatedEntry.analysisStars = [...updatedEntry.initialAutoStars];
        }
        setAllImageStarData(prev => prev.map(e => e.id === imageId ? updatedEntry : e));
        
        // If switching to manual and not analyzed, trigger analysis
        // The analysis function will populate initialAutoStars and analysisStars if mode is manual&unreviewed
        if (!updatedEntry.isAnalyzed && !updatedEntry.isAnalyzing) {
            addLog(`Image ${updatedEntry.file.name} switched to manual mode, and needs analysis. Analyzing now...`);
            // analyzeImageForStars will update the global state internally
            await analyzeImageForStars(updatedEntry, addLog);
        }
    }
  };

  const handleEditStarsRequest = async (imageIndex: number) => {
    const currentEntryFromState = allImageStarData[imageIndex];
    if (!currentEntryFromState) return;

    setCurrentEditingImageData(null); // Reset image data for precise click

    let entryForEditing = {...currentEntryFromState};

    // If current mode is 'auto', or if it's 'manual' but unreviewed and has no analysis stars,
    // ensure it's set to 'manual' and pre-populate analysisStars from initialAutoStars if available.
    if (entryForEditing.starSelectionMode === 'auto' ||
        (entryForEditing.starSelectionMode === 'manual' && !entryForEditing.userReviewed && entryForEditing.analysisStars.length === 0)) {
      addLog(`Preparing ${entryForEditing.file.name} for manual editing (or unreviewed manual). Mode set to manual.`);
      entryForEditing.starSelectionMode = 'manual'; // Explicitly set to manual
      if (entryForEditing.initialAutoStars.length > 0) { // If auto stars exist
          entryForEditing.analysisStars = [...entryForEditing.initialAutoStars]; // Use them as a base
      }
      entryForEditing.userReviewed = false; // Mark as not reviewed yet
      // Update state immediately before potentially lengthy analysis
      setAllImageStarData(prev => prev.map((e, idx) => idx === imageIndex ? entryForEditing : e));
      // Use the updated entry from state for the next check
      entryForEditing = allImageStarData.find(e => e.id === entryForEditing.id) || entryForEditing;
    }


    // If not analyzed, perform analysis first. analyzeImageForStars will handle populating stars.
    if (!entryForEditing.isAnalyzed && !entryForEditing.isAnalyzing) {
      addLog(`Analyzing ${entryForEditing.file.name} before editing stars.`);
      // Ensure mode is manual before analysis for editor opening.
      // analyzeImageForStars internally updates global state and returns the processed entry.
      const processedEntry = await analyzeImageForStars({...entryForEditing, starSelectionMode: 'manual'}, addLog);
      
      // Re-fetch entry after analysis to ensure we have the latest data from global state
      const finalEntryAfterAnalysis = allImageStarData.find(e => e.id === processedEntry.id);
      if (!finalEntryAfterAnalysis || !finalEntryAfterAnalysis.isAnalyzed) {
        toast({title: "Analysis Failed", description: `Could not analyze ${entryForEditing.file.name}. Cannot edit stars.`, variant: "destructive"});
        return; // Stop if analysis failed
      }
      entryForEditing = finalEntryAfterAnalysis; // Use the definitively analyzed entry

    } else if (entryForEditing.isAnalyzing) {
      toast({title: "Analysis in Progress", description: `Still analyzing ${entryForEditing.file.name}. Please wait.`});
      return;
    }
    
    // At this point, entryForEditing should be the latest version from state
    const finalEntryForEditing = allImageStarData.find(e => e.id === entryForEditing.id) || entryForEditing;


    if (finalEntryForEditing && finalEntryForEditing.isAnalyzed && finalEntryForEditing.analysisDimensions) {
      let starsToEdit = [...finalEntryForEditing.analysisStars];
      // Ensure manual mode is set if opening editor
      if (finalEntryForEditing.starSelectionMode !== 'manual') {
        setAllImageStarData(prev => prev.map((e, idx) =>
            idx === imageIndex ? {...e, starSelectionMode: 'manual' } : e
        ));
      }
      // If analysisStars is empty after analysis (e.g., no stars found by auto, or wiped previously)
      // and initialAutoStars has some content (from a successful detection), offer those as a base.
      if (starsToEdit.length === 0 && finalEntryForEditing.initialAutoStars.length > 0) {
          starsToEdit = [...finalEntryForEditing.initialAutoStars];
          addLog(`Populating editor for ${finalEntryForEditing.file.name} with ${starsToEdit.length} auto-detected stars as a base for manual editing.`);
          setAllImageStarData(prev => prev.map((e, idx) =>
              idx === imageIndex ? {...e, analysisStars: starsToEdit } : e
          ));
      }
      
      // Load ImageData for precise click calculation
      const imgToEdit = new Image();
      imgToEdit.onload = () => {
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = finalEntryForEditing.analysisDimensions.width;
          tempCanvas.height = finalEntryForEditing.analysisDimensions.height;
          const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
          if (tempCtx) {
              tempCtx.drawImage(imgToEdit, 0, 0, tempCanvas.width, tempCanvas.height);
              setCurrentEditingImageData(tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height));
              addLog(`Loaded ImageData (${tempCanvas.width}x${tempCanvas.height}) for ${finalEntryForEditing.file.name} for precise star editing.`);
          } else {
              setCurrentEditingImageData(null); // Fallback if context fails
              addLog(`[WARN] Could not get canvas context to load ImageData for ${finalEntryForEditing.file.name}. Precise click refinement disabled.`);
              toast({title: "Warning", description: `Could not prepare image data for ${finalEntryForEditing.file.name}. Precise click refinement disabled.`});
          }
          setCurrentEditingImageIndex(imageIndex);
          setIsStarEditingMode(true);
          addLog(`Opened star editor for ${finalEntryForEditing.file.name}. Mode: Manual. Initial stars for edit: ${starsToEdit.length}. Dim: ${finalEntryForEditing.analysisDimensions.width}x${finalEntryForEditing.analysisDimensions.height}`);
      };
      imgToEdit.onerror = () => {
          setCurrentEditingImageData(null); // Ensure it's null on error
          addLog(`[ERROR] Failed to load image ${finalEntryForEditing.file.name} for ImageData preparation for editor.`);
          toast({title: "Editor Error", description: `Could not load image ${finalEntryForEditing.file.name} for editing stars.`, variant: "destructive"});
          setIsStarEditingMode(false); // Don't open editor if image fails
      };
      imgToEdit.src = finalEntryForEditing.previewUrl; // Use the previewUrl (potentially downscaled)

    } else {
       // This case should be less likely if analysis is forced above
       console.warn(`Cannot edit stars for ${finalEntryForEditing?.file?.name || 'image'}: Analysis data, dimension data, or preview URL might be incomplete or loading failed.`);
       toast({title: "Error", description: `Could not prepare ${finalEntryForEditing?.file?.name || 'image'} for star editing. Analysis data may be missing.`, variant: "destructive"});
    }
  };

  // Handles click on the star annotation canvas. Adds/removes stars.
  const handleStarAnnotationClick = (clickedX_analysis: number, clickedY_analysis: number) => {
    if (currentEditingImageIndex === null) return;

    const entry = allImageStarData[currentEditingImageIndex];
    if (!entry || !entry.analysisDimensions) {
      addLog("[STAR EDIT ERROR] No valid image entry or analysis dimensions for star annotation.");
      return;
    }

    let finalStarX = clickedX_analysis;
    let finalStarY = clickedY_analysis;

    // If ImageData is available, try to refine click to local brightness centroid
    if (currentEditingImageData) {
      const searchRadius = MANUAL_STAR_CLICK_CENTROID_RADIUS;
      // Calculate crop rectangle origin ensuring it's within image bounds
      const cropRectX = Math.max(0, Math.round(clickedX_analysis) - searchRadius);
      const cropRectY = Math.max(0, Math.round(clickedY_analysis) - searchRadius);
      
      // Calculate crop rectangle dimensions ensuring it doesn't exceed image bounds
      const cropRectWidth = Math.min(
        currentEditingImageData.width - cropRectX, // Max width available from click to edge
        searchRadius * 2
      );
      const cropRectHeight = Math.min(
        currentEditingImageData.height - cropRectY, // Max height available from click to edge
        searchRadius * 2
      );

      if (cropRectWidth > 0 && cropRectHeight > 0) { // Ensure valid crop window
        const localCentroid = calculateLocalBrightnessCentroid(
          currentEditingImageData, 
          { x: cropRectX, y: cropRectY, width: cropRectWidth, height: cropRectHeight },
          addLog, 
          MANUAL_STAR_CLICK_CENTROID_BRIGHTNESS_THRESHOLD
        );

        if (localCentroid) {
          // Convert local centroid (relative to cropRect) back to full analysis image coordinates
          finalStarX = cropRectX + localCentroid.x;
          finalStarY = cropRectY + localCentroid.y;
          addLog(`Refined click from (${clickedX_analysis.toFixed(1)},${clickedY_analysis.toFixed(1)}) to local centroid (${finalStarX.toFixed(1)},${finalStarY.toFixed(1)}) in area of size ${cropRectWidth}x${cropRectHeight} around click.`);
        } else {
          addLog(`Local centroid not found near (${clickedX_analysis.toFixed(1)},${clickedY_analysis.toFixed(1)}). Using direct click position.`);
        }
      } else {
         addLog(`Invalid crop window for local centroid (${cropRectWidth}x${cropRectHeight}). Using direct click position.`);
      }
    } else {
      addLog("[STAR EDIT WARN] No ImageData available for local centroid calculation. Using direct click position.");
    }

    // Use dynamic click tolerance based on displayed canvas size vs analysis size
    // This makes clicks feel more consistent regardless of downscaling for display
    const effectiveCanvasDisplayWidth = Math.min(STAR_ANNOTATION_MAX_DISPLAY_WIDTH, entry.analysisDimensions.width);
    const clickToleranceInAnalysisUnits = effectiveCanvasDisplayWidth > 0 ? (STAR_CLICK_TOLERANCE_ON_DISPLAY_CANVAS_PX / effectiveCanvasDisplayWidth) * entry.analysisDimensions.width : STAR_CLICK_TOLERANCE_ON_DISPLAY_CANVAS_PX;
    const dynamicClickToleranceSquared = clickToleranceInAnalysisUnits * clickToleranceInAnalysisUnits;

    setAllImageStarData(prev => prev.map((item, idx) => {
      if (idx === currentEditingImageIndex) {
        let starFoundAndRemoved = false;
        const updatedStars = item.analysisStars.filter(star => {
          const dx = star.x - finalStarX; // Use refined click position for comparison
          const dy = star.y - finalStarY; // Use refined click position for comparison
          const distSq = dx * dx + dy * dy;
          if (distSq < dynamicClickToleranceSquared) {
            starFoundAndRemoved = true;
            addLog(`Removed star at (${star.x.toFixed(0)}, ${star.y.toFixed(0)}) from ${item.file.name} (click refined to ${finalStarX.toFixed(0)}, ${finalStarY.toFixed(0)}).`);
            return false; // Remove this star
          }
          return true; // Keep this star
        });

        if (!starFoundAndRemoved) {
          // Add new star at the refined position
          const newStar: Star = {
            x: finalStarX,
            y: finalStarY,
            brightness: 150, // Default brightness for manually added star
            fwhm: 2.5, // Default FWHM for manually added star
            isManuallyAdded: true,
          };
          updatedStars.push(newStar);
          addLog(`Added manual star at refined position (${finalStarX.toFixed(0)}, ${finalStarY.toFixed(0)}) to ${item.file.name}. Total stars: ${updatedStars.length}`);
        } else {
          addLog(`Total stars for ${item.file.name} after removal: ${updatedStars.length}`);
        }
        return { ...item, analysisStars: updatedStars, userReviewed: false }; // Mark as unreviewed after edit
      }
      return item;
    }));
  };

  const handleResetStars = () => {
    if (currentEditingImageIndex === null) return;
    setAllImageStarData(prev => prev.map((entry, idx) => {
      if (idx === currentEditingImageIndex) {
        addLog(`Stars reset to ${entry.initialAutoStars.length} auto-detected stars for ${entry.file.name}.`);
        return { ...entry, analysisStars: [...entry.initialAutoStars], userReviewed: false }; // Reset to initial auto, mark unreviewed
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
        return { ...entry, analysisStars: [], userReviewed: false }; // Wipe stars, mark unreviewed
      }
      return entry;
    }));
    toast({title: "All Stars Wiped", description: `All stars have been cleared for ${currentImageName}.`});
  };


  // Called when user clicks "Confirm & Close" or "Confirm & Next" in star editor
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
    setCurrentEditingImageData(null); // Clear ImageData
    toast({title: "Stars Confirmed", description: `Star selection saved for ${currentImageName}.`});

    // Check if there are other images to potentially apply this selection to
    if (allImageStarData.length > 1 && confirmedEntry.analysisStars && confirmedEntry.analysisDimensions) {
        setSourceImageForApplyMenu({
            id: confirmedEntry.id,
            fileName: confirmedEntry.file.name,
            stars: [...confirmedEntry.analysisStars], // Copy stars
            dimensions: { ...confirmedEntry.analysisDimensions }, // Copy dimensions
        });
        setShowApplyStarOptionsMenu(true);
    } else {
      // If no other images or no stars/dimensions, just clear current editing index
      setCurrentEditingImageIndex(null);
    }
  };

  const handleConfirmAndNext = async () => {
    if (currentEditingImageIndex === null) return; // Should not happen if button is enabled

    const hasNextImage = currentEditingImageIndex < allImageStarData.length - 1;
    
    // First, confirm stars for the current image (similar to handleConfirmStarsForCurrentImage without the menu)
    const currentImageEntry = allImageStarData[currentEditingImageIndex];
    const currentImageName = currentImageEntry?.file.name || "current image";
    addLog(`Confirmed star selection for ${currentImageName} and ${hasNextImage ? 'moving to next' : 'closing (last image)'}. Total stars: ${currentImageEntry?.analysisStars.length}. Mode: Manual.`);

    setAllImageStarData(prev => prev.map((entry, idx) =>
      idx === currentEditingImageIndex ? { ...entry, userReviewed: true, starSelectionMode: 'manual' } : entry
    ));
    
    toast({title: "Stars Confirmed", description: `Star selection saved for ${currentImageName}.`});

    if (!hasNextImage) {
      // If no next image, close the editor
      setIsStarEditingMode(false);
      setCurrentEditingImageData(null);
      setCurrentEditingImageIndex(null);
      return;
    }

    // If there is a next image, open the editor for it
    const nextImageIndex = currentEditingImageIndex + 1;
    await handleEditStarsRequest(nextImageIndex); // This will set the new currentEditingImageIndex and open editor
  };

  // Logic for applying confirmed stars to other images (from menu)
  const handleApplyStarsToMatchingDimensions = async () => {
    if (!sourceImageForApplyMenu) return;
    setIsApplyingStarsFromMenu(true);

    const { id: sourceId, stars: starsToApply, dimensions: sourceDimensions } = sourceImageForApplyMenu;

    addLog(`Applying star selection from image ${sourceImageForApplyMenu.fileName} to all other images with matching dimensions (${sourceDimensions.width}x${sourceDimensions.height}).`);
    setAllImageStarData(prev => prev.map(entry => {
      if (entry.id !== sourceId &&
          entry.analysisDimensions.width === sourceDimensions.width &&
          entry.analysisDimensions.height === sourceDimensions.height) {
        addLog(`Applied ${starsToApply.length} stars to ${entry.file.name} (matching dimensions).`);
        return {
          ...entry,
          analysisStars: [...starsToApply], // Make a new copy of stars
          starSelectionMode: 'manual' as StarSelectionMode, // Ensure mode is manual
          userReviewed: true, // Mark as reviewed since stars are applied
          isAnalyzed: true, // Mark as analyzed
        };
      }
      return entry;
    }));

    toast({title: t('toastStarsAppliedMatchingDimTitle'), description: t('toastStarsAppliedMatchingDimDesc')});
    setShowApplyStarOptionsMenu(false);
    setSourceImageForApplyMenu(null);
    setCurrentEditingImageIndex(null); // Clear editing index after menu interaction
    setCurrentEditingImageData(null);
    setIsApplyingStarsFromMenu(false);
  };
  
  const handleApplyStarsProportionally = async () => {
    if (!sourceImageForApplyMenu) return;
    setIsApplyingStarsFromMenu(true);
  
    const { id: sourceId, stars: sourceStars, dimensions: sourceDimensions, fileName: sourceFileName } = sourceImageForApplyMenu;
    const { width: sourceWidth, height: sourceHeight } = sourceDimensions;
    
    if (sourceWidth === 0 || sourceHeight === 0) {
      addLog("[ERROR] Proportional apply failed: Source image dimensions are zero.");
      toast({ title: "Error", description: "Cannot apply stars proportionally from an image with zero dimensions.", variant: "destructive" });
      setIsApplyingStarsFromMenu(false);
      setShowApplyStarOptionsMenu(false);
      setSourceImageForApplyMenu(null);
      setCurrentEditingImageIndex(null);
      setCurrentEditingImageData(null);
      return;
    }
    const sourceAspectRatio = sourceWidth / sourceHeight;
  
    if (sourceStars.length === 0) {
      addLog("[WARN] Proportional apply skipped: Source image has no stars selected.");
      toast({ title: t('toastProportionalApplySkippedTitle'), description: t('toastProportionalApplySkippedDesc', {fileName: sourceFileName}), variant: "default" });
      setIsApplyingStarsFromMenu(false);
      setShowApplyStarOptionsMenu(false);
      setSourceImageForApplyMenu(null);
      setCurrentEditingImageIndex(null);
      setCurrentEditingImageData(null);
      return;
    }
  
    addLog(`Applying stars proportionally from ${sourceFileName} to other images with similar aspect ratio...`);
  
    // This operation can be slow if many images. Consider a loading state if needed.
    const updatedImageStarData = await Promise.all(allImageStarData.map(async (targetEntry) => {
      if (targetEntry.id === sourceId) {
        return targetEntry; // Skip the source image itself
      }
  
      // Ensure target has valid dimensions
      if (!targetEntry.analysisDimensions || targetEntry.analysisDimensions.width === 0 || targetEntry.analysisDimensions.height === 0) {
        addLog(`[WARN] Skipping proportional apply for ${targetEntry.file.name}: Dimension data not available or invalid.`);
        return targetEntry;
      }
  
      const { width: targetWidth, height: targetHeight } = targetEntry.analysisDimensions;
      const targetAspectRatio = targetWidth / targetHeight;
  
      // Check if aspect ratios are similar enough
      if (Math.abs(sourceAspectRatio - targetAspectRatio) < ASPECT_RATIO_TOLERANCE) {
        addLog(`Applying stars proportionally to ${targetEntry.file.name} (Matching aspect ratio: Source ${sourceAspectRatio.toFixed(2)}, Target ${targetAspectRatio.toFixed(2)})...`);
        const transformedStars = sourceStars.map(star => ({
          ...star, // Copy all properties including fwhm, brightness, etc.
          x: (star.x / sourceWidth) * targetWidth,
          y: (star.y / sourceHeight) * targetHeight,
          isManuallyAdded: true, // Mark as manually applied (even if derived from auto)
        }));
  
        // It's possible the target image wasn't analyzed yet.
        // Here, we are directly setting its stars. We should also mark it as analyzed.
        addLog(`Successfully applied ${transformedStars.length} stars proportionally to ${targetEntry.file.name}.`);
        return {
          ...targetEntry,
          analysisStars: transformedStars,
          starSelectionMode: 'manual' as StarSelectionMode, // Ensure mode is manual
          userReviewed: true, // Mark as reviewed
          isAnalyzed: targetEntry.isAnalyzed || true, // Mark as analyzed if not already
        };
      } else {
        addLog(`[INFO] Skipped proportional apply for ${targetEntry.file.name}: Aspect ratio mismatch. Source ${sourceAspectRatio.toFixed(2)} (${sourceWidth}x${sourceHeight}), Target ${targetAspectRatio.toFixed(2)} (${targetWidth}x${targetHeight}).`);
        return targetEntry;
      }
    }));
  
    setAllImageStarData(updatedImageStarData);
    addLog("Proportional star application process finished.");
    toast({ title: t('toastProportionalApplyDoneTitle'), description: t('toastProportionalApplyDoneDesc')});
    setIsApplyingStarsFromMenu(false);
    setShowApplyStarOptionsMenu(false);
    setSourceImageForApplyMenu(null);
    setCurrentEditingImageIndex(null); // Clear editing index
    setCurrentEditingImageData(null);
  };

  const handleCancelApplyStarOptionsMenu = () => {
    setShowApplyStarOptionsMenu(false);
    setSourceImageForApplyMenu(null);
    setCurrentEditingImageIndex(null); // Important to clear this if user cancels the menu
    setCurrentEditingImageData(null);
    addLog("User chose not to apply star selection to other images from the menu.");
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
    setLogs([]); // Clear logs for new stacking operation
    logIdCounter.current = 0;

    // Reset previous stacked image and editor state
    setStackedImage(null);
    setShowPostProcessEditor(false);
    setImageForPostProcessing(null);
    setEditedPreviewUrl(null);


    addLog(`Starting image stacking. Mode: ${stackingMode}. Output: ${outputFormat.toUpperCase()}. Light Files: ${allImageStarData.length}.`);
    addLog(`Bias Frames: ${useBiasFrames && biasFrameFiles.length > 0 ? `${biasFrameFiles.length} frame(s)` : 'Not Used'}.`);
    addLog(`Dark Frames: ${useDarkFrames && darkFrameFiles.length > 0 ? `${darkFrameFiles.length} frame(s)` : 'Not Used'}.`);
    addLog(`Flat Frames: ${useFlatFrames && flatFrameFiles.length > 0 ? `${flatFrameFiles.length} frame(s)` : 'Not Used'}.`);
    addLog(`Alignment: Affine (Min ${MIN_STARS_FOR_AFFINE_ALIGNMENT} stars, Match ${NUM_STARS_TO_USE_FOR_AFFINE_MATCHING}, Star FWHM Filter: ${ALIGNMENT_STAR_MIN_FWHM}-${ALIGNMENT_STAR_MAX_FWHM}), Fallback Centroid (Min ${MIN_STARS_FOR_CENTROID_ALIGNMENT} stars, Auto Target ${AUTO_ALIGN_TARGET_STAR_COUNT}).`);
    addLog(`Star Detection (Self-Contained): MinContrast=${DETECTOR_MIN_CONTRAST}, MinBright=${DETECTOR_MIN_BRIGHTNESS}, MaxBright=${DETECTOR_MAX_BRIGHTNESS}, MinDist=${DETECTOR_MIN_DISTANCE}, MaxStars=${DETECTOR_MAX_STARS}, MinFWHM=${DETECTOR_MIN_FWHM}, MaxFWHM=${DETECTOR_MAX_FWHM}, Margin=${DETECTOR_MARGIN}, FlatTol=${DETECTOR_FLATNESS_TOLERANCE}.`);
    addLog(`Brightness Centroid Fallback Threshold: ${BRIGHTNESS_CENTROID_FALLBACK_THRESHOLD_GRAYSCALE_EQUIVALENT} (grayscale equivalent).`);

    if (typeof window === 'undefined' || typeof document === 'undefined') {
        const envErrorMsg = "Stacking cannot proceed outside a browser environment.";
        addLog(`[ERROR] ${envErrorMsg}`);
        toast({ title: "Environment Error", description: envErrorMsg, variant: "destructive" });
        setIsProcessingStack(false);
        return;
    }

    // Main try-catch for the entire stacking process
    try {
    setProgressPercent(PROGRESS_INITIAL_SETUP);
    addLog(`Initial setup complete. Progress: ${PROGRESS_INITIAL_SETUP}%.`);

    // Create a mutable copy for this stacking operation, to ensure star lists are correctly prepared
    // This copy will be used for determining alignment parameters for *this specific stack*.
    // The global allImageStarData is updated by analyzeImageForStars if analysis is run.
    let imageEntriesForCurrentStacking: ImageStarEntry[] = JSON.parse(JSON.stringify(allImageStarData));

    // Phase 1: Ensure all images are analyzed if needed for stacking
    // This loop updates the `imageEntriesForCurrentStacking` array with analysis results.
    addLog(`Starting pre-stack analysis for ${imageEntriesForCurrentStacking.length} images if needed...`);
    for (let i = 0; i < imageEntriesForCurrentStacking.length; i++) {
        let entry = imageEntriesForCurrentStacking[i]; // Get a reference to the entry in the local array
        if (!entry.isAnalyzed && !entry.isAnalyzing) {
            addLog(`Image ${entry.file.name} (${entry.id}) needs analysis for stacking process.`);
            
            // Update global state immediately for this specific item to show "Analyzing..."
            const currentEntryId = entry.id;
            setAllImageStarData(prev => prev.map(e => e.id === currentEntryId ? {...e, isAnalyzing: true, isAnalyzed: false } : e));
            
            // Perform analysis. analyzeImageForStars updates global state internally and returns the processed entry.
            const processedEntry = await analyzeImageForStars(entry, addLog); // Pass the current entry
            imageEntriesForCurrentStacking[i] = processedEntry; // Update the entry in our local processing list

        }
        // Ensure entry reflects its latest status after potential analysis for the *local* copy.
        entry = imageEntriesForCurrentStacking[i]; // Re-fetch from local array

        // If, after analysis, it's still marked as analyzing (e.g. analysis failed to set it false),
        // or if it was analyzing initially and analysis was skipped, ensure our local copy for stacking
        // considers it not analyzing for the purpose of this specific stacking operation.
        // The global state is handled by analyzeImageForStars or the finally block.
        if (entry.isAnalyzing) {
          imageEntriesForCurrentStacking[i] = { ...entry, isAnalyzing: false };
        }
    }
    addLog("Pre-stack analysis/preparation phase complete.");
    // The imageEntriesForCurrentStacking array now has the most up-to-date star data and analysis status for this stacking run.


    // Phase 2: Load HTMLImageElements from previewUrls (which might have been downscaled)
    const imageElements: HTMLImageElement[] = [];
    addLog(`Loading ${imageEntriesForCurrentStacking.length} image elements from their previewUrls...`);
    for (const entry of imageEntriesForCurrentStacking) { // Use the locally prepared list
      try {
        const imgEl = await loadImage(entry.previewUrl, entry.file.name);
        imageElements.push(imgEl);
      } catch (loadError) {
         const errorMessage = loadError instanceof Error ? loadError.message : String(loadError);
         addLog(`[LOAD ERROR] ${entry.file.name}: ${errorMessage}`);
         toast({ title: `Error Loading ${entry.file.name}`, description: errorMessage, variant: "destructive" });
         // Continue loading other images, but this one will be skipped in stacking
      }
    }
    addLog(`Successfully loaded ${imageElements.length} out of ${imageEntriesForCurrentStacking.length} images into HTMLImageElements.`);


    if (imageElements.length < 2) {
      const notEnoughValidMsg = `Need at least two valid images for stacking after filtering. Found ${imageElements.length}.`;
      addLog(`[ERROR] ${notEnoughValidMsg}`);
      toast({ title: "Not Enough Valid Images", description: notEnoughValidMsg, variant: "destructive" });
      setIsProcessingStack(false);
      setProgressPercent(0);
      return;
    }

    // Determine reference image and target dimensions
    // The reference image is the first successfully loaded HTMLImageElement
    const firstValidImageIndex = imageEntriesForCurrentStacking.findIndex(
      entry => imageElements.some(imgEl => imgEl.src === entry.previewUrl)
    );

    if (firstValidImageIndex === -1) {
      const noValidRefMsg = `Could not find a valid reference image among loaded images. Cannot proceed.`;
      addLog(`[ERROR] ${noValidRefMsg}`);
      toast({ title: "Invalid Reference Image", description: noValidRefMsg, variant: "destructive" });
      setIsProcessingStack(false); setProgressPercent(0); return;
    }
    
    const referenceImageEntry = imageEntriesForCurrentStacking[firstValidImageIndex];

    // Ensure reference image has valid analysisDimensions (these are from the preview, potentially downscaled)
    if (!referenceImageEntry?.analysisDimensions || referenceImageEntry.analysisDimensions.width === 0 || referenceImageEntry.analysisDimensions.height === 0) {
      const invalidRefMsg = `The reference image (${referenceImageEntry?.file?.name || 'unknown'}) is invalid or its analysis dimensions are missing/zero. Cannot proceed.`;
      addLog(`[ERROR] ${invalidRefMsg}`);
      toast({ title: "Invalid Reference Image", description: invalidRefMsg, variant: "destructive" });
      setIsProcessingStack(false); setProgressPercent(0); return;
    }

    let targetWidth = referenceImageEntry.analysisDimensions.width;
    let targetHeight = referenceImageEntry.analysisDimensions.height;
    addLog(`Target stacking dimensions (from reference image '${referenceImageEntry.file.name}' analysisDimensions): ${targetWidth}x${targetHeight}.`);


    if (targetWidth === 0 || targetHeight === 0) {
      const zeroDimMsg = "Calculated target stacking dimensions are zero. Cannot proceed.";
      addLog(`[ERROR] ${zeroDimMsg}`);
      toast({ title: "Error", description: zeroDimMsg, variant: "destructive" });
      setIsProcessingStack(false);
      setProgressPercent(0);
      return;
    }

    // Setup canvas for calibration frame processing
    const calibrationCanvas = document.createElement('canvas');
    calibrationCanvas.width = targetWidth;
    calibrationCanvas.height = targetHeight;
    const calCtx = calibrationCanvas.getContext('2d', { willReadFrequently: true });
    if (!calCtx) throw new Error("Could not get calibration canvas context.");


    // Phase 3: Create Master Calibration Frames (Bias, Dark, Flat)
    let masterBiasData: Uint8ClampedArray | null = null;
    if (useBiasFrames && biasFramePreviewUrls.length > 0) {
      addLog(t('logLoadingBiasFrames', { count: biasFramePreviewUrls.length }));
      const biasImageDataArrays: ImageData[] = [];
      for (let i = 0; i < biasFramePreviewUrls.length; i++) {
          try {
              const biasImgEl = await loadImage(biasFramePreviewUrls[i], biasFrameFiles[i].name);
              calCtx.clearRect(0,0,targetWidth, targetHeight);
              calCtx.drawImage(biasImgEl, 0, 0, targetWidth, targetHeight);
              biasImageDataArrays.push(calCtx.getImageData(0,0,targetWidth,targetHeight));
          } catch (e) {
              addLog(`[ERROR] Failed to load/process bias frame ${biasFrameFiles[i].name}: ${e instanceof Error ? e.message : String(e)}`);
          }
      }
      if (biasImageDataArrays.length > 0) {
          masterBiasData = averageImageDataArrays(biasImageDataArrays, targetWidth, targetHeight, addLog);
          if (masterBiasData) addLog(t('logMasterBiasCreated', { count: biasImageDataArrays.length }));
          else addLog(t('logMasterBiasFailed'));
      } else {
          addLog(t('biasFramesMissing')); 
          toast({ title: t('biasFramesMissingTitle'), description: t('biasFramesMissing'), variant: "default" });
      }
    } else if (useBiasFrames) { 
       addLog(t('biasFramesMissing'));
       toast({ title: t('biasFramesMissingTitle'), description: t('biasFramesMissing'), variant: "default" });
    }


    let masterDarkData: Uint8ClampedArray | null = null;
    if (useDarkFrames && darkFramePreviewUrls.length > 0) {
      addLog(t('logLoadingDarkFrames', { count: darkFramePreviewUrls.length }));
      const darkImageDataArrays: ImageData[] = [];
      for (let i = 0; i < darkFramePreviewUrls.length; i++) {
        try {
          const darkImgEl = await loadImage(darkFramePreviewUrls[i], darkFrameFiles[i].name);
          calCtx.clearRect(0, 0, targetWidth, targetHeight);
          calCtx.drawImage(darkImgEl, 0, 0, targetWidth, targetHeight);
          let currentDarkFrameImageData = calCtx.getImageData(0, 0, targetWidth, targetHeight);

          // Subtract master bias from dark frame if available
          if (masterBiasData) {
            const tempDarkData = new Uint8ClampedArray(currentDarkFrameImageData.data);
            for (let p = 0; p < tempDarkData.length; p += 4) {
              tempDarkData[p] = Math.max(0, tempDarkData[p] - masterBiasData[p]);
              tempDarkData[p+1] = Math.max(0, tempDarkData[p+1] - masterBiasData[p+1]);
              tempDarkData[p+2] = Math.max(0, tempDarkData[p+2] - masterBiasData[p+2]);
              // Alpha remains unchanged
            }
            currentDarkFrameImageData = new ImageData(tempDarkData, targetWidth, targetHeight);
            if (i === 0) addLog(t('logBiasSubtractedFromDark', { darkFrameName: darkFrameFiles[i].name }));
          }
          darkImageDataArrays.push(currentDarkFrameImageData);
        } catch (e) {
          addLog(`[ERROR] Failed to load/process dark frame ${darkFrameFiles[i].name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (darkImageDataArrays.length > 0) {
          masterDarkData = averageImageDataArrays(darkImageDataArrays, targetWidth, targetHeight, addLog);
          if (masterDarkData) addLog(t('logMasterDarkCreated', { count: darkImageDataArrays.length }));
          else addLog(t('logMasterDarkFailed'));
      } else {
          addLog(t('darkFramesMissing'));
          toast({ title: t('darkFramesMissingTitle'), description: t('darkFramesMissing'), variant: "default" });
      }
    } else if (useDarkFrames) {
      addLog(t('darkFramesMissing'));
      toast({ title: t('darkFramesMissingTitle'), description: t('darkFramesMissing'), variant: "default" });
    }


    let masterFlatData: Uint8ClampedArray | null = null;
    if (useFlatFrames && flatFramePreviewUrls.length > 0) {
      addLog(t('logLoadingFlatFrames', { count: flatFramePreviewUrls.length }));
      const flatImageDataArrays: ImageData[] = [];
      for (let i = 0; i < flatFramePreviewUrls.length; i++) {
        try {
          const flatImgEl = await loadImage(flatFramePreviewUrls[i], flatFrameFiles[i].name);
          calCtx.clearRect(0, 0, targetWidth, targetHeight);
          calCtx.drawImage(flatImgEl, 0, 0, targetWidth, targetHeight);
          let currentFlatFrameImageData = calCtx.getImageData(0, 0, targetWidth, targetHeight);

          // Subtract master bias from flat frame if available
          if (masterBiasData) {
            const tempFlatData = new Uint8ClampedArray(currentFlatFrameImageData.data);
            for (let p = 0; p < tempFlatData.length; p += 4) {
              tempFlatData[p] = Math.max(0, tempFlatData[p] - masterBiasData[p]);
              tempFlatData[p+1] = Math.max(0, tempFlatData[p+1] - masterBiasData[p+1]);
              tempFlatData[p+2] = Math.max(0, tempFlatData[p+2] - masterBiasData[p+2]);
            }
            currentFlatFrameImageData = new ImageData(tempFlatData, targetWidth, targetHeight);
            if (i===0) addLog(t('logBiasSubtractedFromFlat', { flatFrameName: flatFrameFiles[i].name }));
          }
          flatImageDataArrays.push(currentFlatFrameImageData);
        } catch (e) {
          addLog(`[ERROR] Failed to load/process flat frame ${flatFrameFiles[i].name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (flatImageDataArrays.length > 0) {
          masterFlatData = averageImageDataArrays(flatImageDataArrays, targetWidth, targetHeight, addLog);
          if (masterFlatData) addLog(t('logMasterFlatCreated', { count: flatImageDataArrays.length }));
          else addLog(t('logMasterFlatFailed'));
      } else {
          addLog(t('flatFramesMissing'));
          toast({ title: t('flatFramesMissingTitle'), description: t('flatFramesMissing'), variant: "default" });
      }
    } else if (useFlatFrames) {
      addLog(t('flatFramesMissing'));
      toast({ title: t('flatFramesMissingTitle'), description: t('flatFramesMissing'), variant: "default" });
    }
    addLog("Master calibration frame creation phase complete.");


    // Phase 4: Calculate Centroids for Fallback Alignment (if Affine fails)
    // This uses the star data from `imageEntriesForCurrentStacking` which was prepared earlier
    const numValidLightImages = imageElements.length; // Number of successfully loaded light frames
    const totalPixels = targetWidth * targetHeight;
    const normalizedImageFactor = Math.min(1, numValidLightImages / 20); 
    const veryLargePixelCount = 10000 * 10000; // e.g. 100 Megapixels
    const normalizedPixelFactor = Math.min(1, totalPixels / veryLargePixelCount);
    const loadScore = (0.3 * normalizedImageFactor) + (0.7 * normalizedPixelFactor); // Weighted score
    const dynamicDelayMs = Math.max(10, Math.min(100, 10 + Math.floor(loadScore * 90))); // Scale delay from 10ms to 100ms
    addLog(`Calculated dynamic yield delay: ${dynamicDelayMs}ms (Load score: ${loadScore.toFixed(2)}, Images: ${numValidLightImages}, Pixels: ${totalPixels})`);

    const centroids: ({ x: number; y: number } | null)[] = [];
    let successfulCentroidBasedAlignments = 0;
    const centroidProgressIncrement = numValidLightImages > 0 ? PROGRESS_CENTROID_CALCULATION_TOTAL / numValidLightImages : 0;
    
    const tempAnalysisCanvasForFallback = document.createElement('canvas'); // For brightness centroid if needed
    const tempAnalysisCtxForFallback = tempAnalysisCanvasForFallback.getContext('2d', { willReadFrequently: true });
    if (!tempAnalysisCtxForFallback) throw new Error("Could not get fallback analysis canvas context.");


    addLog(`Starting fallback centroid calculation for ${numValidLightImages} valid light images (used if Affine fails)...`);
    for (let i = 0; i < imageEntriesForCurrentStacking.length; i++) {
      const entryData = imageEntriesForCurrentStacking[i];
      const imgEl = imageElements.find(el => el.src === entryData.previewUrl); // Find corresponding HTMLImageElement

      if (!imgEl) { // If the image element for this entry wasn't loaded
          centroids.push(null); continue;
      }
      const fileNameForLog = entryData.file.name;
      let finalScaledCentroid: { x: number; y: number } | null = null;
      let method = "unknown_fallback";
      
      // Determine stars to use for centroid based on mode and review status from entryData (the local copy)
      let starsForCentroidCalc: Star[] = [];
      if (entryData.starSelectionMode === 'auto') { // If auto, use top N from initialAutoStars
          starsForCentroidCalc = [...entryData.initialAutoStars].sort((a,b) => b.brightness - a.brightness).slice(0, AUTO_ALIGN_TARGET_STAR_COUNT);
      } else { // If manual (reviewed or not), use analysisStars
          starsForCentroidCalc = [...entryData.analysisStars];
      }

      // Ensure entryData has valid analysisDimensions
      if (!entryData.isAnalyzed || !entryData.analysisDimensions || entryData.analysisDimensions.width === 0 || entryData.analysisDimensions.height === 0) {
          // If no analysis data, this image cannot be used for star-based centroid,
          // and even brightness centroid on its original preview might be misleading if dimensions are unknown.
          // Default to geometric center of the *target* dimensions as a very basic fallback.
          finalScaledCentroid = { x: targetWidth / 2, y: targetHeight / 2 };
          method = `geometric_fallback (no_analysis_data)`;
          addLog(`[FALLBACK GEOMETRIC] Image ${i} (${fileNameForLog}) due to missing analysis data. Centroid: (${finalScaledCentroid.x.toFixed(2)}, ${finalScaledCentroid.y.toFixed(2)})`);
      } else {
          // Try star-based centroid first using the prepared starsForCentroidCalc
          const {width: analysisWidth, height: analysisHeight} = entryData.analysisDimensions;
          let analysisImageCentroid = calculateStarArrayCentroid(starsForCentroidCalc, addLog);
          if (analysisImageCentroid) {
              method = `star-based_fallback (${starsForCentroidCalc.length} stars)`;
              successfulCentroidBasedAlignments++;
          } else {
              // Fallback to brightness centroid if star-based fails
              method = `brightness-based_fallback`;
              addLog(`[FALLBACK BRIGHTNESS] Image ${i} (${fileNameForLog}): Star centroid failed. Trying brightness centroid on ${analysisWidth}x${analysisHeight} canvas.`);
              tempAnalysisCanvasForFallback.width = analysisWidth; tempAnalysisCanvasForFallback.height = analysisHeight;
              tempAnalysisCtxForFallback.clearRect(0,0,analysisWidth,analysisHeight);
              tempAnalysisCtxForFallback.drawImage(imgEl, 0,0,analysisWidth,analysisHeight); // Draw the loaded HTMLImageElement
              analysisImageCentroid = calculateBrightnessCentroid(tempAnalysisCtxForFallback.getImageData(0,0,analysisWidth,analysisHeight), addLog);
          }
          // If either star or brightness centroid succeeded, scale it to target dimensions
          if (analysisImageCentroid) {
              finalScaledCentroid = { x: (analysisImageCentroid.x / analysisWidth) * targetWidth, y: (analysisImageCentroid.y / analysisHeight) * targetHeight };
          } else {
              // Ultimate fallback to geometric center of target if all else fails
              addLog(`[FALLBACK GEOMETRIC ULTIMATE] Image ${i} (${fileNameForLog}): Both star and brightness centroids failed. Defaulting to geometric center.`);
              finalScaledCentroid = { x: targetWidth / 2, y: targetHeight / 2 }; 
              method = `${method}_geometric_ultimate_fallback`;
          }
      }
      
      centroids.push(finalScaledCentroid);
      setProgressPercent(prev => Math.min(PROGRESS_INITIAL_SETUP + PROGRESS_CENTROID_CALCULATION_TOTAL, prev + centroidProgressIncrement));
      if (finalScaledCentroid) {
        addLog(`[FALLBACK CENTROID] Image ${i} (${fileNameForLog}): (${finalScaledCentroid.x.toFixed(2)}, ${finalScaledCentroid.y.toFixed(2)}) Method: ${method}`);
      } else {
        addLog(`[FALLBACK CENTROID ERROR] Image ${i} (${fileNameForLog}): Centroid calculation failed completely. Method: ${method}.`);
      }
      await yieldToEventLoop(dynamicDelayMs / 2); // Shorter yield during centroid calculation
    }
    addLog(`Fallback centroid calculation complete. ${successfulCentroidBasedAlignments}/${numValidLightImages} would use star-based if affine failed.`);
    
    
    // Phase 5: Prepare Reference Stars for Affine Alignment
    let referenceStarsForAffine: AstroAlignPoint[] = []; // From astro-align.ts Point type

    if (referenceImageEntry && referenceImageEntry.isAnalyzed && referenceImageEntry.analysisStars.length >= MIN_STARS_FOR_AFFINE_ALIGNMENT) {
        // Filter reference stars by FWHM first
        const goodFWHMRefStars = referenceImageEntry.analysisStars
            .filter(s => s.fwhm !== undefined && s.fwhm >= ALIGNMENT_STAR_MIN_FWHM && s.fwhm <= ALIGNMENT_STAR_MAX_FWHM)
            .sort((a,b) => b.brightness - a.brightness) // Then take top N brightest of the good FWHM stars
            .slice(0, NUM_STARS_TO_USE_FOR_AFFINE_MATCHING);
        
        addLog(`[AFFINE REF PREP] Ref Image ${referenceImageEntry.file.name}: Total analysis stars: ${referenceImageEntry.analysisStars.length}. After FWHM filter (${ALIGNMENT_STAR_MIN_FWHM}-${ALIGNMENT_STAR_MAX_FWHM}): ${goodFWHMRefStars.length} stars.`);

        if (goodFWHMRefStars.length >= MIN_STARS_FOR_AFFINE_ALIGNMENT) {
            referenceStarsForAffine = goodFWHMRefStars.map(s => {
                addLog(`[AFFINE REF STAR] Using: x=${s.x.toFixed(2)}, y=${s.y.toFixed(2)}, fwhm=${s.fwhm?.toFixed(2)}, bright=${s.brightness.toFixed(0)}`);
                return { x: s.x, y: s.y };
            });
            addLog(`[AFFINE REF] Using ${referenceStarsForAffine.length} FWHM-filtered stars from reference image ${referenceImageEntry.file.name} for affine.`);
        } else {
            addLog(`[AFFINE REF WARN] Ref image ${referenceImageEntry.file.name} has only ${goodFWHMRefStars.length} stars after FWHM filter (min ${MIN_STARS_FOR_AFFINE_ALIGNMENT} needed). Affine will be disabled for all frames.`);
            referenceStarsForAffine = []; // Disable affine if not enough good ref stars
        }
    } else {
         addLog(`[AFFINE REF INFO] Reference image ${referenceImageEntry?.file?.name || 'N/A'} not suitable for affine (not analyzed, or < ${MIN_STARS_FOR_AFFINE_ALIGNMENT} stars before FWHM filter). Affine alignment will be skipped for all images.`);
         referenceStarsForAffine = [];
    }
    const referenceCentroidForFallback = centroids[firstValidImageIndex]; // Centroid of the reference image for fallback alignment

    // Phase 6: Banded Stacking with Alignment (Affine or Centroid Fallback)
    const finalImageData = new Uint8ClampedArray(targetWidth * targetHeight * 4); // RGBA
    let validImagesStackedCount = 0;
    let affineAlignmentsUsed = 0;

    addLog(`Starting band processing for stacking. Band height: ${STACKING_BAND_HEIGHT}px. Mode: ${stackingMode}.`);
    const numBands = targetHeight > 0 ? Math.ceil(targetHeight / STACKING_BAND_HEIGHT) : 0;
    const bandProgressIncrement = numBands > 0 ? PROGRESS_BANDED_STACKING_TOTAL / numBands : 0;
    
    // Canvas for drawing each source image before warping/extracting band
    const currentImageCanvas = document.createElement('canvas'); 
    currentImageCanvas.width = targetWidth; currentImageCanvas.height = targetHeight;
    const currentImageCtx = currentImageCanvas.getContext('2d', { willReadFrequently: true });
    if (!currentImageCtx) throw new Error("Could not get current image canvas context.");
    currentImageCtx.imageSmoothingEnabled = true;
    currentImageCtx.imageSmoothingQuality = 'high';


    // Canvas for drawing the *warped* version of the current image
    const tempWarpedImageCanvas = document.createElement('canvas'); 
    tempWarpedImageCanvas.width = targetWidth; tempWarpedImageCanvas.height = targetHeight;
    const tempWarpedImageCtx = tempWarpedImageCanvas.getContext('2d', { willReadFrequently: true });
    if (!tempWarpedImageCtx) throw new Error("Could not get temp warped image canvas context.");
    tempWarpedImageCtx.imageSmoothingEnabled = true;
    tempWarpedImageCtx.imageSmoothingQuality = 'high';


    for (let yBandStart = 0; yBandStart < targetHeight; yBandStart += STACKING_BAND_HEIGHT) {
      const currentBandHeight = Math.min(STACKING_BAND_HEIGHT, targetHeight - yBandStart);
      // Data collector for pixels in the current band from all images
      const bandPixelDataCollector: Array<{ r: number[], g: number[], b: number[] }> = Array.from(
          { length: targetWidth * currentBandHeight }, () => ({ r: [], g: [], b: [] })
      );

      let imagesContributingToBand = 0; // For the first band, this will become validImagesStackedCount
      for (let i = 0; i < imageElements.length; i++) {
        const imgElement = imageElements[i];
        // Find the corresponding entry from imageEntriesForCurrentStacking (which has up-to-date star info)
        const currentImageEntry = imageEntriesForCurrentStacking.find(entry => entry.previewUrl === imgElement.src);
        if (!currentImageEntry) { 
            addLog(`[STACK SKIP WARN] Cannot find entry data for image element ${i} (src: ${imgElement.src.substring(0,50)}...). This image will be skipped.`); 
            continue; 
        }


        // 1. Draw current light frame to its canvas, then apply calibration
        currentImageCtx.clearRect(0,0,targetWidth,targetHeight);
        currentImageCtx.drawImage(imgElement, 0,0,targetWidth,targetHeight); // Draw original light frame
        let lightFrameForCalib = currentImageCtx.getImageData(0,0,targetWidth,targetHeight);
        let calibratedLightDataArray = new Uint8ClampedArray(lightFrameForCalib.data); // Copy for modification
        let logCalibrationMsg = "";

        // Apply Bias (to Light)
        if (masterBiasData) { 
          for (let p = 0; p < calibratedLightDataArray.length; p += 4) {
              calibratedLightDataArray[p] = Math.max(0, calibratedLightDataArray[p] - masterBiasData[p]);
              calibratedLightDataArray[p+1] = Math.max(0, calibratedLightDataArray[p+1] - masterBiasData[p+1]);
              calibratedLightDataArray[p+2] = Math.max(0, calibratedLightDataArray[p+2] - masterBiasData[p+2]);
          }
          logCalibrationMsg += "B"; // Log Bias applied
        }
        // Apply Dark (to Light or Bias-Subtracted Light)
        if (masterDarkData) { 
          for (let p = 0; p < calibratedLightDataArray.length; p += 4) {
              calibratedLightDataArray[p] = Math.max(0, calibratedLightDataArray[p] - masterDarkData[p]);
              calibratedLightDataArray[p+1] = Math.max(0, calibratedLightDataArray[p+1] - masterDarkData[p+1]);
              calibratedLightDataArray[p+2] = Math.max(0, calibratedLightDataArray[p+2] - masterDarkData[p+2]);
          }
          logCalibrationMsg += "D"; // Log Dark applied
        }
        // Apply Flat (to Light or Calibrated Light)
        if (masterFlatData) { 
          // Calculate average intensity of the master flat (used for normalization)
          // This is a simple way; more advanced methods might normalize channel-wise or use a specific region.
          const avgFlatIntensityR = calculateMean(Array.from(masterFlatData).filter((_, idx) => idx % 4 === 0));
          const avgFlatIntensityG = calculateMean(Array.from(masterFlatData).filter((_, idx) => idx % 4 === 1));
          const avgFlatIntensityB = calculateMean(Array.from(masterFlatData).filter((_, idx) => idx % 4 === 2));

          for (let p = 0; p < calibratedLightDataArray.length; p += 4) {
              // Prevent division by zero or near-zero; scale up very dark flat pixels carefully
              const flatR = Math.max(1, masterFlatData[p]); // Ensure flat pixel is not 0
              const flatG = Math.max(1, masterFlatData[p+1]);
              const flatB = Math.max(1, masterFlatData[p+2]);

              // flat_corrected = (image * mean_flat_value) / flat_pixel_value
              // Cap correction factor to avoid over-amplifying noise in dark flat areas
              calibratedLightDataArray[p] = Math.min(255, (calibratedLightDataArray[p] * avgFlatIntensityR) / flatR);
              calibratedLightDataArray[p+1] = Math.min(255, (calibratedLightDataArray[p+1] * avgFlatIntensityG) / flatG);
              calibratedLightDataArray[p+2] = Math.min(255, (calibratedLightDataArray[p+2] * avgFlatIntensityB) / flatB);
          }
          logCalibrationMsg += "F"; // Log Flat applied
        }
        if (logCalibrationMsg && i === 0 && yBandStart === 0) addLog(`[CALIBRATE] Img 0 (${currentImageEntry.file.name}): ${logCalibrationMsg.split("").join(", ")} applied.`);
        
        // Put calibrated data back onto currentImageCanvas for warping
        currentImageCtx.putImageData(new ImageData(calibratedLightDataArray, targetWidth, targetHeight), 0,0); 


        // 2. Determine and apply alignment (Affine or Centroid Fallback)
        let useAffineTransform = false;
        let estimatedMatrix: number[][] | null = null;

        // Try Affine transform if not the reference image and conditions are met
        if (currentImageEntry.id !== referenceImageEntry.id && // Don't align reference to itself
            referenceStarsForAffine.length >= MIN_STARS_FOR_AFFINE_ALIGNMENT &&
            currentImageEntry.isAnalyzed && currentImageEntry.analysisStars &&
            currentImageEntry.analysisStars.length >= MIN_STARS_FOR_AFFINE_ALIGNMENT) {
            
            // Filter current image's stars by FWHM
            const goodFWHMCurrentStars = currentImageEntry.analysisStars
                .filter(s => s.fwhm !== undefined && s.fwhm >= ALIGNMENT_STAR_MIN_FWHM && s.fwhm <= ALIGNMENT_STAR_MAX_FWHM)
                .sort((a,b) => b.brightness - a.brightness)
                .slice(0, NUM_STARS_TO_USE_FOR_AFFINE_MATCHING);

            if (yBandStart === 0) addLog(`[AFFINE CURR PREP] Img ${i} (${currentImageEntry.file.name}): Total analysis stars: ${currentImageEntry.analysisStars.length}. After FWHM filter: ${goodFWHMCurrentStars.length} stars.`);
            
            const currentStarsForAffinePoints: AstroAlignPoint[] = goodFWHMCurrentStars.map(s => {
                if (yBandStart === 0 && goodFWHMCurrentStars.length >= MIN_STARS_FOR_AFFINE_ALIGNMENT) addLog(`  [AFFINE CURR STAR] Using: x=${s.x.toFixed(2)}, y=${s.y.toFixed(2)}, fwhm=${s.fwhm?.toFixed(2)}, bright=${s.brightness.toFixed(0)}`);
                return { x: s.x, y: s.y };
            });


            const numPointsToMatch = Math.min(referenceStarsForAffine.length, currentStarsForAffinePoints.length);

            if (numPointsToMatch >= MIN_STARS_FOR_AFFINE_ALIGNMENT) {
                const srcPts = currentStarsForAffinePoints.slice(0, numPointsToMatch); // Current image stars (source)
                const dstPts = referenceStarsForAffine.slice(0, numPointsToMatch);    // Reference image stars (destination)

                if (yBandStart === 0) { // Log points only for the first band pass for brevity
                  addLog(`[AFFINE ATTEMPT] For ${currentImageEntry.file.name} with ${numPointsToMatch} pairs.`);
                  addLog(`  SRC Pts (current): ${JSON.stringify(srcPts.map(p => ({x:p.x.toFixed(1), y:p.y.toFixed(1)})))}`);
                  addLog(`  DST Pts (reference): ${JSON.stringify(dstPts.map(p => ({x:p.x.toFixed(1), y:p.y.toFixed(1)})))}`);
                }

                try {
                    // Check for NaN in coordinates before attempting transform
                    if (srcPts.some(pt => isNaN(pt.x) || isNaN(pt.y)) || dstPts.some(pt => isNaN(pt.x) || isNaN(pt.y))) {
                      addLog(`[AFFINE WARN] ${currentImageEntry.file.name} (img ${i}): NaN coordinates found in star points. Falling back.`);
                      useAffineTransform = false;
                    } else {
                      estimatedMatrix = estimateAffineTransform(srcPts, dstPts);
                      useAffineTransform = true;
                      if (yBandStart === 0) { // Log success only for the first band
                           affineAlignmentsUsed++;
                           addLog(`[AFFINE SUCCESS] Matrix for ${currentImageEntry.file.name}: ${JSON.stringify(estimatedMatrix?.map(row => row.map(val => val.toFixed(3))))}`);
                      }
                    }
                } catch (e) {
                    const affineErrorMsg = e instanceof Error ? e.message : String(e);
                    addLog(`[AFFINE WARN] ${currentImageEntry.file.name} (img ${i}): estimateAffineTransform failed (${affineErrorMsg}). Falling back.`);
                    useAffineTransform = false;
                }
            } else {
                if (yBandStart === 0) addLog(`[AFFINE INFO] ${currentImageEntry.file.name} (img ${i}): Not enough matching points (${numPointsToMatch}) after FWHM filter for affine. Need ${MIN_STARS_FOR_AFFINE_ALIGNMENT}. Falling back.`);
                useAffineTransform = false;
            }
        } else {
            // Conditions for affine not met (e.g. it's the ref image, or not enough stars on ref/current)
            if (yBandStart === 0 && currentImageEntry.id !== referenceImageEntry.id) addLog(`[AFFINE INFO] ${currentImageEntry.file.name} (img ${i}): Conditions for affine not met (ref stars: ${referenceStarsForAffine.length}, current stars after FWHM filter: ${currentImageEntry.analysisStars?.filter(s => s.fwhm !== undefined && s.fwhm >= ALIGNMENT_STAR_MIN_FWHM && s.fwhm <= ALIGNMENT_STAR_MAX_FWHM).length || 0}). Falling back.`);
            useAffineTransform = false; // Explicitly false if conditions not met or it's the reference image
        }
        
        // 3. Warp the (calibrated) currentImageCanvas to tempWarpedImageCanvas
        tempWarpedImageCtx.clearRect(0,0,targetWidth,targetHeight); // Clear target warp canvas
        if (useAffineTransform && estimatedMatrix && currentImageEntry.id !== referenceImageEntry.id) {
            // Affine warp
            warpImage(currentImageCtx, tempWarpedImageCtx, estimatedMatrix, addLog);
        } else { // Fallback to centroid translation (or no transform for reference image)
            // Get the pre-calculated centroid for *this* image (from `centroids` array)
            const originalEntryIndexInCentroids = imageEntriesForCurrentStacking.findIndex(e => e.id === currentImageEntry.id);
            const currentCentroid = originalEntryIndexInCentroids !== -1 ? centroids[originalEntryIndexInCentroids] : null;
            
            let dx = 0, dy = 0;
            if (currentImageEntry.id !== referenceImageEntry.id && currentCentroid && referenceCentroidForFallback) {
                // Calculate shift needed to align currentCentroid to referenceCentroidForFallback
                dx = referenceCentroidForFallback.x - currentCentroid.x;
                dy = referenceCentroidForFallback.y - currentCentroid.y;
            } else if (currentImageEntry.id === referenceImageEntry.id) {
                // Reference image, no shift needed (or already handled if affine was skipped for all)
                dx = 0; dy = 0;
            } else {
               // Should not happen if centroids were calculated for all images.
               if(yBandStart === 0) addLog(`[ALIGN FALLBACK WARN] ${currentImageEntry.file.name}: Centroid data missing for fallback translation. No translation applied.`);
            }
            // Apply simple translation
            tempWarpedImageCtx.drawImage(currentImageCanvas, dx, dy);
            if (yBandStart === 0 && (!useAffineTransform || currentImageEntry.id === referenceImageEntry.id) ) { // Log fallback/ref only for first band
                 addLog(`[ALIGN FALLBACK/REF] ${currentImageEntry.file.name}: Using centroid (dx:${dx.toFixed(2)}, dy:${dy.toFixed(2)}) or is reference. Affine status: ${useAffineTransform}, IsRef: ${currentImageEntry.id === referenceImageEntry.id}`);
            }
        }

        // 4. Extract band data from the (now aligned) tempWarpedImageCanvas
        try {
          const bandFrameImageData = tempWarpedImageCtx.getImageData(0, yBandStart, targetWidth, currentBandHeight);
          const bandData = bandFrameImageData.data;
          for (let j = 0; j < bandData.length; j += 4) {
            const bandPixelIndex = j / 4; // Index within the bandPixelDataCollector array
            bandPixelDataCollector[bandPixelIndex].r.push(bandData[j]);
            bandPixelDataCollector[bandPixelIndex].g.push(bandData[j + 1]);
            bandPixelDataCollector[bandPixelIndex].b.push(bandData[j + 2]);
            // Alpha is ignored for stacking, set to 255 at the end
          }
          if (yBandStart === 0) imagesContributingToBand++; // Count images successfully processed for the first band
        } catch (e) {
          // This might happen if getImageData fails (e.g. canvas tainted, though unlikely with local data)
          addLog(`[STACK ERROR] Band ${yBandStart}, Img ${i} (${currentImageEntry.file.name}): Error extracting band data: ${e instanceof Error ? e.message : String(e)}`);
        }
        // Yield to event loop periodically to keep UI responsive
        if (i % 5 === 0) await yieldToEventLoop(dynamicDelayMs);
      } // End loop over imageElements
      if (yBandStart === 0) validImagesStackedCount = imagesContributingToBand; // Set count based on first band

      // Phase 6b: Combine pixels for the current band
      for (let yInBand = 0; yInBand < currentBandHeight; yInBand++) {
        for (let x = 0; x < targetWidth; x++) {
            const bandPixelIndex = yInBand * targetWidth + x;
            const finalPixelGlobalIndex = ((yBandStart + yInBand) * targetWidth + x) * 4;
            const collected = bandPixelDataCollector[bandPixelIndex];
            if (collected.r.length > 0) { // Ensure there's data for this pixel
              finalImageData[finalPixelGlobalIndex]     = stackingMode === 'median' ? getMedian(collected.r) : applySigmaClip(collected.r);
              finalImageData[finalPixelGlobalIndex + 1] = stackingMode === 'median' ? getMedian(collected.g) : applySigmaClip(collected.g);
              finalImageData[finalPixelGlobalIndex + 2] = stackingMode === 'median' ? getMedian(collected.b) : applySigmaClip(collected.b);
              finalImageData[finalPixelGlobalIndex + 3] = 255; // Opaque alpha
            } else { 
              // If no data for this pixel (e.g., all images failed for this band segment), make it black
              finalImageData[finalPixelGlobalIndex] = 0; finalImageData[finalPixelGlobalIndex + 1] = 0;
              finalImageData[finalPixelGlobalIndex + 2] = 0; finalImageData[finalPixelGlobalIndex + 3] = 255;
            }
        }
      }
      setProgressPercent(prev => Math.min(100, prev + bandProgressIncrement));
      if (yBandStart % (STACKING_BAND_HEIGHT * 5) === 0 || yBandStart + currentBandHeight >= targetHeight ) { // Log progress less frequently
           addLog(`Processed band: rows ${yBandStart} to ${yBandStart + currentBandHeight - 1}. Progress: ${Math.round(progressPercent)}%. Yielding.`);
      }
      await yieldToEventLoop(dynamicDelayMs); // Yield after each band
    } // End loop over bands

    setProgressPercent(100);
    addLog(`All bands processed. Finalizing image.`);

    // Check if any images actually contributed to the stack
    if (validImagesStackedCount === 0 && numValidLightImages > 0) {
      const noStackMsg = "No images could be successfully processed during band stacking (zero contribution).";
      addLog(`[ERROR] ${noStackMsg}`);
      toast({ title: "Stacking Failed", description: noStackMsg, variant: "destructive" });
      setIsProcessingStack(false);
      setProgressPercent(0);
      return;
    }

    // Phase 7: Create final image from stacked data
    const finalResultCanvas = document.createElement('canvas');
    finalResultCanvas.width = targetWidth;
    finalResultCanvas.height = targetHeight;
    const finalResultCtx = finalResultCanvas.getContext('2d');
    if (!finalResultCtx) throw new Error("Could not get final result canvas context.");
    finalResultCtx.imageSmoothingEnabled = true;
    finalResultCtx.imageSmoothingQuality = 'high';
    finalResultCtx.putImageData(new ImageData(finalImageData, targetWidth, targetHeight), 0, 0);


    let resultDataUrl: string;
    let outputMimeType = 'image/png';
    if (outputFormat === 'jpeg') {
      outputMimeType = 'image/jpeg';
      resultDataUrl = finalResultCanvas.toDataURL(outputMimeType, jpegQuality / 100);
      addLog(`Generated JPEG image (Quality: ${jpegQuality}%).`);
    } else { // PNG default
      resultDataUrl = finalResultCanvas.toDataURL(outputMimeType);
      addLog(`Generated PNG image.`);
    }

    if (!resultDataUrl || resultDataUrl === "data:," || resultDataUrl.length < MIN_VALID_DATA_URL_LENGTH) {
      const previewFailMsg = `Could not generate a valid image preview in ${outputFormat.toUpperCase()} format. The resulting data URL was too short or invalid.`;
      addLog(`[ERROR] ${previewFailMsg} Result URL length: ${resultDataUrl?.length || 'null'}`);
      toast({ title: "Preview Generation Failed", description: previewFailMsg, variant: "destructive" });
      setStackedImage(null);
    } else {
      setStackedImage(resultDataUrl);
      // Prepare for post-processing editor
      setImageForPostProcessing(resultDataUrl); // Set the raw stacked image as base for editor
      setEditedPreviewUrl(resultDataUrl); // Initial preview for editor is the raw stacked image

      // Reset adjustment sliders for the new image
      setBrightness(100);
      setExposure(0);
      setSaturation(100);
      setShowPostProcessEditor(true); // Open the editor automatically

      // Construct success message
      const alignmentMessage = affineAlignmentsUsed > 0
        ? `${affineAlignmentsUsed}/${numValidLightImages -1} non-reference images aligned using Affine Transform. Others (or if affine failed) used centroid fallback.`
        : `All ${numValidLightImages -1} non-reference images (and reference) aligned using centroid-based methods (Affine conditions not met or failed).`;

      let calibrationSummary = "";
      if (useBiasFrames && masterBiasData) calibrationSummary += `Bias (${biasFrameFiles.length} frames). `;
      if (useDarkFrames && masterDarkData) calibrationSummary += `Dark (${darkFrameFiles.length} frames). `;
      if (useFlatFrames && masterFlatData) calibrationSummary += `Flat (${flatFrameFiles.length} frames). `;
      if (calibrationSummary === "") calibrationSummary = "No cal frames. ";


      const stackingMethodUsed = stackingMode === 'median' ? 'Median' : 'Sigma Clip';
      const successToastMsg = `${alignmentMessage} Cal: ${calibrationSummary} ${validImagesStackedCount} images stacked. Dim: ${targetWidth}x${targetHeight}.`;
      addLog(`Stacking complete. ${successToastMsg}`);
      toast({
        title: `${stackingMethodUsed} Stacking Complete (${outputFormat.toUpperCase()})`,
        description: successToastMsg,
        duration: 10000, // Longer duration for important summary
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
    setStackedImage(null); // Ensure no broken image is shown
  } finally {
    setIsProcessingStack(false);
    setProgressPercent(0);
    // Clear isAnalyzing flag for all images in global state as stacking process is fully complete
    setAllImageStarData(prev => prev.map(e => ({...e, isAnalyzing: false})));
    addLog("Image stacking process finished.");
    console.log("Image stacking process finished.");
  }
};

  const handleOpenPostProcessEditor = () => {
    if (stackedImage) {
      setImageForPostProcessing(stackedImage); // Base image for editor is the raw stacked image
      setEditedPreviewUrl(stackedImage); // Initial preview in editor
      // Reset sliders to default when opening for a new image
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
    // When resetting, the edited preview should revert to the original stacked image
    // (which is stored in imageForPostProcessing)
    if (imageForPostProcessing) {
      setEditedPreviewUrl(imageForPostProcessing); 
    }
  };

  const countImagesWithMatchingDimensions = useCallback(() => {
    if (!sourceImageForApplyMenu) return 0;
    return allImageStarData.filter(img =>
      img.id !== sourceImageForApplyMenu.id &&
      img.analysisDimensions.width === sourceImageForApplyMenu.dimensions.width &&
      img.analysisDimensions.height === sourceImageForApplyMenu.dimensions.height
    ).length;
  }, [allImageStarData, sourceImageForApplyMenu]);

  const countImagesWithMatchingAspectRatio = useCallback(() => {
    if (!sourceImageForApplyMenu) return 0;
    if (sourceImageForApplyMenu.dimensions.height === 0) return 0; // Avoid division by zero
    const sourceAspectRatio = sourceImageForApplyMenu.dimensions.width / sourceImageForApplyMenu.dimensions.height;
    return allImageStarData.filter(img => {
      if (img.id === sourceImageForApplyMenu.id || !img.analysisDimensions || img.analysisDimensions.width === 0 || img.analysisDimensions.height === 0) {
        return false;
      }
      const targetAspectRatio = img.analysisDimensions.width / img.analysisDimensions.height;
      return Math.abs(sourceAspectRatio - targetAspectRatio) < ASPECT_RATIO_TOLERANCE;
    }).length;
  }, [allImageStarData, sourceImageForApplyMenu]);


  const canStartStacking = allImageStarData.length >= 2;
  const isUiDisabled = isProcessingStack || 
                       isProcessingDarkFrames || 
                       isProcessingFlatFrames || 
                       isProcessingBiasFrames || 
                       (currentEditingImageIndex !== null && (allImageStarData.find((e,i)=>i===currentEditingImageIndex)?.isAnalyzing)) ||
                       isApplyingStarsFromMenu;

  const currentImageForEditing = currentEditingImageIndex !== null ? allImageStarData[currentEditingImageIndex] : null;

  const currentYear = new Date().getFullYear();

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <AppHeader />
      <main className="flex-grow container mx-auto py-6 px-2 sm:px-4 md:px-6">
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Left Panel: Upload, Queue, Settings */}
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
                    <ImageUploadArea onFilesAdded={handleFilesAdded} isProcessing={isUiDisabled} multiple={true} />

                    {isProcessingStack && progressPercent > 0 && (
                      <div className="space-y-2 my-4">
                        <Progress value={progressPercent} className="w-full h-3" />
                        <p className="text-sm text-center text-muted-foreground">{t('stackingProgress', {progressPercent: Math.round(progressPercent)})}</p>
                      </div>
                    )}

                    {/* Image Queue */}
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
                                isAnalyzing={entry.isAnalyzing || (currentEditingImageIndex === index && (allImageStarData.find((e,i)=>i===currentEditingImageIndex)?.isAnalyzing))}
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
                      </>
                    )}

                    {/* Bias Frames Upload */}
                    <Card className="mt-4 shadow-md">
                        <CardHeader className="pb-3 pt-4">
                            <CardTitle className="flex items-center text-lg">
                                <Baseline className="mr-2 h-5 w-5 text-accent" />
                                {t('biasFramesUploadTitle')}
                            </CardTitle>
                            <CardDescription className="text-xs">{t('biasFramesUploadDescription')}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3 pb-4">
                            <ImageUploadArea onFilesAdded={handleBiasFramesAdded} isProcessing={isUiDisabled || isProcessingBiasFrames} multiple={true} />
                            {isProcessingBiasFrames && <Loader2 className="mx-auto my-2 h-6 w-6 animate-spin text-accent" />}
                            {biasFramePreviewUrls.length > 0 && (
                                <div className="mt-2 space-y-2">
                                    <Label className="text-sm font-semibold">{t('biasFramesPreviewTitle', { count: biasFramePreviewUrls.length })}</Label>
                                    <ScrollArea className="h-36 border rounded-md p-2 bg-muted/10">
                                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                        {biasFramePreviewUrls.map((url, index) => (
                                          <div key={`bias-${index}-${biasFrameFiles[index]?.name || index}`} className="relative group border rounded overflow-hidden">
                                            <NextImage src={url} alt={`Bias Frame ${index + 1}`} width={100} height={75} className="object-cover w-full h-20" data-ai-hint="noise pattern" />
                                            <Button variant="destructive" size="icon" onClick={() => handleRemoveBiasFrame(index)} className="absolute top-1 right-1 h-5 w-5 z-10 opacity-0 group-hover:opacity-100 transition-opacity" disabled={isUiDisabled}>
                                                <X className="h-3 w-3" />
                                            </Button>
                                            <div className="p-1 text-xs bg-background/70 truncate text-muted-foreground">
                                                {biasFrameFiles[index]?.name}
                                                {originalBiasFrameDimensionsList[index] && ` (${originalBiasFrameDimensionsList[index]!.width}x${originalBiasFrameDimensionsList[index]!.height})`}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </ScrollArea>
                                </div>
                            )}
                            {biasFrameFiles.length > 0 && (
                                <div className="flex items-center space-x-2 pt-2">
                                    <Switch id="use-bias-frames" checked={useBiasFrames} onCheckedChange={setUseBiasFrames} disabled={isUiDisabled || biasFrameFiles.length === 0} />
                                    <Label htmlFor="use-bias-frames" className="text-sm cursor-pointer">{t('useBiasFramesLabel')}</Label>
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {/* Dark Frames Upload */}
                    <Card className="mt-4 shadow-md">
                        <CardHeader className="pb-3 pt-4">
                            <CardTitle className="flex items-center text-lg">
                                <ShieldOff className="mr-2 h-5 w-5 text-accent" />
                                {t('darkFramesUploadTitle')}
                            </CardTitle>
                            <CardDescription className="text-xs">{t('darkFramesUploadDescription')}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3 pb-4">
                            <ImageUploadArea onFilesAdded={handleDarkFramesAdded} isProcessing={isUiDisabled || isProcessingDarkFrames} multiple={true} />
                            {isProcessingDarkFrames && <Loader2 className="mx-auto my-2 h-6 w-6 animate-spin text-accent" />}
                             {darkFramePreviewUrls.length > 0 && (
                                <div className="mt-2 space-y-2">
                                    <Label className="text-sm font-semibold">{t('darkFramesPreviewTitle', { count: darkFramePreviewUrls.length })}</Label>
                                    <ScrollArea className="h-36 border rounded-md p-2 bg-muted/10">
                                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                        {darkFramePreviewUrls.map((url, index) => (
                                          <div key={`dark-${index}-${darkFrameFiles[index]?.name || index}`} className="relative group border rounded overflow-hidden">
                                            <NextImage src={url} alt={`Dark Frame ${index + 1}`} width={100} height={75} className="object-cover w-full h-20" data-ai-hint="dark frame" />
                                            <Button variant="destructive" size="icon" onClick={() => handleRemoveDarkFrame(index)} className="absolute top-1 right-1 h-5 w-5 z-10 opacity-0 group-hover:opacity-100 transition-opacity" disabled={isUiDisabled}>
                                                <X className="h-3 w-3" />
                                            </Button>
                                             <div className="p-1 text-xs bg-background/70 truncate text-muted-foreground">
                                                {darkFrameFiles[index]?.name}
                                                {originalDarkFrameDimensionsList[index] && ` (${originalDarkFrameDimensionsList[index]!.width}x${originalDarkFrameDimensionsList[index]!.height})`}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </ScrollArea>
                                </div>
                            )}
                            {darkFrameFiles.length > 0 && (
                                <div className="flex items-center space-x-2 pt-2">
                                    <Switch id="use-dark-frames" checked={useDarkFrames} onCheckedChange={setUseDarkFrames} disabled={isUiDisabled || darkFrameFiles.length === 0} />
                                    <Label htmlFor="use-dark-frames" className="text-sm cursor-pointer">{t('useDarkFramesLabel')}</Label>
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {/* Flat Frames Upload */}
                    <Card className="mt-4 shadow-md">
                        <CardHeader className="pb-3 pt-4">
                            <CardTitle className="flex items-center text-lg">
                                <Layers className="mr-2 h-5 w-5 text-accent" />
                                {t('flatFramesUploadTitle')}
                            </CardTitle>
                            <CardDescription className="text-xs">{t('flatFramesUploadDescription')}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3 pb-4">
                            <ImageUploadArea onFilesAdded={handleFlatFramesAdded} isProcessing={isUiDisabled || isProcessingFlatFrames} multiple={true} />
                            {isProcessingFlatFrames && <Loader2 className="mx-auto my-2 h-6 w-6 animate-spin text-accent" />}
                             {flatFramePreviewUrls.length > 0 && (
                                <div className="mt-2 space-y-2">
                                    <Label className="text-sm font-semibold">{t('flatFramesPreviewTitle', { count: flatFramePreviewUrls.length })}</Label>
                                   <ScrollArea className="h-36 border rounded-md p-2 bg-muted/10">
                                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                        {flatFramePreviewUrls.map((url, index) => (
                                          <div key={`flat-${index}-${flatFrameFiles[index]?.name || index}`} className="relative group border rounded overflow-hidden">
                                            <NextImage src={url} alt={`Flat Frame ${index + 1}`} width={100} height={75} className="object-cover w-full h-20" data-ai-hint="uniform light" />
                                            <Button variant="destructive" size="icon" onClick={() => handleRemoveFlatFrame(index)} className="absolute top-1 right-1 h-5 w-5 z-10 opacity-0 group-hover:opacity-100 transition-opacity" disabled={isUiDisabled}>
                                                <X className="h-3 w-3" />
                                            </Button>
                                            <div className="p-1 text-xs bg-background/70 truncate text-muted-foreground">
                                                {flatFrameFiles[index]?.name}
                                                {originalFlatFrameDimensionsList[index] && ` (${originalFlatFrameDimensionsList[index]!.width}x${originalFlatFrameDimensionsList[index]!.height})`}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </ScrollArea>
                                </div>
                            )}
                            {flatFrameFiles.length > 0 && (
                                <div className="flex items-center space-x-2 pt-2">
                                    <Switch id="use-flat-frames" checked={useFlatFrames} onCheckedChange={setUseFlatFrames} disabled={isUiDisabled || flatFrameFiles.length === 0} />
                                    <Label htmlFor="use-flat-frames" className="text-sm cursor-pointer">{t('useFlatFramesLabel')}</Label>
                                </div>
                            )}
                        </CardContent>
                    </Card>


                    {/* Stacking Settings */}
                    {allImageStarData.length > 0 && (
                        <>
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
                ) : ( // Star Editing Mode UI
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
                      <div className="grid grid-cols-2 gap-2 pt-2">
                        <Button onClick={handleResetStars} variant="outline" className="w-full" disabled={isUiDisabled}>
                          <RefreshCcw className="mr-2 h-4 w-4" /> {t('resetToAuto')}
                        </Button>
                        <Button onClick={handleWipeAllStarsForCurrentImage} variant="destructive" className="w-full" disabled={isUiDisabled}>
                          <Trash2 className="mr-2 h-4 w-4" /> {t('wipeAllStars')}
                        </Button>
                      </div>
                      <div className="space-y-2 mt-2">
                        {/* Confirm and Next button - only enabled if there IS a next image */}
                        <Button
                          onClick={handleConfirmAndNext}
                          className="w-full bg-blue-600 hover:bg-blue-700 text-white" 
                          disabled={
                            isUiDisabled ||
                            currentEditingImageIndex === null || // Should not be null here
                            currentEditingImageIndex >= allImageStarData.length - 1 // Disabled if last image
                          }
                        >
                          <SkipForward className="mr-2 h-4 w-4" />
                          {t('confirmAndNext')}
                        </Button>
                         {/* Confirm and Close button - always available */}
                         <Button
                          onClick={handleConfirmStarsForCurrentImage}
                          className="w-full bg-green-600 hover:bg-green-700 text-white" 
                          disabled={isUiDisabled}
                        >
                          <CheckCircle className="mr-2 h-4 w-4" />
                          {t('confirmAndClose')}
                        </Button>
                        <Button onClick={() => {setIsStarEditingMode(false); setCurrentEditingImageIndex(null); setCurrentEditingImageData(null);}} variant="ghost" className="w-full text-muted-foreground" disabled={isUiDisabled}>
                            {t('cancelEditing')}
                        </Button>
                      </div>
                    </div>
                  )
                )}

                {/* Processing Logs */}
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
                            <span className={log.message.startsWith('[ERROR]') || log.message.startsWith('[INTERNAL_ANALYZE ERROR]') || log.message.startsWith('[FATAL ERROR]') ? 'text-destructive' : (log.message.startsWith('[WARN]') || log.message.includes('Warning:') || log.message.startsWith('[FWHM EST WARN]') || log.message.startsWith('[DETECTOR WARN]') ? 'text-yellow-500' : 'text-foreground/80')}>{log.message}</span>
                          </div>
                        ))}
                      </ScrollArea>
                    </CardContent>
                  </Card>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Right Panel: Image Preview & Post-Processing */}
          <div className="w-full lg:w-3/5 xl:w-2/3 flex flex-col space-y-6">
            <ImagePreview
              imageUrl={showPostProcessEditor ? editedPreviewUrl : stackedImage}
              fitMode={previewFitMode}
            />
            {/* Button to open post-process editor - only shown if stackedImage exists AND editor is not already open */}
            {stackedImage && !showPostProcessEditor && ( 
               <Button
                onClick={handleOpenPostProcessEditor}
                className="w-full bg-purple-600 hover:bg-purple-700 text-white"
                size="lg"
                disabled={isProcessingStack} // Disable if stacking is in progress
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

      {/* Apply Star Selection Options Dialog */}
      {showApplyStarOptionsMenu && sourceImageForApplyMenu && (
        <AlertDialog open={showApplyStarOptionsMenu} onOpenChange={(open) => { if (!open) handleCancelApplyStarOptionsMenu(); }}>
            <AlertDialogContent className="max-w-md">
                <AlertDialogHeader>
                    <AlertDialogTitle className="flex items-center">
                        <CopyCheck className="mr-2 h-5 w-5 text-accent" />
                        {t('applyStarOptionsMenuTitle')}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('applyStarOptionsMenuDesc', {
                        starCount: sourceImageForApplyMenu.stars.length,
                        fileName: sourceImageForApplyMenu.fileName,
                        width: sourceImageForApplyMenu.dimensions.width,
                        height: sourceImageForApplyMenu.dimensions.height,
                      })}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="space-y-3 py-2">
                    <Button
                        onClick={handleApplyStarsToMatchingDimensions}
                        className="w-full justify-start"
                        variant="outline"
                        disabled={isApplyingStarsFromMenu || countImagesWithMatchingDimensions() === 0}
                    >
                        {isApplyingStarsFromMenu ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Layers className="mr-2 h-4 w-4" />}
                        {t('applyToMatchingDimensionsBtn', { count: countImagesWithMatchingDimensions() })}
                    </Button>
                     <Button
                        onClick={handleApplyStarsProportionally}
                        className="w-full justify-start"
                        variant="outline"
                        disabled={isApplyingStarsFromMenu || countImagesWithMatchingAspectRatio() === 0}
                    >
                        {isApplyingStarsFromMenu ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ChevronRight className="mr-2 h-4 w-4" />}
                        {t('applyProportionallyBtn', { count: countImagesWithMatchingAspectRatio() })}
                    </Button>
                </div>
                <AlertDialogFooter>
                    <AlertDialogCancel onClick={handleCancelApplyStarOptionsMenu} disabled={isApplyingStarsFromMenu}>
                        {t('dontApplyToOthersBtn')}
                    </AlertDialogCancel>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
      )}

    {/* Post-Processing Editor Dialog */}
    {showPostProcessEditor && imageForPostProcessing && (
        <ImagePostProcessEditor
          isOpen={showPostProcessEditor}
          onClose={() => setShowPostProcessEditor(false)}
          baseImageUrl={imageForPostProcessing} // The raw stacked image
          editedImageUrl={editedPreviewUrl} // The live edited version
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
    

    
