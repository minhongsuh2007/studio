
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
  fwhm?: number; // Added FWHM from detector
}

export interface ImageStarEntry {
  id: string;
  file: File;
  previewUrl: string;
  analysisStars: Star[]; // Uses the application-wide Star interface, now with FWHM
  initialAutoStars: Star[]; // Stores stars from auto-detection, also uses application-wide Star interface, now with FWHM
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
const MIN_STARS_FOR_AFFINE_ALIGNMENT = 5; // Increased from 3
const NUM_STARS_TO_USE_FOR_AFFINE_MATCHING = 10;
const AUTO_ALIGN_TARGET_STAR_COUNT = 10; // Reduced from 25


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
const ALIGNMENT_STAR_MIN_FWHM = 2.0; // Tightened from 1.8
const ALIGNMENT_STAR_MAX_FWHM = 4.0; // Tightened from 4.5


// ==== New Star Detector (Self-Contained) Configuration ====
const DETECTOR_MIN_CONTRAST = 20;
const DETECTOR_MIN_BRIGHTNESS = 40;
const DETECTOR_MAX_BRIGHTNESS = 220; // Condition uses >, so effectively 219.99...
const DETECTOR_MIN_DISTANCE = 6;
const DETECTOR_MAX_STARS = 10; 
const DETECTOR_MIN_FWHM = 1.5;
const DETECTOR_MAX_FWHM = 5.0;
const DETECTOR_ANNULUS_INNER_RADIUS = 4;
const DETECTOR_ANNULUS_OUTER_RADIUS = 8;
const DETECTOR_FWHM_PROFILE_HALF_WIDTH = 5; // Used in the refined estimateFWHM
const DETECTOR_MARGIN = 6; // Margin from image edge for detection
const DETECTOR_FLATNESS_TOLERANCE = 2; // For rejecting flat-topped detections

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
  // if (addLog) addLog(`[DETECTOR BG] Estimated background at (${x},${y}) = ${backgroundValue.toFixed(1)} (from ${count} pixels)`);
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
  // if (addLog) addLog(`[DETECTOR CONTRAST] At (${x},${y}): Value=${pixelValue.toFixed(1)}, Bg=${background.toFixed(1)}, Contrast=${contrast.toFixed(1)}`);
  return contrast;
}


// Uses a 1D profile (horizontal) and interpolates edges for FWHM
function estimateFWHM(
    image: number[][],
    x: number,
    y: number,
    profileHalfWidth = DETECTOR_FWHM_PROFILE_HALF_WIDTH, // How many pixels to each side of center for profile
    addLog?: (message: string) => void
): number {
  const profile: number[] = [];
  const imageWidth = image[0]?.length || 0;
  const imageHeight = image.length;

  if (imageWidth === 0 || imageHeight === 0 || y < 0 || y >= imageHeight) {
    if (addLog) addLog(`[FWHM EST] Invalid image or y-coordinate for FWHM estimation at (${x},${y}).`);
    return 0;
  }

  // Extract horizontal profile around (x,y)
  for (let dx = -profileHalfWidth; dx <= profileHalfWidth; dx++) {
    const px = x + dx;
    if (px >= 0 && px < imageWidth) {
      profile.push(image[y][px]);
    } else {
      profile.push(0); // Pad with zero if outside image bounds
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
      if (profile[i] >= halfMax && profile[i + 1] < halfMax) {
          // Linear interpolation: x = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
          // Here, x is the sub-pixel index, y is the pixel value
          left = i + (profile[i] - halfMax) / (profile[i] - profile[i + 1]);
          break;
      }
  }
  // Handle case where the profile starts above half-max and is falling
  if (left === -1 && profile[0] >= halfMax && profile.length > 1 && profile[0] > profile[1]) {
      left = 0; // Or could try to extrapolate, but simple 0 is safer
  }


  // Find right edge (interpolated)
  for (let i = profile.length - 1; i > 0; i--) {
      if (profile[i] >= halfMax && profile[i - 1] < halfMax) {
          right = i - (profile[i] - halfMax) / (profile[i] - profile[i - 1]);
          break;
      }
  }
   // Handle case where the profile ends above half-max and is rising (less common for stars)
   if (right === -1 && profile[profile.length - 1] >= halfMax && profile.length > 1 && profile[profile.length - 1] > profile[profile.length - 2]) {
      right = profile.length - 1; // Or could try to extrapolate
  }


  const fwhm = (left !== -1 && right !== -1 && right > left) ? Math.abs(right - left) : 0;
  // if (addLog && fwhm > 0) addLog(`[FWHM EST] At (${x},${y}): Peak=${peak.toFixed(1)}, HalfMax=${halfMax.toFixed(1)}, Left=${left.toFixed(2)}, Right=${right.toFixed(2)}, FWHM=${fwhm.toFixed(2)}`);
  // else if (addLog && fwhm === 0) addLog(`[FWHM EST WARN] At (${x},${y}): FWHM is 0. Peak=${peak.toFixed(1)}, L=${left.toFixed(1)}, R=${right.toFixed(1)}`);
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
  addLog(`[DETECTOR] Starting detection on ${width}x${height} grayscale image. Config: MinContrast=${DETECTOR_MIN_CONTRAST}, MinBright=${DETECTOR_MIN_BRIGHTNESS}, MaxBright=${DETECTOR_MAX_BRIGHTNESS}, MinDist=${DETECTOR_MIN_DISTANCE}, MaxStars=${DETECTOR_MAX_STARS}, MinFWHM=${DETECTOR_MIN_FWHM}, MaxFWHM=${DETECTOR_MAX_FWHM}, Margin=${DETECTOR_MARGIN}, FlatTol=${DETECTOR_FLATNESS_TOLERANCE}`);

  const candidates: DetectedStarPoint[] = [];
  let consideredPixels = 0;
  let passedBrightness = 0;
  let passedContrast = 0;
  let passedFWHM = 0;
  let passedFlatnessAndLocalMax = 0;


  for (let y = DETECTOR_MARGIN; y < height - DETECTOR_MARGIN; y++) {
    for (let x = DETECTOR_MARGIN; x < width - DETECTOR_MARGIN; x++) {
      consideredPixels++;
      const value = grayscaleImage[y][x];

      // 1. Brightness range check
      if (value < DETECTOR_MIN_BRIGHTNESS || value > DETECTOR_MAX_BRIGHTNESS) {
        // if (value > DETECTOR_MAX_BRIGHTNESS && addLog) addLog(`[DETECTOR REJECT] (${x},${y}) val ${value.toFixed(0)} > MAX_BRIGHTNESS ${DETECTOR_MAX_BRIGHTNESS}`);
        // else if (value < DETECTOR_MIN_BRIGHTNESS && addLog) addLog(`[DETECTOR REJECT] (${x},${y}) val ${value.toFixed(0)} < MIN_BRIGHTNESS ${DETECTOR_MIN_BRIGHTNESS}`);
        continue;
      }
      passedBrightness++;

      // 2. Local contrast check
      const contrast = getLocalContrast(grayscaleImage, x, y, addLog);
      if (contrast < DETECTOR_MIN_CONTRAST) {
        // if (addLog) addLog(`[DETECTOR REJECT] (${x},${y}) contrast ${contrast.toFixed(1)} < MIN_CONTRAST ${DETECTOR_MIN_CONTRAST}`);
        continue;
      }
      passedContrast++;
      
      // 3. FWHM check
      const fwhm = estimateFWHM(grayscaleImage, x, y, DETECTOR_FWHM_PROFILE_HALF_WIDTH, addLog);
      if (fwhm < DETECTOR_MIN_FWHM || fwhm > DETECTOR_MAX_FWHM) {
        // if (addLog && fwhm !==0) addLog(`[DETECTOR REJECT] (${x},${y}) FWHM ${fwhm.toFixed(1)} out of range [${DETECTOR_MIN_FWHM}-${DETECTOR_MAX_FWHM}]`);
        continue;
      }
      passedFWHM++;

      // 4. Plateau/flat-top and local maximum check
      const neighbors = [
        grayscaleImage[y - 1][x],
        grayscaleImage[y + 1][x],
        grayscaleImage[y][x - 1],
        grayscaleImage[y][x + 1],
      ];
      const tooFlat = neighbors.every(n => Math.abs(n - value) <= DETECTOR_FLATNESS_TOLERANCE);
      if (tooFlat) {
        // if (addLog) addLog(`[DETECTOR REJECT] (${x},${y}) Too flat. Val: ${value.toFixed(0)}, N: ${neighbors.map(n=>n.toFixed(0)).join(',')}`);
        continue;
      }
      // Ensure it's a local maximum compared to immediate neighbors
      if (!(value > neighbors[0] && value > neighbors[1] && value > neighbors[2] && value > neighbors[3])) {
        // if (addLog) addLog(`[DETECTOR REJECT] (${x},${y}) Not local max. Val: ${value.toFixed(0)}, N: ${neighbors.map(n=>n.toFixed(0)).join(',')}`);
           continue;
      }
      passedFlatnessAndLocalMax++;

      candidates.push({ x, y, value, contrast, fwhm });
    }
  }
  addLog(`[DETECTOR STATS] Considered: ${consideredPixels}, Passed Brightness: ${passedBrightness}, Passed Contrast: ${passedContrast}, Passed FWHM: ${passedFWHM}, Passed Flatness/LocalMax: ${passedFlatnessAndLocalMax}, Initial Candidates: ${candidates.length}`);

  // Stable sort by combined brightness and contrast to prioritize significant stars
  candidates.sort((a, b) => (b.value * b.contrast) - (a.value * a.contrast));

  const stars: DetectedStarPoint[] = [];
  for (const cand of candidates) {
    if (stars.length >= DETECTOR_MAX_STARS) break;
    if (isFarEnough(stars, cand.x, cand.y, DETECTOR_MIN_DISTANCE)) {
      stars.push(cand);
    }
  }
  if (stars.length > 0) {
    addLog(`[DETECTOR] Found ${stars.length} stars after filtering. Top star ex: (${stars[0]?.x}, ${stars[0]?.y}) Val:${stars[0]?.value.toFixed(1)} FWHM:${stars[0]?.fwhm.toFixed(1)} Contrast:${stars[0]?.contrast.toFixed(1)}`);
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

      if (currentFullImageX < 0 || currentFullImageX >= fullWidth || currentFullImageY < 0 || currentFullImageY >= fullHeight) {
        continue;
      }

      const pixelStartIndex = (currentFullImageY * fullWidth + currentFullImageX) * 4;
      const r = fullData[pixelStartIndex];
      const g = fullData[pixelStartIndex + 1];
      const b = fullData[pixelStartIndex + 2];
      const pixelBrightness = 0.299 * r + 0.587 * g + 0.114 * b;

      if (pixelBrightness > brightnessThreshold) {
        weightedXSum += xInCrop * pixelBrightness;
        weightedYSum += yInCrop * pixelBrightness;
        totalBrightnessVal += pixelBrightness;
        brightPixelCount++;
      }
    }
  }

  if (totalBrightnessVal === 0 || brightPixelCount === 0) {
    addLog(`[LOCAL CENTROID WARN] No bright pixels (threshold > ${brightnessThreshold}) found in local area [${cropOriginX},${cropOriginY},${cropW},${cropH}]. Failed to find local centroid.`);
    return null;
  }
  
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

const processFitsFileToDataURL_custom = async (file: File, addLog: (message: string) => void): Promise<string | null> => {
  addLog(`[FITS] Starting custom FITS processing for: ${file.name}`);
  try {
    const arrayBuffer = await file.arrayBuffer();
    const dataView = new DataView(arrayBuffer);

    let headerText = "";
    let headerOffset = 0;
    const blockSize = 2880;

    addLog(`[FITS] Reading header blocks...`);
    while (headerOffset < arrayBuffer.byteLength) {
      const blockEnd = Math.min(headerOffset + blockSize, arrayBuffer.byteLength);
      const block = new TextDecoder().decode(arrayBuffer.slice(headerOffset, blockEnd));
      headerText += block;
      headerOffset = blockEnd;
      if (block.includes("END                                                                             ")) {
        break;
      }
      if (headerOffset >= arrayBuffer.byteLength) {
         addLog(`[FITS WARN] Reached end of file while reading header, END card not found precisely. Last block: ${block.substring(0,100)}...`);
         break;
      }
    }
    addLog(`[FITS] Header reading complete. Total header size: ${headerOffset} bytes.`);


    const cards = headerText.match(/.{1,80}/g) || [];
    const headerMap: Record<string, string> = {};
    for (const card of cards) {
      if (card.trim() === "END") break;
      const parts = card.split("=");
      if (parts.length > 1) {
        const key = parts[0].trim();
        const valuePart = parts.slice(1).join("=").trim();
        headerMap[key] = valuePart.split("/")[0].trim().replace(/'/g, "");
      } else {
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
    const rawPixelData = new Float32Array(pixelCount); 

    const imageDataOffset = headerOffset; 
    addLog(`[FITS] Image data starting at offset: ${imageDataOffset}`);


    if (imageDataOffset + pixelCount * bytesPerPixel > arrayBuffer.byteLength) {
      addLog(`[FITS ERROR] Calculated image data size (${pixelCount * bytesPerPixel} bytes at offset ${imageDataOffset}) exceeds file size (${arrayBuffer.byteLength} bytes). Header might be malformed or file truncated.`);
      return null;
    }

    const isBigEndian = true; 

    for (let i = 0; i < pixelCount; i++) {
      const pixelByteOffset = imageDataOffset + i * bytesPerPixel;
      try {
        if (bitpix === 8) { 
            rawPixelData[i] = dataView.getUint8(pixelByteOffset);
        } else if (bitpix === 16) { 
            rawPixelData[i] = dataView.getInt16(pixelByteOffset, !isBigEndian);
        } else if (bitpix === 32) { 
            rawPixelData[i] = dataView.getInt32(pixelByteOffset, !isBigEndian);
        } else if (bitpix === -32) { 
            rawPixelData[i] = dataView.getFloat32(pixelByteOffset, !isBigEndian);
        } else if (bitpix === -64) { 
            rawPixelData[i] = dataView.getFloat64(pixelByteOffset, !isBigEndian);
        }
         else {
          addLog(`[FITS ERROR] Unsupported BITPIX value: ${bitpix}. Cannot read pixel data. Reading first pixel and stopping.`);
          console.error("Unsupported BITPIX:", bitpix);
          return null;
        }
      } catch (e) {
        addLog(`[FITS ERROR] Error reading pixel data at index ${i} (offset ${pixelByteOffset}): ${e instanceof Error ? e.message : String(e)}. File might be corrupted or BITPIX incorrect.`);
        return null;
      }
    }
    addLog(`[FITS] Raw pixel data read successfully.`);


    let minVal = Infinity;
    let maxVal = -Infinity;
    for (let i = 0; i < pixelCount; i++) {
      if (rawPixelData[i] < minVal) minVal = rawPixelData[i];
      if (rawPixelData[i] > maxVal) maxVal = rawPixelData[i];
    }

    if (minVal === Infinity || maxVal === -Infinity || isNaN(minVal) || isNaN(maxVal) ) {
        addLog(`[FITS WARN] Could not determine valid min/max for normalization (min: ${minVal}, max: ${maxVal}). Image might be blank or contain only NaNs. Setting to default 0-255 range.`);
        minVal = 0;
        maxVal = 255;
    }
    addLog(`[FITS] Normalization range: min=${minVal}, max=${maxVal}`);


    const normalizedPixels = new Uint8ClampedArray(pixelCount);
    const range = maxVal - minVal;
    if (range === 0) {
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
      imgData.data[i * 4 + 0] = val;
      imgData.data[i * 4 + 1] = val;
      imgData.data[i * 4 + 2] = val;
      imgData.data[i * 4 + 3] = 255;
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


const averageImageDataArrays = (imageDataArrays: ImageData[], targetWidth: number, targetHeight: number, addLog: (message: string) => void): Uint8ClampedArray | null => {
  if (!imageDataArrays || imageDataArrays.length === 0) {
    addLog("[CAL MASTER] No image data arrays provided for averaging.");
    return null;
  }

  const numImages = imageDataArrays.length;
  const totalPixels = targetWidth * targetHeight;
  const sumData = new Float32Array(totalPixels * 4); 

  let validImagesProcessed = 0;
  for (const imgData of imageDataArrays) {
    if (imgData.width !== targetWidth || imgData.height !== targetHeight) {
      addLog(`[CAL MASTER WARN] Skipping image data in average due to dimension mismatch. Expected ${targetWidth}x${targetHeight}, got ${imgData.width}x${imgData.height}. This frame will not be part of the master.`);
      continue; 
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
    averagedData[i] = sumData[i] / validImagesProcessed; 
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
  const [currentEditingImageData, setCurrentEditingImageData] = useState<ImageData | null>(null);


  const [showApplyStarOptionsMenu, setShowApplyStarOptionsMenu] = useState(false);
  const [sourceImageForApplyMenu, setSourceImageForApplyMenu] = useState<SourceImageForApplyMenu | null>(null);
  const [isApplyingStarsFromMenu, setIsApplyingStarsFromMenu] = useState(false);


  const [showPostProcessEditor, setShowPostProcessEditor] = useState(false);
  const [imageForPostProcessing, setImageForPostProcessing] = useState<string | null>(null);
  const [editedPreviewUrl, setEditedPreviewUrl] = useState<string | null>(null);

  const [brightness, setBrightness] = useState(100);
  const [exposure, setExposure] = useState(0);
  const [saturation, setSaturation] = useState(100);
  const [isApplyingAdjustments, setIsApplyingAdjustments] = useState(false);

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
          const dngMsg = `${file.name} is a DNG. Direct browser preview might be limited or slow. Manual conversion to JPG/PNG is recommended for best results.`;
          addLog(`[WARN] ${dngMsg}`);
          toast({
            title: "DNG File Detected",
            description: dngMsg,
            variant: "default", 
            duration: 8000,
          });
          originalPreviewUrl = await fileToDataURL(file); 

        } else if (acceptedWebTypes.includes(fileType)) {
            originalPreviewUrl = await fileToDataURL(file);
        } else {
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
                const errorMessage = `Could not load generated preview image ${file.name} to check dimensions. This can happen if the data URL is invalid or too large. FITS files may produce large data URLs.`;
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
            continue; 
          }
        } else if (!acceptedWebTypes.includes(fileType)) {
          addLog(`[ERROR] Unsupported ${frameTypeName} frame ${file.name}. Use JPG, PNG, GIF, WEBP, or FITS.`);
          toast({ title: `Unsupported ${frameTypeName} Frame`, description: `${file.name} is unsupported.`, variant: "destructive" });
          continue; 
        } else {
          previewUrl = await fileToDataURL(file);
        }

        if (!previewUrl) {
          addLog(`[ERROR] Could not generate preview for ${frameType} frame ${file.name}.`);
          continue; 
        }
        
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

  const analyzeImageForStars = useCallback(async (imageIndex: number): Promise<boolean> => {
    const currentEntry = allImageStarData[imageIndex];
    if (!currentEntry || currentEntry.isAnalyzing) return false;

    setAllImageStarData(prev => prev.map((entry, idx) => idx === imageIndex ? { ...entry, isAnalyzing: true } : entry));
    addLog(`[DETECTOR] Starting star analysis for: ${currentEntry.file.name} using new self-contained detector...`);

    try {
      const imgEl = await loadImage(currentEntry.previewUrl, currentEntry.file.name);

      const tempAnalysisCanvas = document.createElement('canvas');
      const tempAnalysisCtx = tempAnalysisCanvas.getContext('2d', { willReadFrequently: true });
      if (!tempAnalysisCtx) throw new Error("Could not get analysis canvas context.");

      const analysisWidth = currentEntry.analysisDimensions.width;
      const analysisHeight = currentEntry.analysisDimensions.height;

      tempAnalysisCanvas.width = analysisWidth;
      tempAnalysisCanvas.height = analysisHeight;
      tempAnalysisCtx.drawImage(imgEl, 0, 0, analysisWidth, analysisHeight);
      
      addLog(`[DETECTOR] Canvas prepared for ${currentEntry.file.name} at ${analysisWidth}x${analysisHeight}.`);

      const grayscaleImageArray = getGrayscaleArrayFromCanvas(tempAnalysisCtx, addLog);
      if (grayscaleImageArray.length === 0 || grayscaleImageArray[0].length === 0) {
          addLog(`[DETECTOR ERROR] Failed to convert canvas to valid grayscale array for star detection. Dimensions: ${grayscaleImageArray.length}x${grayscaleImageArray[0]?.length || 0}`);
          throw new Error("Failed to convert canvas to valid grayscale array for star detection.");
      }
      
      const detectedPoints: DetectedStarPoint[] = detectStarsWithNewPipeline(grayscaleImageArray, addLog);
      
      addLog(`[DETECTOR] Detected ${detectedPoints.length} points in ${currentEntry.file.name}. (Max Target: ${DETECTOR_MAX_STARS})`);
      
      if (detectedPoints.length > 0) {
        const fwhmValues = detectedPoints.map(s => s.fwhm).filter(f => f !== undefined && !isNaN(f));
        if (fwhmValues.length > 0) {
            const avgFwhm = fwhmValues.reduce((sum, f) => sum + f, 0) / fwhmValues.length;
            const minFwhm = Math.min(...fwhmValues);
            const maxFwhm = Math.max(...fwhmValues);
            addLog(`[DETECTOR] FWHM stats for ${currentEntry.file.name} (${fwhmValues.length} stars): Avg=${avgFwhm.toFixed(2)}, Min=${minFwhm.toFixed(2)}, Max=${maxFwhm.toFixed(2)}`);
        }
      } else {
        addLog(`[DETECTOR WARN] No stars detected for ${currentEntry.file.name}. Review detector parameters or image quality. Logs above might indicate rejection reasons.`);
      }

      const finalStars: Star[] = detectedPoints.map(pStar => ({
        x: pStar.x, 
        y: pStar.y, 
        brightness: pStar.value, 
        fwhm: pStar.fwhm, // Store FWHM
        isManuallyAdded: false,
      }));

      setAllImageStarData(prev => prev.map((entry, idx) => {
        if (idx === imageIndex) {
          const newEntry = {
            ...entry,
            initialAutoStars: [...finalStars], 
            analysisDimensions: { width: analysisWidth, height: analysisHeight }, 
            isAnalyzed: true,
            isAnalyzing: false,
          };
          if (newEntry.starSelectionMode === 'auto' || (newEntry.starSelectionMode === 'manual' && !newEntry.userReviewed)) {
            newEntry.analysisStars = [...finalStars];
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
          userReviewed: false, 
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

    await yieldToEventLoop(10); 
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

    setCurrentEditingImageData(null); 

    let entryForEditing = {...currentEntry};

    if (entryForEditing.starSelectionMode === 'auto' ||
        (entryForEditing.starSelectionMode === 'manual' && !entryForEditing.userReviewed && entryForEditing.analysisStars.length === 0)) {
      addLog(`Switching ${entryForEditing.file.name} to manual mode for editing (or preparing unreviewed manual).`);
      entryForEditing.starSelectionMode = 'manual';
      if (entryForEditing.initialAutoStars.length > 0) { 
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
        toast({title: "Analysis Failed", description: `Could not analyze ${updatedEntryForAnalysisCheck.file.name}. Cannot edit stars.`, variant: "destructive"});
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
              setCurrentEditingImageData(null); 
              addLog(`[WARN] Could not get canvas context to load ImageData for ${finalEntryForEditing.file.name}. Precise click refinement disabled.`);
              toast({title: "Warning", description: `Could not prepare image data for ${finalEntryForEditing.file.name}. Precise click refinement disabled.`});
          }
          setCurrentEditingImageIndex(imageIndex);
          setIsStarEditingMode(true);
          addLog(`Opened star editor for ${finalEntryForEditing.file.name}. Mode: Manual. Initial stars for edit: ${starsToEdit.length}. Dim: ${finalEntryForEditing.analysisDimensions.width}x${finalEntryForEditing.analysisDimensions.height}`);
      };
      imgToEdit.onerror = () => {
          setCurrentEditingImageData(null); 
          addLog(`[ERROR] Failed to load image ${finalEntryForEditing.file.name} for ImageData preparation for editor.`);
          toast({title: "Editor Error", description: `Could not load image ${finalEntryForEditing.file.name} for editing stars.`, variant: "destructive"});
          setIsStarEditingMode(false); 
      };
      imgToEdit.src = finalEntryForEditing.previewUrl; 

    } else {
       console.warn(`Cannot edit stars for ${finalEntryForEditing?.file?.name || 'image'}: Analysis data, dimension data, or preview URL might be incomplete or loading failed.`);
       toast({title: "Error", description: `Could not prepare ${finalEntryForEditing?.file?.name || 'image'} for star editing. Analysis data may be missing.`, variant: "destructive"});
    }
  };

  const handleStarAnnotationClick = (clickedX_analysis: number, clickedY_analysis: number) => {
    if (currentEditingImageIndex === null) return;

    const entry = allImageStarData[currentEditingImageIndex];
    if (!entry || !entry.analysisDimensions) {
      addLog("[STAR EDIT ERROR] No valid image entry or analysis dimensions for star annotation.");
      return;
    }

    let finalStarX = clickedX_analysis;
    let finalStarY = clickedY_analysis;

    if (currentEditingImageData) {
      const searchRadius = MANUAL_STAR_CLICK_CENTROID_RADIUS;
      const cropRectX = Math.max(0, Math.round(clickedX_analysis) - searchRadius);
      const cropRectY = Math.max(0, Math.round(clickedY_analysis) - searchRadius);
      
      const cropRectWidth = Math.min(
        currentEditingImageData.width - cropRectX, 
        searchRadius * 2
      );
      const cropRectHeight = Math.min(
        currentEditingImageData.height - cropRectY, 
        searchRadius * 2
      );

      if (cropRectWidth > 0 && cropRectHeight > 0) {
        const localCentroid = calculateLocalBrightnessCentroid(
          currentEditingImageData, 
          { x: cropRectX, y: cropRectY, width: cropRectWidth, height: cropRectHeight },
          addLog, 
          MANUAL_STAR_CLICK_CENTROID_BRIGHTNESS_THRESHOLD
        );

        if (localCentroid) {
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

    const effectiveCanvasDisplayWidth = Math.min(STAR_ANNOTATION_MAX_DISPLAY_WIDTH, entry.analysisDimensions.width);
    const clickToleranceInAnalysisUnits = effectiveCanvasDisplayWidth > 0 ? (STAR_CLICK_TOLERANCE_ON_DISPLAY_CANVAS_PX / effectiveCanvasDisplayWidth) * entry.analysisDimensions.width : STAR_CLICK_TOLERANCE_ON_DISPLAY_CANVAS_PX;
    const dynamicClickToleranceSquared = clickToleranceInAnalysisUnits * clickToleranceInAnalysisUnits;

    setAllImageStarData(prev => prev.map((item, idx) => {
      if (idx === currentEditingImageIndex) {
        let starFoundAndRemoved = false;
        const updatedStars = item.analysisStars.filter(star => {
          const dx = star.x - finalStarX; 
          const dy = star.y - finalStarY; 
          const distSq = dx * dx + dy * dy;
          if (distSq < dynamicClickToleranceSquared) {
            starFoundAndRemoved = true;
            addLog(`Removed star at (${star.x.toFixed(0)}, ${star.y.toFixed(0)}) from ${item.file.name} (click refined to ${finalStarX.toFixed(0)}, ${finalStarY.toFixed(0)}).`);
            return false; 
          }
          return true; 
        });

        if (!starFoundAndRemoved) {
          const newStar: Star = {
            x: finalStarX,
            y: finalStarY,
            brightness: 150, 
            fwhm: 2.5, // Default FWHM for manually added star
            isManuallyAdded: true,
          };
          updatedStars.push(newStar);
          addLog(`Added manual star at refined position (${finalStarX.toFixed(0)}, ${finalStarY.toFixed(0)}) to ${item.file.name}. Total stars: ${updatedStars.length}`);
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
    setCurrentEditingImageData(null); 
    toast({title: "Stars Confirmed", description: `Star selection saved for ${currentImageName}.`});

    if (allImageStarData.length > 1 && confirmedEntry.analysisStars && confirmedEntry.analysisDimensions) {
        setSourceImageForApplyMenu({
            id: confirmedEntry.id,
            fileName: confirmedEntry.file.name,
            stars: [...confirmedEntry.analysisStars], 
            dimensions: { ...confirmedEntry.analysisDimensions }, 
        });
        setShowApplyStarOptionsMenu(true);
    } else {
      setCurrentEditingImageIndex(null);
    }
  };

  const handleConfirmAndNext = async () => {
    if (currentEditingImageIndex === null) return; 

    const hasNextImage = currentEditingImageIndex < allImageStarData.length - 1;
    
    const currentImageEntry = allImageStarData[currentEditingImageIndex];
    const currentImageName = currentImageEntry?.file.name || "current image";
    addLog(`Confirmed star selection for ${currentImageName} and ${hasNextImage ? 'moving to next' : 'closing (last image)'}. Total stars: ${currentImageEntry?.analysisStars.length}. Mode: Manual.`);

    setAllImageStarData(prev => prev.map((entry, idx) =>
      idx === currentEditingImageIndex ? { ...entry, userReviewed: true, starSelectionMode: 'manual' } : entry
    ));
    
    toast({title: "Stars Confirmed", description: `Star selection saved for ${currentImageName}.`});

    if (!hasNextImage) {
      setIsStarEditingMode(false);
      setCurrentEditingImageData(null);
      setCurrentEditingImageIndex(null);
      return;
    }

    const nextImageIndex = currentEditingImageIndex + 1;
    await handleEditStarsRequest(nextImageIndex); 
  };

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
          analysisStars: [...starsToApply], 
          starSelectionMode: 'manual' as StarSelectionMode, 
          userReviewed: true, 
          isAnalyzed: true, 
        };
      }
      return entry;
    }));

    toast({title: t('toastStarsAppliedMatchingDimTitle'), description: t('toastStarsAppliedMatchingDimDesc')});
    setShowApplyStarOptionsMenu(false);
    setSourceImageForApplyMenu(null);
    setCurrentEditingImageIndex(null); 
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
  
    const updatedImageStarData = await Promise.all(allImageStarData.map(async (targetEntry) => {
      if (targetEntry.id === sourceId) {
        return targetEntry; 
      }
  
      if (!targetEntry.analysisDimensions || targetEntry.analysisDimensions.width === 0 || targetEntry.analysisDimensions.height === 0) {
        addLog(`[WARN] Skipping proportional apply for ${targetEntry.file.name}: Dimension data not available or invalid.`);
        return targetEntry;
      }
  
      const { width: targetWidth, height: targetHeight } = targetEntry.analysisDimensions;
      const targetAspectRatio = targetWidth / targetHeight;
  
      if (Math.abs(sourceAspectRatio - targetAspectRatio) < ASPECT_RATIO_TOLERANCE) {
        addLog(`Applying stars proportionally to ${targetEntry.file.name} (Matching aspect ratio: Source ${sourceAspectRatio.toFixed(2)}, Target ${targetAspectRatio.toFixed(2)})...`);
        const transformedStars = sourceStars.map(star => ({
          ...star, // Preserve fwhm and other properties
          x: (star.x / sourceWidth) * targetWidth,
          y: (star.y / sourceHeight) * targetHeight,
          isManuallyAdded: true, 
        }));
  
        addLog(`Successfully applied ${transformedStars.length} stars proportionally to ${targetEntry.file.name}.`);
        return {
          ...targetEntry,
          analysisStars: transformedStars,
          starSelectionMode: 'manual' as StarSelectionMode, 
          userReviewed: true, 
          isAnalyzed: targetEntry.isAnalyzed || true, 
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
    setCurrentEditingImageIndex(null); 
    setCurrentEditingImageData(null);
  };

  const handleCancelApplyStarOptionsMenu = () => {
    setShowApplyStarOptionsMenu(false);
    setSourceImageForApplyMenu(null);
    setCurrentEditingImageIndex(null); 
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
    setLogs([]); 
    logIdCounter.current = 0;

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
            
            // Fetch the latest version of the entry from state AFTER analysis
            const potentiallyUpdatedEntryFromState = allImageStarData.find(e => e.id === entry.id);

            if (analysisSuccess && potentiallyUpdatedEntryFromState && potentiallyUpdatedEntryFromState.isAnalyzed) {
                addLog(`Analysis successful for ${entry.file.name}. isAnalyzed: ${potentiallyUpdatedEntryFromState.isAnalyzed}`);
                updatedStarDataForStacking[i] = { ...potentiallyUpdatedEntryFromState }; 
                entry = updatedStarDataForStacking[i]; 
            } else {
                const analyzeFailMsg = `Analysis failed for ${entry.file.name}. It will be processed with fallback alignment.`;
                addLog(`[WARN] ${analyzeFailMsg} (Details: analysisSuccess=${analysisSuccess}, entryFound=${!!potentiallyUpdatedEntryFromState}, entryAnalyzed=${potentiallyUpdatedEntryFromState?.isAnalyzed})`);
                toast({ title: `Analysis Warning for ${entry.file.name}`, description: analyzeFailMsg, variant: "default"});
                updatedStarDataForStacking[i] = { ...(potentiallyUpdatedEntryFromState || entry), isAnalyzed: false, isAnalyzing: false, analysisStars: [], initialAutoStars: [] };
                entry = updatedStarDataForStacking[i]; 
            }
             setAllImageStarData(prev => prev.map((e) => e.id === entry.id ? {...e, isAnalyzing: false, isAnalyzed: entry.isAnalyzed } : e));
        }

        // Prepare analysisStars specifically for this stacking run, ensuring correct stars based on mode
        if (entry.starSelectionMode === 'auto') {
            const sortedAutoStars = [...entry.initialAutoStars].sort((a, b) => b.brightness - a.brightness);
            // Use a consistent number of stars for alignment if in auto mode, potentially more than detector max if initialAutoStars was populated differently
            const starsForAlignment = sortedAutoStars.slice(0, Math.max(NUM_STARS_TO_USE_FOR_AFFINE_MATCHING, AUTO_ALIGN_TARGET_STAR_COUNT));
            
            if (JSON.stringify(entry.analysisStars) !== JSON.stringify(starsForAlignment)) {
                 updatedStarDataForStacking[i] = { ...entry, analysisStars: [...starsForAlignment] }; 
                 addLog(`For auto mode image ${entry.file.name}, set analysisStars to top ${starsForAlignment.length} auto-detected stars for alignment.`);
            }
        } else if (entry.starSelectionMode === 'manual') {
            if (!entry.userReviewed) { // Manual mode, but stars not yet confirmed by user in editor
                if ((!entry.analysisStars || entry.analysisStars.length === 0) && entry.initialAutoStars.length > 0) {
                    // If manual but no user review and analysisStars is empty, use initialAutoStars as a base
                    const starsForAlignment = [...entry.initialAutoStars].sort((a,b) => b.brightness - a.brightness).slice(0, Math.max(NUM_STARS_TO_USE_FOR_AFFINE_MATCHING, AUTO_ALIGN_TARGET_STAR_COUNT));
                    updatedStarDataForStacking[i] = { ...entry, analysisStars: starsForAlignment };
                    addLog(`For unreviewed manual image ${entry.file.name}, using top ${starsForAlignment.length} initial auto-detected stars as analysisStars was empty.`);
                } else if (entry.analysisStars && entry.analysisStars.length > 0) {
                    addLog(`For unreviewed manual image ${entry.file.name}, using its existing ${entry.analysisStars.length} analysis stars.`);
                } else {
                     addLog(`For unreviewed manual image ${entry.file.name}, no stars available. Will use fallback alignment.`);
                }
            } else { // Manual mode and user has reviewed/confirmed stars
                 addLog(`For reviewed manual image ${entry.file.name}, using its ${entry.analysisStars.length} user-confirmed stars.`);
            }
        }
         await yieldToEventLoop(10); 
    }

    setAllImageStarData(updatedStarDataForStacking); // Update global state with prepared star lists before proceeding
    addLog("Pre-stack analysis and star-list preparation finished.");
    await yieldToEventLoop(100); 

    try {
      let imageElements: HTMLImageElement[] = [];
      addLog(`Loading ${updatedStarDataForStacking.length} image elements from their previewUrls...`);
      for (const entry of updatedStarDataForStacking) { 
        try {
          const imgEl = await loadImage(entry.previewUrl, entry.file.name);
          imageElements.push(imgEl);
        } catch (loadError) {
           const errorMessage = loadError instanceof Error ? loadError.message : String(loadError);
           addLog(`[LOAD ERROR] ${entry.file.name}: ${errorMessage}`);
           toast({ title: `Error Loading ${entry.file.name}`, description: errorMessage, variant: "destructive" });
        }
      }
      addLog(`Successfully loaded ${imageElements.length} out of ${updatedStarDataForStacking.length} images into HTMLImageElements.`);

      if (imageElements.length < 2) {
        const notEnoughValidMsg = `Need at least two valid images for stacking after filtering. Found ${imageElements.length}.`;
        addLog(`[ERROR] ${notEnoughValidMsg}`);
        toast({ title: "Not Enough Valid Images", description: notEnoughValidMsg, variant: "destructive" });
        setIsProcessingStack(false);
        setProgressPercent(0);
        return;
      }

      const firstValidImageIndexInOriginal = updatedStarDataForStacking.findIndex(
        entry => imageElements.some(imgEl => imgEl.src === entry.previewUrl)
      );

      if (firstValidImageIndexInOriginal === -1) {
        const noValidRefMsg = `Could not find a valid reference image among loaded images. Cannot proceed.`;
        addLog(`[ERROR] ${noValidRefMsg}`);
        toast({ title: "Invalid Reference Image", description: noValidRefMsg, variant: "destructive" });
        setIsProcessingStack(false); setProgressPercent(0); return;
      }
      
      const firstImageEntryForStacking = updatedStarDataForStacking[firstValidImageIndexInOriginal];
      const firstLoadedImageElement = imageElements.find(imgEl => imgEl.src === firstImageEntryForStacking.previewUrl);

      if (!firstLoadedImageElement || !firstImageEntryForStacking?.analysisDimensions || firstImageEntryForStacking.analysisDimensions.width === 0 || firstImageEntryForStacking.analysisDimensions.height === 0) {
        const invalidRefMsg = `The reference image (${firstImageEntryForStacking?.file?.name || 'unknown'}) is invalid or its analysis dimensions are missing/zero. Cannot proceed.`;
        addLog(`[ERROR] ${invalidRefMsg}`);
        toast({ title: "Invalid Reference Image", description: invalidRefMsg, variant: "destructive" });
        setIsProcessingStack(false); setProgressPercent(0); return;
      }

      let targetWidth = firstImageEntryForStacking.analysisDimensions.width;
      let targetHeight = firstImageEntryForStacking.analysisDimensions.height;
      addLog(`Target stacking dimensions (from reference image '${firstImageEntryForStacking.file.name}' analysisDimensions): ${targetWidth}x${targetHeight}.`);


      if (targetWidth === 0 || targetHeight === 0) {
        const zeroDimMsg = "Calculated target stacking dimensions are zero. Cannot proceed.";
        addLog(`[ERROR] ${zeroDimMsg}`);
        toast({ title: "Error", description: zeroDimMsg, variant: "destructive" });
        setIsProcessingStack(false);
        setProgressPercent(0);
        return;
      }

      const calibrationCanvas = document.createElement('canvas');
      calibrationCanvas.width = targetWidth;
      calibrationCanvas.height = targetHeight;
      const calCtx = calibrationCanvas.getContext('2d', { willReadFrequently: true });
      if (!calCtx) throw new Error("Could not get calibration canvas context.");


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

            if (masterBiasData) {
              const tempDarkData = new Uint8ClampedArray(currentDarkFrameImageData.data);
              for (let p = 0; p < tempDarkData.length; p += 4) {
                tempDarkData[p] = Math.max(0, tempDarkData[p] - masterBiasData[p]);
                tempDarkData[p+1] = Math.max(0, tempDarkData[p+1] - masterBiasData[p+1]);
                tempDarkData[p+2] = Math.max(0, tempDarkData[p+2] - masterBiasData[p+2]);
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

            if (masterBiasData) {
              const tempFlatData = new Uint8ClampedArray(currentFlatFrameImageData.data);
              for (let p = 0; p < tempFlatData.length; p += 4) {
                tempFlatData[p] = Math.max(0, tempFlatData[p] - masterBiasData[p]);
                tempFlatData[p+1] = Math.max(0, tempFlatData[p+1] - masterBiasData[p+1]);
                tempFlatData[p+2] = Math.max(0, tempFlatData[p+2] - masterBiasData[p+2]); // Fixed: masterBiasData[p+2]
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


      const numValidLightImages = imageElements.length; 
      const totalPixels = targetWidth * targetHeight;
      const normalizedImageFactor = Math.min(1, numValidLightImages / 20); 
      const veryLargePixelCount = 10000 * 10000; 
      const normalizedPixelFactor = Math.min(1, totalPixels / veryLargePixelCount);
      const loadScore = (0.3 * normalizedImageFactor) + (0.7 * normalizedPixelFactor); 
      const dynamicDelayMs = Math.max(10, Math.min(100, 10 + Math.floor(loadScore * 90))); 
      addLog(`Calculated dynamic yield delay: ${dynamicDelayMs}ms (Load score: ${loadScore.toFixed(2)}, Images: ${numValidLightImages}, Pixels: ${totalPixels})`);

      const centroids: ({ x: number; y: number } | null)[] = [];
      let successfulCentroidBasedAlignments = 0;
      const centroidProgressIncrement = numValidLightImages > 0 ? PROGRESS_CENTROID_CALCULATION_TOTAL / numValidLightImages : 0;
      
      const tempAnalysisCanvasForFallback = document.createElement('canvas'); 
      const tempAnalysisCtxForFallback = tempAnalysisCanvasForFallback.getContext('2d', { willReadFrequently: true });
      if (!tempAnalysisCtxForFallback) throw new Error("Could not get fallback analysis canvas context.");


      addLog(`Starting fallback centroid calculation for ${numValidLightImages} valid light images (used if Affine fails)...`);
      for (let i = 0; i < updatedStarDataForStacking.length; i++) {
        const entryData = updatedStarDataForStacking[i];
        const imgEl = imageElements.find(el => el.src === entryData.previewUrl);

        if (!imgEl) {
            centroids.push(null); continue;
        }
        const fileNameForLog = entryData.file.name;
        let finalScaledCentroid: { x: number; y: number } | null = null;
        let method = "unknown_fallback";
        
        let starsForCentroidCalc: Star[] = entryData.analysisStars;
        if (entryData.starSelectionMode === 'auto') { 
            starsForCentroidCalc = [...entryData.initialAutoStars].sort((a,b) => b.brightness - a.brightness).slice(0, AUTO_ALIGN_TARGET_STAR_COUNT);
        }

        if (!entryData.isAnalyzed || !entryData.analysisDimensions || entryData.analysisDimensions.width === 0 || entryData.analysisDimensions.height === 0) {
            finalScaledCentroid = { x: targetWidth / 2, y: targetHeight / 2 };
            method = `geometric_fallback (no_analysis_data)`;
            addLog(`[FALLBACK GEOMETRIC] Image ${i} (${fileNameForLog}) due to missing analysis data. Centroid: (${finalScaledCentroid.x.toFixed(2)}, ${finalScaledCentroid.y.toFixed(2)})`);
        } else {
            const {width: analysisWidth, height: analysisHeight} = entryData.analysisDimensions;
            let analysisImageCentroid = calculateStarArrayCentroid(starsForCentroidCalc, addLog);
            if (analysisImageCentroid) {
                method = `star-based_fallback (${starsForCentroidCalc.length} stars)`;
                successfulCentroidBasedAlignments++;
            } else {
                method = `brightness-based_fallback`;
                addLog(`[FALLBACK BRIGHTNESS] Image ${i} (${fileNameForLog}): Star centroid failed. Trying brightness centroid on ${analysisWidth}x${analysisHeight} canvas.`);
                tempAnalysisCanvasForFallback.width = analysisWidth; tempAnalysisCanvasForFallback.height = analysisHeight;
                tempAnalysisCtxForFallback.clearRect(0,0,analysisWidth,analysisHeight);
                tempAnalysisCtxForFallback.drawImage(imgEl, 0,0,analysisWidth,analysisHeight);
                analysisImageCentroid = calculateBrightnessCentroid(tempAnalysisCtxForFallback.getImageData(0,0,analysisWidth,analysisHeight), addLog);
            }
            if (analysisImageCentroid) {
                finalScaledCentroid = { x: (analysisImageCentroid.x / analysisWidth) * targetWidth, y: (analysisImageCentroid.y / analysisHeight) * targetHeight };
            } else {
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
        await yieldToEventLoop(dynamicDelayMs / 2); 
      }
      addLog(`Fallback centroid calculation complete. ${successfulCentroidBasedAlignments}/${numValidLightImages} would use star-based if affine failed.`);
      
      const referenceEntryForAffine = updatedStarDataForStacking[firstValidImageIndexInOriginal];
      let referenceStarsForAffine: AstroAlignPoint[] = [];

      if (referenceEntryForAffine && referenceEntryForAffine.isAnalyzed && referenceEntryForAffine.analysisStars.length >= MIN_STARS_FOR_AFFINE_ALIGNMENT) {
          const goodFWHMRefStars = referenceEntryForAffine.analysisStars
              .filter(s => s.fwhm !== undefined && s.fwhm >= ALIGNMENT_STAR_MIN_FWHM && s.fwhm <= ALIGNMENT_STAR_MAX_FWHM)
              .sort((a,b) => b.brightness - a.brightness)
              .slice(0, NUM_STARS_TO_USE_FOR_AFFINE_MATCHING);
          
          addLog(`[AFFINE REF PREP] Ref Image ${referenceEntryForAffine.file.name}: Total analysis stars: ${referenceEntryForAffine.analysisStars.length}. After FWHM filter (${ALIGNMENT_STAR_MIN_FWHM}-${ALIGNMENT_STAR_MAX_FWHM}): ${goodFWHMRefStars.length} stars.`);

          if (goodFWHMRefStars.length >= MIN_STARS_FOR_AFFINE_ALIGNMENT) {
              referenceStarsForAffine = goodFWHMRefStars.map(s => {
                  addLog(`[AFFINE REF STAR] Using: x=${s.x.toFixed(2)}, y=${s.y.toFixed(2)}, fwhm=${s.fwhm?.toFixed(2)}, bright=${s.brightness.toFixed(0)}`);
                  return { x: s.x, y: s.y };
              });
              addLog(`[AFFINE REF] Using ${referenceStarsForAffine.length} FWHM-filtered stars from reference image ${referenceEntryForAffine.file.name} for affine.`);
          } else {
              addLog(`[AFFINE REF WARN] Ref image ${referenceEntryForAffine.file.name} has only ${goodFWHMRefStars.length} stars after FWHM filter (min ${MIN_STARS_FOR_AFFINE_ALIGNMENT} needed). Affine will be disabled for all frames.`);
              referenceStarsForAffine = []; 
          }
      } else {
           addLog(`[AFFINE REF INFO] Reference image ${referenceEntryForAffine?.file?.name || 'N/A'} not suitable for affine (not analyzed, or < ${MIN_STARS_FOR_AFFINE_ALIGNMENT} stars before FWHM filter). Affine alignment will be skipped for all images.`);
           referenceStarsForAffine = [];
      }
      const referenceCentroidForFallback = centroids[firstValidImageIndexInOriginal]; 

      const finalImageData = new Uint8ClampedArray(targetWidth * targetHeight * 4); 
      let validImagesStackedCount = 0;
      let affineAlignmentsUsed = 0;

      addLog(`Starting band processing for stacking. Band height: ${STACKING_BAND_HEIGHT}px. Mode: ${stackingMode}.`);
      const numBands = targetHeight > 0 ? Math.ceil(targetHeight / STACKING_BAND_HEIGHT) : 0;
      const bandProgressIncrement = numBands > 0 ? PROGRESS_BANDED_STACKING_TOTAL / numBands : 0;
      
      const currentImageCanvas = document.createElement('canvas'); 
      currentImageCanvas.width = targetWidth; currentImageCanvas.height = targetHeight;
      const currentImageCtx = currentImageCanvas.getContext('2d', { willReadFrequently: true });
      if (!currentImageCtx) throw new Error("Could not get current image canvas context.");
      currentImageCtx.imageSmoothingEnabled = true;
      currentImageCtx.imageSmoothingQuality = 'high';


      const tempWarpedImageCanvas = document.createElement('canvas'); 
      tempWarpedImageCanvas.width = targetWidth; tempWarpedImageCanvas.height = targetHeight;
      const tempWarpedImageCtx = tempWarpedImageCanvas.getContext('2d', { willReadFrequently: true });
      if (!tempWarpedImageCtx) throw new Error("Could not get temp warped image canvas context.");
      tempWarpedImageCtx.imageSmoothingEnabled = true;
      tempWarpedImageCtx.imageSmoothingQuality = 'high';


      for (let yBandStart = 0; yBandStart < targetHeight; yBandStart += STACKING_BAND_HEIGHT) {
        const currentBandHeight = Math.min(STACKING_BAND_HEIGHT, targetHeight - yBandStart);
        const bandPixelDataCollector: Array<{ r: number[], g: number[], b: number[] }> = Array.from(
            { length: targetWidth * currentBandHeight }, () => ({ r: [], g: [], b: [] })
        );

        let imagesContributingToBand = 0;
        for (let i = 0; i < imageElements.length; i++) {
          const imgElement = imageElements[i];
          const originalEntryIndex = updatedStarDataForStacking.findIndex(entry => entry.previewUrl === imgElement.src);
          if (originalEntryIndex === -1) { addLog(`[STACK SKIP] Cannot find entry data for image element ${i}`); continue; }
          const currentImageEntry = updatedStarDataForStacking[originalEntryIndex];

          currentImageCtx.clearRect(0,0,targetWidth,targetHeight);
          currentImageCtx.drawImage(imgElement, 0,0,targetWidth,targetHeight);
          let lightFrameForCalib = currentImageCtx.getImageData(0,0,targetWidth,targetHeight);
          let calibratedLightDataArray = new Uint8ClampedArray(lightFrameForCalib.data);
          let logCalibrationMsg = "";

          if (masterBiasData) { 
            for (let p = 0; p < calibratedLightDataArray.length; p += 4) {
                calibratedLightDataArray[p] = Math.max(0, calibratedLightDataArray[p] - masterBiasData[p]);
                calibratedLightDataArray[p+1] = Math.max(0, calibratedLightDataArray[p+1] - masterBiasData[p+1]);
                calibratedLightDataArray[p+2] = Math.max(0, calibratedLightDataArray[p+2] - masterBiasData[p+2]);
            }
            logCalibrationMsg += "B"; 
          }
          if (masterDarkData) { 
            for (let p = 0; p < calibratedLightDataArray.length; p += 4) {
                calibratedLightDataArray[p] = Math.max(0, calibratedLightDataArray[p] - masterDarkData[p]);
                calibratedLightDataArray[p+1] = Math.max(0, calibratedLightDataArray[p+1] - masterDarkData[p+1]);
                calibratedLightDataArray[p+2] = Math.max(0, calibratedLightDataArray[p+2] - masterDarkData[p+2]);
            }
            logCalibrationMsg += "D";
          }
          if (masterFlatData) { 
            const avgFlatIntensityR = calculateMean(Array.from(masterFlatData).filter((_, idx) => idx % 4 === 0));
            const avgFlatIntensityG = calculateMean(Array.from(masterFlatData).filter((_, idx) => idx % 4 === 1));
            const avgFlatIntensityB = calculateMean(Array.from(masterFlatData).filter((_, idx) => idx % 4 === 2));

            for (let p = 0; p < calibratedLightDataArray.length; p += 4) {
                const flatR = Math.max(1, masterFlatData[p]);
                const flatG = Math.max(1, masterFlatData[p+1]);
                const flatB = Math.max(1, masterFlatData[p+2]);

                calibratedLightDataArray[p] = Math.min(255, (calibratedLightDataArray[p] * avgFlatIntensityR) / flatR);
                calibratedLightDataArray[p+1] = Math.min(255, (calibratedLightDataArray[p+1] * avgFlatIntensityG) / flatG);
                calibratedLightDataArray[p+2] = Math.min(255, (calibratedLightDataArray[p+2] * avgFlatIntensityB) / flatB);
            }
            logCalibrationMsg += "F";
          }
          if (logCalibrationMsg && i === 0 && yBandStart === 0) addLog(`[CALIBRATE] Img 0 (${currentImageEntry.file.name}): ${logCalibrationMsg.split("").join(", ")} applied.`);
          
          currentImageCtx.putImageData(new ImageData(calibratedLightDataArray, targetWidth, targetHeight), 0,0); 


          let useAffineTransform = false;
          let estimatedMatrix: number[][] | null = null;

          if (referenceStarsForAffine.length >= MIN_STARS_FOR_AFFINE_ALIGNMENT &&
              currentImageEntry.isAnalyzed && currentImageEntry.analysisStars &&
              currentImageEntry.analysisStars.length >= MIN_STARS_FOR_AFFINE_ALIGNMENT) {
              
              const goodFWHMCurrentStars = currentImageEntry.analysisStars
                  .filter(s => s.fwhm !== undefined && s.fwhm >= ALIGNMENT_STAR_MIN_FWHM && s.fwhm <= ALIGNMENT_STAR_MAX_FWHM)
                  .sort((a,b) => b.brightness - a.brightness)
                  .slice(0, NUM_STARS_TO_USE_FOR_AFFINE_MATCHING);

              if (yBandStart === 0) addLog(`[AFFINE CURR PREP] Img ${i} (${currentImageEntry.file.name}): Total analysis stars: ${currentImageEntry.analysisStars.length}. After FWHM filter: ${goodFWHMCurrentStars.length} stars.`);
              
              const currentStarsForAffinePoints = goodFWHMCurrentStars.map(s => {
                  if (yBandStart === 0 && i !== firstValidImageIndexInOriginal && goodFWHMCurrentStars.length >= MIN_STARS_FOR_AFFINE_ALIGNMENT) addLog(`  [AFFINE CURR STAR] Using: x=${s.x.toFixed(2)}, y=${s.y.toFixed(2)}, fwhm=${s.fwhm?.toFixed(2)}, bright=${s.brightness.toFixed(0)}`);
                  return { x: s.x, y: s.y };
              });


              const numPointsToMatch = Math.min(referenceStarsForAffine.length, currentStarsForAffinePoints.length);

              if (numPointsToMatch >= MIN_STARS_FOR_AFFINE_ALIGNMENT) {
                  const srcPts = currentStarsForAffinePoints.slice(0, numPointsToMatch);
                  const dstPts = referenceStarsForAffine.slice(0, numPointsToMatch);

                  if (yBandStart === 0 && i !== firstValidImageIndexInOriginal) {
                    addLog(`[AFFINE ATTEMPT] For ${currentImageEntry.file.name} with ${numPointsToMatch} pairs.`);
                    addLog(`  SRC Pts (current): ${JSON.stringify(srcPts.map(p => ({x:p.x.toFixed(1), y:p.y.toFixed(1)})))}`);
                    addLog(`  DST Pts (reference): ${JSON.stringify(dstPts.map(p => ({x:p.x.toFixed(1), y:p.y.toFixed(1)})))}`);
                  }

                  try {
                      if (srcPts.some(pt => isNaN(pt.x) || isNaN(pt.y)) || dstPts.some(pt => isNaN(pt.x) || isNaN(pt.y))) {
                        addLog(`[AFFINE WARN] ${currentImageEntry.file.name} (img ${i}): NaN coordinates found in star points. Falling back.`);
                        useAffineTransform = false;
                      } else {
                        estimatedMatrix = estimateAffineTransform(srcPts, dstPts);
                        useAffineTransform = true;
                        if (yBandStart === 0 && i !== firstValidImageIndexInOriginal) {
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
              if (yBandStart === 0 && i !== firstValidImageIndexInOriginal) addLog(`[AFFINE INFO] ${currentImageEntry.file.name} (img ${i}): Conditions for affine not met (ref stars: ${referenceStarsForAffine.length}, current stars after FWHM filter: ${currentImageEntry.analysisStars?.filter(s => s.fwhm !== undefined && s.fwhm >= ALIGNMENT_STAR_MIN_FWHM && s.fwhm <= ALIGNMENT_STAR_MAX_FWHM).length || 0}). Falling back.`);
              useAffineTransform = false;
          }
          
          tempWarpedImageCtx.clearRect(0,0,targetWidth,targetHeight); 
          if (useAffineTransform && estimatedMatrix) {
              warpImage(currentImageCtx, tempWarpedImageCtx, estimatedMatrix, addLog);
          } else {
              const currentCentroid = centroids[originalEntryIndex];
              let dx = 0, dy = 0;
              if (currentCentroid && referenceCentroidForFallback) {
                  dx = referenceCentroidForFallback.x - currentCentroid.x;
                  dy = referenceCentroidForFallback.y - currentCentroid.y;
              } else {
                 if(yBandStart === 0) addLog(`[ALIGN FALLBACK WARN] ${currentImageEntry.file.name}: Centroid data missing for fallback. No translation applied.`);
              }
              tempWarpedImageCtx.drawImage(currentImageCanvas, dx, dy);
              if (yBandStart === 0 && !useAffineTransform) { 
                   addLog(`[ALIGN FALLBACK] ${currentImageEntry.file.name}: Using centroid (dx:${dx.toFixed(2)}, dy:${dy.toFixed(2)}). Affine failed or not applicable.`);
              }
          }

          try {
            const bandFrameImageData = tempWarpedImageCtx.getImageData(0, yBandStart, targetWidth, currentBandHeight);
            const bandData = bandFrameImageData.data;
            for (let j = 0; j < bandData.length; j += 4) {
              const bandPixelIndex = j / 4;
              bandPixelDataCollector[bandPixelIndex].r.push(bandData[j]);
              bandPixelDataCollector[bandPixelIndex].g.push(bandData[j + 1]);
              bandPixelDataCollector[bandPixelIndex].b.push(bandData[j + 2]);
            }
            if (yBandStart === 0) imagesContributingToBand++;
          } catch (e) {
            addLog(`[STACK ERROR] Band ${yBandStart}, Img ${i} (${currentImageEntry.file.name}): Error extracting band data: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (i % 5 === 0) await yieldToEventLoop(dynamicDelayMs);
        }
        if (yBandStart === 0) validImagesStackedCount = imagesContributingToBand;

        for (let yInBand = 0; yInBand < currentBandHeight; yInBand++) {
          for (let x = 0; x < targetWidth; x++) {
              const bandPixelIndex = yInBand * targetWidth + x;
              const finalPixelGlobalIndex = ((yBandStart + yInBand) * targetWidth + x) * 4;
              const collected = bandPixelDataCollector[bandPixelIndex];
              if (collected.r.length > 0) {
                finalImageData[finalPixelGlobalIndex]     = stackingMode === 'median' ? getMedian(collected.r) : applySigmaClip(collected.r);
                finalImageData[finalPixelGlobalIndex + 1] = stackingMode === 'median' ? getMedian(collected.g) : applySigmaClip(collected.g);
                finalImageData[finalPixelGlobalIndex + 2] = stackingMode === 'median' ? getMedian(collected.b) : applySigmaClip(collected.b);
                finalImageData[finalPixelGlobalIndex + 3] = 255;
              } else { 
                finalImageData[finalPixelGlobalIndex] = 0; finalImageData[finalPixelGlobalIndex + 1] = 0;
                finalImageData[finalPixelGlobalIndex + 2] = 0; finalImageData[finalPixelGlobalIndex + 3] = 255;
              }
          }
        }
        setProgressPercent(prev => Math.min(100, prev + bandProgressIncrement));
        if (yBandStart % (STACKING_BAND_HEIGHT * 5) === 0 || yBandStart + currentBandHeight >= targetHeight ) {
             addLog(`Processed band: rows ${yBandStart} to ${yBandStart + currentBandHeight - 1}. Progress: ${Math.round(progressPercent)}%. Yielding.`);
        }
        await yieldToEventLoop(dynamicDelayMs);
      }

      setProgressPercent(100);
      addLog(`All bands processed. Finalizing image.`);

      if (validImagesStackedCount === 0 && numValidLightImages > 0) {
        const noStackMsg = "No images could be successfully processed during band stacking (zero contribution).";
        addLog(`[ERROR] ${noStackMsg}`);
        toast({ title: "Stacking Failed", description: noStackMsg, variant: "destructive" });
        setIsProcessingStack(false);
        setProgressPercent(0);
        return;
      }

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
      } else { 
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
        setImageForPostProcessing(resultDataUrl); 
        setEditedPreviewUrl(resultDataUrl); 

        setBrightness(100);
        setExposure(0);
        setSaturation(100);
        setShowPostProcessEditor(true); 

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
    if (sourceImageForApplyMenu.dimensions.height === 0) return 0; 
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
                       (currentEditingImageIndex !== null && allImageStarData[currentEditingImageIndex]?.isAnalyzing) || 
                       isApplyingStarsFromMenu;

  const currentImageForEditing = currentEditingImageIndex !== null ? allImageStarData[currentEditingImageIndex] : null;

  const currentYear = new Date().getFullYear();

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
                      </>
                    )}

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
                ) : ( 
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
                        <Button
                          onClick={handleConfirmAndNext}
                          className="w-full bg-blue-600 hover:bg-blue-700 text-white" 
                          disabled={
                            isUiDisabled ||
                            currentEditingImageIndex === null ||
                            currentEditingImageIndex >= allImageStarData.length - 1 
                          }
                        >
                          <SkipForward className="mr-2 h-4 w-4" />
                          {t('confirmAndNext')}
                        </Button>
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
    
