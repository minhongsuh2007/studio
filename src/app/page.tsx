
"use client";

import type React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { Star as StarIcon, ListChecks, CheckCircle, RefreshCcw, Edit3, Loader2, Orbit, Trash2, CopyCheck, AlertTriangle, Wand2, ShieldOff, UploadCloud, Layers, Baseline, X, FileImage, ChevronRight, SkipForward, Brain, KeyRound, BadgeAlert, Settings, Info, FileText, TestTube2, CheckSquare, Square } from 'lucide-react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { StarAnnotationCanvas } from '@/components/astrostacker/StarAnnotationCanvas';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Switch } from '@/components/ui/switch';
import NextImage from 'next/image';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';


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
  brightness: number; // From windowSumBrightness of DetectedStarPoint
  isManuallyAdded?: boolean;
  fwhm?: number;
  contrast?: number;
}

export interface ImageStarEntry {
  id: string;
  file: File;
  previewUrl: string;
  analysisStars: Star[]; // Stars used for alignment (can be manual or auto)
  initialAutoStars: Star[]; // Stars initially detected by auto-algorithm
  analysisDimensions: { width: number; height: number };
  userReviewed: boolean; // True if user has manually edited/confirmed stars
  isAnalyzed: boolean; // True if star detection has been run
  isAnalyzing: boolean; // True if star detection is currently in progress
  starSelectionMode: StarSelectionMode;
}

interface SourceImageForApplyMenu {
  id: string;
  fileName: string;
  stars: Star[];
  dimensions: { width: number; height: number };
}

export interface LearnedStarPattern {
  id: string; // Unique ID for the pattern
  stars: Star[];
  dimensions: { width: number; height: number };
  sourceFileName: string;
  avgBrightness?: number;
  avgContrast?: number;
  avgFwhm?: number;
  timestamp: number; // When it was learned
}


type StackingMode = 'median' | 'sigmaClip';
type PreviewFitMode = 'contain' | 'cover';
type OutputFormat = 'png' | 'jpeg';

const MIN_VALID_DATA_URL_LENGTH = 100;
const STACKING_BAND_HEIGHT = 50; // Pixels per band for processing

const SIGMA_CLIP_THRESHOLD = 2.0;
const SIGMA_CLIP_ITERATIONS = 2;
const MIN_STARS_FOR_CENTROID_ALIGNMENT = 3;
const MIN_STARS_FOR_AFFINE_ALIGNMENT = 3;
const NUM_STARS_TO_USE_FOR_AFFINE_MATCHING = 5;
const AUTO_ALIGN_TARGET_STAR_COUNT = 10;


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

const ALIGNMENT_STAR_MIN_FWHM = 2.0;
const ALIGNMENT_STAR_MAX_FWHM = 4.0;

const AFFINE_MATCHING_RADIUS_PIXELS = 50;
const AFFINE_MATCHING_RADIUS_SQ = AFFINE_MATCHING_RADIUS_PIXELS * AFFINE_MATCHING_RADIUS_PIXELS;


// Star Detector Parameters
const DETECTOR_MIN_CONTRAST = 25;
const DETECTOR_MIN_BRIGHTNESS = 50;
const DETECTOR_MIN_DISTANCE = 6;
const DETECTOR_MIN_FWHM = 1.5;
const DETECTOR_MAX_FWHM = 5.0;
const DETECTOR_ANNULUS_INNER_RADIUS = 4;
const DETECTOR_ANNULUS_OUTER_RADIUS = 8;
const DETECTOR_FWHM_PROFILE_HALF_WIDTH = 5;
const DETECTOR_MARGIN = 6;
const DETECTOR_FLATNESS_TOLERANCE = 2;
const LEARNING_MODE_PIN = '20077002';
const LEARN_TEST_MAX_STARS_TO_SHOW = 20; // Max stars to highlight in Learn Test


type DetectedStarPoint = { x: number; y: number; value: number; windowSumBrightness: number; contrast: number; fwhm: number };


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


function getGrayscaleArrayFromCanvas(ctx: CanvasRenderingContext2D, addLog?: (message: string) => void): number[][] {
  const { width, height } = ctx.canvas;
  if (width === 0 || height === 0) {
    if (addLog) addLog(`[DETECTOR CANVAS ERROR] Canvas dimensions are ${width}x${height}. Cannot extract grayscale data.`);
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

function calculateWindowSumBrightness(
  grayscaleImage: number[][],
  centerX: number,
  centerY: number,
  radius: number = 1 // For a 3x3 window, radius is 1
): number {
  let sumBrightness = 0;
  const height = grayscaleImage.length;
  const width = grayscaleImage[0]?.length || 0;
  const intX = Math.round(centerX);
  const intY = Math.round(centerY);

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const y = intY + dy;
      const x = intX + dx;
      if (y >= 0 && y < height && x >= 0 && x < width && grayscaleImage[y]?.[x] !== undefined) {
        sumBrightness += grayscaleImage[y][x];
      }
    }
  }
  return sumBrightness;
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
    if (addLog) addLog("[DETECTOR BG ERROR] Empty image or row for background estimation.");
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

  if (imageWidth === 0 || imageHeight === 0 || y < 0 || y >= imageHeight || !image[y]) {
    if (addLog) addLog(`[FWHM EST ERROR] Invalid image or y-coordinate for FWHM estimation at (${x},${y}). Image dims: ${imageWidth}x${imageHeight}, y=${y}`);
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
    if (addLog) addLog(`[FWHM EST ERROR] Profile array is empty at (${x},${y}).`);
    return 0;
  }

  const peak = Math.max(...profile);
  if (peak === 0) {
     if (addLog && Math.random() < 0.01) addLog(`[FWHM EST WARN] Peak value in profile is 0 at (${x},${y}). Profile: ${profile.map(p=>p.toFixed(1)).join(',')}`);
     return 0;
  }
  const halfMax = peak / 2;

  let left = -1, right = -1;

  for (let i = 0; i < profile.length - 1; i++) {
      if (profile[i] >= halfMax && profile[i + 1] < halfMax) {
          left = i + (profile[i] - halfMax) / (profile[i] - profile[i + 1]);
          break;
      }
  }
  if (left === -1 && profile[0] >= halfMax && profile.length > 1 && profile[0] > profile[1]) {
      left = 0;
  }


  for (let i = profile.length - 1; i > 0; i--) {
      if (profile[i] >= halfMax && profile[i - 1] < halfMax) {
          right = i - (profile[i] - halfMax) / (profile[i] - profile[i - 1]);
          break;
      }
  }
   if (right === -1 && profile[profile.length - 1] >= halfMax && profile.length > 1 && profile[profile.length - 1] > profile[profile.length - 2]) {
      right = profile.length - 1;
  }


  const fwhm = (left !== -1 && right !== -1 && right > left) ? Math.abs(right - left) : 0;

  const logLevelThreshold = DETECTOR_MIN_BRIGHTNESS * 1.2;
  if (addLog && peak > logLevelThreshold && Math.random() < 0.02) {
    if (fwhm > 0) {
      addLog(`[FWHM EST] At (${x},${y}): Peak=${peak.toFixed(1)}, HM=${halfMax.toFixed(1)}, L=${left.toFixed(2)}, R=${right.toFixed(2)}, FWHM=${fwhm.toFixed(2)}`);
    } else {
      addLog(`[FWHM EST WARN] At (${x},${y}): FWHM is 0. Peak=${peak.toFixed(1)}, L=${left.toFixed(1)}, R=${right.toFixed(1)}. Profile: ${profile.map(p=>p.toFixed(0)).join(',')}`);
    }
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
  let loggedFwhmSortInfo = false;

  if (height === 0 || width === 0) {
    addLog("[DETECTOR ERROR] Input grayscale image is empty. Cannot detect stars.");
    return [];
  }
  addLog(`[DETECTOR] Starting detection on ${width}x${height} grayscale. Config: MinContrast=${DETECTOR_MIN_CONTRAST}, MinBright(CenterPx)=${DETECTOR_MIN_BRIGHTNESS}, (No MaxStars limit), MinDist=${DETECTOR_MIN_DISTANCE}, MinFWHM=${DETECTOR_MIN_FWHM}, MaxFWHM=${DETECTOR_MAX_FWHM}, Margin=${DETECTOR_MARGIN}, FlatTol=${DETECTOR_FLATNESS_TOLERANCE}`);

  const candidates: DetectedStarPoint[] = [];
  let consideredPixels = 0;
  let passedMinBrightness = 0;
  let passedContrast = 0;
  let passedFWHMCount = 0;
  let passedFlatnessAndLocalMax = 0;

  for (let y = DETECTOR_MARGIN; y < height - DETECTOR_MARGIN; y++) {
    for (let x = DETECTOR_MARGIN; x < width - DETECTOR_MARGIN; x++) {
      consideredPixels++;
      const value = grayscaleImage[y][x];

      if (value < DETECTOR_MIN_BRIGHTNESS) {
        continue;
      }
      passedMinBrightness++;

      const contrast = getLocalContrast(grayscaleImage, x, y, addLog);
      if (contrast < DETECTOR_MIN_CONTRAST) {
        continue;
      }
      passedContrast++;

      const fwhm = estimateFWHM(grayscaleImage, x, y, DETECTOR_FWHM_PROFILE_HALF_WIDTH, addLog);
      if (fwhm < DETECTOR_MIN_FWHM || fwhm > DETECTOR_MAX_FWHM) {
        continue;
      }
      passedFWHMCount++;

      const neighbors = [
        grayscaleImage[y - 1][x], grayscaleImage[y + 1][x],
        grayscaleImage[y][x - 1], grayscaleImage[y][x + 1],
      ];
      const tooFlat = neighbors.every(n => Math.abs(n - value) <= DETECTOR_FLATNESS_TOLERANCE);
      if (tooFlat) {
        continue;
      }
      if (!(value > neighbors[0] && value > neighbors[1] && value > neighbors[2] && value > neighbors[3])) {
           continue;
      }
      passedFlatnessAndLocalMax++;

      let windowSumBrightness = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const curY = y + dy;
          const curX = x + dx;
          if (curY >=0 && curY < height && curX >=0 && curX < width && grayscaleImage[curY] && grayscaleImage[curY][curX] !== undefined) {
            windowSumBrightness += grayscaleImage[curY][curX];
          }
        }
      }

      candidates.push({ x, y, value, windowSumBrightness, contrast, fwhm });
    }
  }
  addLog(`[DETECTOR STATS] Considered: ${consideredPixels}, Passed MinBrightness: ${passedMinBrightness}, Contrast: ${passedContrast}, FWHM: ${passedFWHMCount}, Flatness/LocalMax: ${passedFlatnessAndLocalMax}, Initial Candidates: ${candidates.length}`);

  candidates.sort((a, b) => {
    const a_is_prime_fwhm = a.fwhm >= ALIGNMENT_STAR_MIN_FWHM && a.fwhm <= ALIGNMENT_STAR_MAX_FWHM;
    const b_is_prime_fwhm = b.fwhm >= ALIGNMENT_STAR_MIN_FWHM && b.fwhm <= ALIGNMENT_STAR_MAX_FWHM;

    if (a_is_prime_fwhm && !b_is_prime_fwhm) return -1;
    if (!a_is_prime_fwhm && b_is_prime_fwhm) return 1;

    return (b.windowSumBrightness * b.contrast) - (a.windowSumBrightness * a.contrast);
  });

  if (!loggedFwhmSortInfo && candidates.length > 0) {
      addLog(`[DETECTOR SORT] Candidates sorted. Priority to FWHM [${ALIGNMENT_STAR_MIN_FWHM}-${ALIGNMENT_STAR_MAX_FWHM}], then by (windowSumBrightness * contrast).`);
      loggedFwhmSortInfo = true;
  }

  const stars: DetectedStarPoint[] = [];
  for (const cand of candidates) {
    if (isFarEnough(stars, cand.x, cand.y, DETECTOR_MIN_DISTANCE)) {
      stars.push(cand);
    }
  }

  if (stars.length > 0) {
    const topStar = stars[0];
    addLog(`[DETECTOR] Found ${stars.length} stars after all filters. Top star ex: (${topStar?.x.toFixed(0)}, ${topStar?.y.toFixed(0)}) WinSumBr:${topStar?.windowSumBrightness.toFixed(1)} Contr:${topStar?.contrast.toFixed(1)} FWHM:${topStar?.fwhm.toFixed(1)} (CenterVal:${topStar?.value.toFixed(1)})`);
  } else {
    addLog(`[DETECTOR WARN] No stars found after all filters.`);
  }
  return stars;
}


function calculateStarArrayCentroid(starsInput: Star[], addLog: (message: string) => void): { x: number; y: number } | null {
  if (!starsInput || starsInput.length === 0) {
    addLog(`[ALIGN WARN] No stars provided for star-based centroid calculation.`);
    return null;
  }
  if (starsInput.length < MIN_STARS_FOR_CENTROID_ALIGNMENT) {
     const message = `Not enough stars (${starsInput.length}) provided for star-based centroid. Need at least ${MIN_STARS_FOR_CENTROID_ALIGNMENT}.`;
     addLog(`[ALIGN WARN] ${message}`);
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

    const isBigEndian = true; // FITS is typically big-endian, but rawPixelData will be host endian

    for (let i = 0; i < pixelCount; i++) {
      const pixelByteOffset = imageDataOffset + i * bytesPerPixel;
      try {
        if (bitpix === 8) { // Unsigned 8-bit integer
            rawPixelData[i] = dataView.getUint8(pixelByteOffset);
        } else if (bitpix === 16) { // Signed 16-bit integer
            rawPixelData[i] = dataView.getInt16(pixelByteOffset, !isBigEndian); // Adjust for host endianness if needed
        } else if (bitpix === 32) { // Signed 32-bit integer
            rawPixelData[i] = dataView.getInt32(pixelByteOffset, !isBigEndian);
        } else if (bitpix === -32) { // 32-bit floating point (IEEE 754 single precision)
            rawPixelData[i] = dataView.getFloat32(pixelByteOffset, !isBigEndian);
        } else if (bitpix === -64) { // 64-bit floating point (IEEE 754 double precision)
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
  const [currentEditingGrayscaleData, setCurrentEditingGrayscaleData] = useState<number[][] | null>(null);


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

  const [showLearnPinDialog, setShowLearnPinDialog] = useState(false);
  const [learnPinInput, setLearnPinInput] = useState("");
  const [isLearningModeActive, setIsLearningModeActive] = useState(false);

  const [allLearnedPatterns, setAllLearnedPatterns] = useState<LearnedStarPattern[]>([]);
  const [selectedLearnedPatternIds, setSelectedLearnedPatternIds] = useState<string[]>([]);


  // Learn Test State
  const [testImageFile, setTestImageFile] = useState<File | null>(null);
  const [testImagePreviewUrl, setTestImagePreviewUrl] = useState<string | null>(null);
  const [testImageAnalysisDimensions, setTestImageAnalysisDimensions] = useState<{width: number; height: number} | null>(null);
  const [testImageDetectedStars, setTestImageDetectedStars] = useState<Star[]>([]);
  const [isAnalyzingTestImage, setIsAnalyzingTestImage] = useState(false);


  const addLog = useCallback((message: string) => {
    setLogs(prevLogs => {
      const newLog = {
        id: logIdCounter.current++,
        timestamp: new Date().toLocaleTimeString(),
        message
      };
      return [newLog, ...prevLogs].slice(0, 100);
    });
  }, []);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = 0;
    }
  }, [logs]);

  useEffect(() => {
    try {
      const storedPatternsString = localStorage.getItem('astrostacker-learned-patterns-list');
      if (storedPatternsString) {
        const storedPatterns = JSON.parse(storedPatternsString) as LearnedStarPattern[];
        if (Array.isArray(storedPatterns)) {
          setAllLearnedPatterns(storedPatterns);
          addLog(`[LEARN] Loaded ${storedPatterns.length} learned pattern(s) from localStorage.`);
        }
      }

      const storedSelectedPatternIdsString = localStorage.getItem('astrostacker-selected-pattern-ids');
      if (storedSelectedPatternIdsString) {
        const storedIds = JSON.parse(storedSelectedPatternIdsString) as string[];
        if(Array.isArray(storedIds)) {
            setSelectedLearnedPatternIds(storedIds);
            addLog(`[LEARN] Loaded ${storedIds.length} selected pattern ID(s) from localStorage.`);
        }
      }

      const storedLearningModeActive = localStorage.getItem('astrostacker-learning-mode-active');
      if (storedLearningModeActive === 'true') {
         setIsLearningModeActive(true);
         addLog("[LEARN] Learning Mode status restored as ACTIVE from localStorage.");
      }
    } catch (error) {
      console.error("Error loading data from localStorage:", error);
      addLog("[ERROR] Could not load learning data from localStorage. Clearing potentially corrupted data.");
      localStorage.removeItem('astrostacker-learned-patterns-list');
      localStorage.removeItem('astrostacker-selected-pattern-ids');
      localStorage.removeItem('astrostacker-learning-mode-active');
    }
  }, [addLog]);


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

    const rawFileExtensions = ['.dng', '.cr2', '.cr3', '.crw', '.arw', '.nef', '.orf', '.raf', '.pef', '.srw', '.rw2'];

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
        } else if (rawFileExtensions.some(ext => fileName.endsWith(ext))) {
            addLog(`[RAW UNAVAILABLE] RAW file ${file.name} detected, but the 'libraw-js' library (or its alternative) could not be installed/initialized. RAW processing is disabled.`);
            toast({
                title: "RAW Processing Unavailable",
                description: `The library required for RAW file ${file.name} (e.g. DNG, CR2) is currently not working due to installation issues. Please convert to JPG/PNG first or try again later.`,
                variant: "destructive",
                duration: 10000,
            });
            return null;
        } else if (acceptedWebTypes.includes(fileType)) {
            originalPreviewUrl = await fileToDataURL(file);
        } else {
            const unsupportedMsg = `${file.name} is unsupported. Use JPG, PNG, GIF, WEBP, FITS. RAW processing is currently facing issues.`;
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
                const errorMessage = `Could not load generated preview image ${file.name} to check dimensions. This can happen if the data URL is invalid or too large. RAW/FITS files may produce large data URLs.`;
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
    const rawFileExtensions = ['.dng', '.cr2', '.cr3', '.crw', '.arw', '.nef', '.orf', '.raf', '.pef', '.srw', '.rw2'];

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
        } else if (rawFileExtensions.some(ext => fileName.endsWith(ext))) {
            addLog(`[RAW CALIB. UNAVAILABLE] RAW ${frameTypeName} frame ${file.name} detected, but the RAW processing library could not be installed/initialized.`);
            toast({
                title: `RAW ${frameTypeName} Frame Unavailable`,
                description: `Cannot process RAW ${frameTypeName} ${file.name} as its library failed to install. Please convert to JPG/PNG first.`,
                variant: "destructive",
                duration: 8000,
            });
            continue;
        } else if (!acceptedWebTypes.includes(fileType)) {
          addLog(`[ERROR] Unsupported ${frameTypeName} frame ${file.name}. Use JPG, PNG, GIF, WEBP, FITS. RAW processing currently unavailable.`);
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
    const fileNameForLog = entry?.file?.name || `image with id ${idToRemove}`;
    setAllImageStarData(prev => prev.filter(item => item.id !== idToRemove));
    addLog(`Removed ${fileNameForLog} from queue.`);
  };

  const handleRemoveCalibrationFrame = (
    indexToRemove: number,
    frameType: 'dark' | 'flat' | 'bias',
    filesStateFunction: () => File[],
    setFilesState: React.Dispatch<React.SetStateAction<File[]>>,
    setPreviewUrlsState: React.Dispatch<React.SetStateAction<string[]>>,
    setOriginalDimensionsListState: React.Dispatch<React.SetStateAction<Array<{ width: number; height: number } | null>>>
  ) => {
    const currentFiles = filesStateFunction();
    let fileNameForLog = `frame at index ${indexToRemove}`;
    if (indexToRemove >= 0 && indexToRemove < currentFiles.length && currentFiles[indexToRemove]) {
      fileNameForLog = currentFiles[indexToRemove].name;
    }

    addLog(`Removing ${frameType} frame: ${fileNameForLog} (index ${indexToRemove})`);

    setFilesState(prev => prev.filter((_, index) => index !== indexToRemove));
    setPreviewUrlsState(prev => prev.filter((_, index) => index !== indexToRemove));
    setOriginalDimensionsListState(prev => prev.filter((_, index) => index !== indexToRemove));
  };

  const handleRemoveDarkFrame = (index: number) => handleRemoveCalibrationFrame(index, 'dark', () => darkFrameFiles, setDarkFrameFiles, setDarkFramePreviewUrls, setOriginalDarkFrameDimensionsList);
  const handleRemoveFlatFrame = (index: number) => handleRemoveCalibrationFrame(index, 'flat', () => flatFrameFiles, setFlatFrameFiles, setFlatFramePreviewUrls, setOriginalFlatFrameDimensionsList);
  const handleRemoveBiasFrame = (index: number) => handleRemoveCalibrationFrame(index, 'bias', () => biasFrameFiles, setBiasFrameFiles, setBiasFramePreviewUrls, setOriginalBiasFrameDimensionsList);


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


const analyzeImageForStars = async (
  entryToAnalyze: ImageStarEntry,
  localAddLog: (message: string) => void
): Promise<ImageStarEntry> => {
  setAllImageStarData(prevData =>
    prevData.map(e =>
      e.id === entryToAnalyze.id
        ? { ...e, isAnalyzing: true, isAnalyzed: false }
        : e
    )
  );

  let finalUpdatedEntry: ImageStarEntry = {
    ...entryToAnalyze,
    isAnalyzing: true,
    isAnalyzed: false,
    analysisStars: [],
    initialAutoStars: [],
  };

  try {
    localAddLog(`[ANALYZE START] For: ${entryToAnalyze.file.name} (ID: ${entryToAnalyze.id})`);

    if (!finalUpdatedEntry.analysisDimensions || finalUpdatedEntry.analysisDimensions.width === 0 || finalUpdatedEntry.analysisDimensions.height === 0) {
      throw new Error(`Analysis dimensions for ${entryToAnalyze.file.name} are invalid or zero (${finalUpdatedEntry.analysisDimensions?.width}x${finalUpdatedEntry.analysisDimensions?.height}). Cannot proceed.`);
    }

    const imgEl = await loadImage(finalUpdatedEntry.previewUrl, finalUpdatedEntry.file.name);
    const analysisWidth = finalUpdatedEntry.analysisDimensions.width;
    const analysisHeight = finalUpdatedEntry.analysisDimensions.height;

    const tempAnalysisCanvas = document.createElement('canvas');
    const tempAnalysisCtx = tempAnalysisCanvas.getContext('2d', { willReadFrequently: true });
    if (!tempAnalysisCtx) {
      throw new Error("Could not get analysis canvas context.");
    }

    tempAnalysisCanvas.width = analysisWidth;
    tempAnalysisCanvas.height = analysisHeight;
    tempAnalysisCtx.drawImage(imgEl, 0, 0, analysisWidth, analysisHeight);
    localAddLog(`[ANALYZE CANVAS PREPARED] For ${entryToAnalyze.file.name} at ${analysisWidth}x${analysisHeight}.`);

    const grayscaleImageArray = getGrayscaleArrayFromCanvas(tempAnalysisCtx, localAddLog);
    if (grayscaleImageArray.length === 0 || grayscaleImageArray[0]?.length === 0) {
        throw new Error("[ANALYZE DETECT FAIL] Failed to convert canvas to valid grayscale array for star detection.");
    }

    const detectedPoints: DetectedStarPoint[] = detectStarsWithNewPipeline(grayscaleImageArray, localAddLog);
    localAddLog(`[ANALYZE DETECTED] ${detectedPoints.length} potential star points in ${entryToAnalyze.file.name}.`);

    const detectedStarsResult: Star[] = detectedPoints.map(pStar => ({
      x: pStar.x,
      y: pStar.y,
      brightness: pStar.windowSumBrightness, // This is the correct brightness source
      fwhm: pStar.fwhm,
      contrast: pStar.contrast,
      isManuallyAdded: false,
    }));

    finalUpdatedEntry.initialAutoStars = [...detectedStarsResult];
    if (finalUpdatedEntry.starSelectionMode === 'auto') {
      finalUpdatedEntry.analysisStars = [...detectedStarsResult];
    } else {
       if(!finalUpdatedEntry.analysisStars || finalUpdatedEntry.analysisStars.filter(s => s.isManuallyAdded).length === 0){
           finalUpdatedEntry.analysisStars = [...detectedStarsResult];
       } else {
           // Keep manually added stars if they exist, otherwise populate with auto if it's empty from a previous manual wipe
           finalUpdatedEntry.analysisStars = [...finalUpdatedEntry.analysisStars.filter(s => s.isManuallyAdded)];
       }
    }

    localAddLog(`[ANALYZE SUCCESS] For ${entryToAnalyze.file.name}. InitialAutoStars: ${finalUpdatedEntry.initialAutoStars.length}, AnalysisStars (mode dependent): ${finalUpdatedEntry.analysisStars.length}.`);
    finalUpdatedEntry.isAnalyzed = true;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    localAddLog(`[ANALYSIS ERROR CAUGHT] For ${entryToAnalyze.file.name}: ${errorMessage}`);
    toast({ title: `Analysis Failed for ${entryToAnalyze.file.name}`, description: errorMessage, variant: "destructive" });
    finalUpdatedEntry.analysisStars = [];
    finalUpdatedEntry.initialAutoStars = [];
    finalUpdatedEntry.isAnalyzed = false;
  } finally {
    finalUpdatedEntry.isAnalyzing = false;

    setAllImageStarData(prevData =>
      prevData.map(e => (e.id === finalUpdatedEntry.id ? { ...finalUpdatedEntry } : e))
    );
    localAddLog(`[ANALYZE FINAL STATE UPDATE] For ${finalUpdatedEntry.file.name}: isAnalyzed=${finalUpdatedEntry.isAnalyzed}, isAnalyzing=${finalUpdatedEntry.isAnalyzing}, AutoStars=${finalUpdatedEntry.initialAutoStars.length}, AnalysisStars=${finalUpdatedEntry.analysisStars.length}`);
  }

  return finalUpdatedEntry;
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
      // When switching to auto, always use the initial auto-detected stars
      updatedEntry.analysisStars = [...updatedEntry.initialAutoStars];
      setAllImageStarData(prev => prev.map(e => e.id === imageId ? updatedEntry : e));
    } else {
        // When switching to manual:
        // If there are no manually added stars OR no auto stars to begin with, keep current analysis stars (which might be empty or previous manual)
        // If initial auto stars exist and there are no specific manual stars set, populate analysisStars with initialAuto for editing.
        if (updatedEntry.initialAutoStars.length > 0 && updatedEntry.analysisStars.filter(s => s.isManuallyAdded).length === 0) {
           updatedEntry.analysisStars = [...updatedEntry.initialAutoStars];
        }
        // else, keep the existing analysisStars (which could be prior manual edits or already populated auto stars)
        setAllImageStarData(prev => prev.map(e => e.id === imageId ? updatedEntry : e));

        // Trigger analysis if not already analyzed, as manual mode implies user might want to edit
        setTimeout(async () => {
            const currentGlobalStateEntry = allImageStarData.find(e => e.id === imageId);
            if (currentGlobalStateEntry && !currentGlobalStateEntry.isAnalyzed && !currentGlobalStateEntry.isAnalyzing) {
                addLog(`Image ${currentGlobalStateEntry.file.name} switched to manual mode, and needs analysis. Analyzing now...`);
                await analyzeImageForStars(currentGlobalStateEntry, addLog);
            }
        }, 0);
    }
  };

  const handleEditStarsRequest = async (imageIndex: number) => {
    const currentEntryFromState = allImageStarData[imageIndex];
    if (!currentEntryFromState) return;

    setCurrentEditingImageData(null);
    setCurrentEditingGrayscaleData(null);


    let entryForEditing = { ...currentEntryFromState };

    if (entryForEditing.starSelectionMode === 'auto' ||
        (entryForEditing.starSelectionMode === 'manual' && !entryForEditing.userReviewed && entryForEditing.analysisStars.length === 0 && entryForEditing.initialAutoStars.length > 0)) {

        const updatedFields: Partial<ImageStarEntry> = { starSelectionMode: 'manual', userReviewed: false };
        if (entryForEditing.initialAutoStars.length > 0 && entryForEditing.analysisStars.length === 0) {
            updatedFields.analysisStars = [...entryForEditing.initialAutoStars];
            addLog(`Preparing ${entryForEditing.file.name} for manual editing. Mode set to manual. Populated with auto-stars.`);
        } else {
            addLog(`Preparing ${entryForEditing.file.name} for manual editing. Mode set to manual.`);
        }

        entryForEditing = { ...entryForEditing, ...updatedFields };
        setAllImageStarData(prev => prev.map((e, idx) => idx === imageIndex ? entryForEditing : e));
    }


    if (!entryForEditing.isAnalyzed && !entryForEditing.isAnalyzing) {
        addLog(`Analyzing ${entryForEditing.file.name} before editing stars (was not analyzed).`);
        entryForEditing = await analyzeImageForStars(entryForEditing, addLog);
        if (entryForEditing.analysisStars.length === 0) {
             toast({ title: "Analysis Note", description: `Analysis for ${entryForEditing.file.name} found 0 stars. You can add them manually.`, variant: "default" });
        }
    } else if (entryForEditing.isAnalyzing) {
        toast({ title: "Analysis in Progress", description: `Still analyzing ${entryForEditing.file.name}. Please wait.` });
        return;
    }

    const finalEntryForEditing = allImageStarData.find(e => e.id === entryForEditing.id) || entryForEditing;

    if (finalEntryForEditing && finalEntryForEditing.isAnalyzed && finalEntryForEditing.analysisDimensions && finalEntryForEditing.analysisDimensions.width > 0) {
        let starsToEdit = [...finalEntryForEditing.analysisStars];
        if (starsToEdit.length === 0 && finalEntryForEditing.initialAutoStars.length > 0 && finalEntryForEditing.starSelectionMode === 'manual') {
            starsToEdit = [...finalEntryForEditing.initialAutoStars];
            addLog(`Populating editor for ${finalEntryForEditing.file.name} with ${starsToEdit.length} auto-detected stars as a base for manual editing (analysis stars were empty).`);
            const updatedEntryWithAutoStars = { ...finalEntryForEditing, analysisStars: starsToEdit };
            setAllImageStarData(prev => prev.map((e, idx) =>
                idx === imageIndex ? updatedEntryWithAutoStars : e
            ));
            entryForEditing = updatedEntryWithAutoStars;
        }

        const imgToEdit = new Image();
        imgToEdit.onload = () => {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = entryForEditing.analysisDimensions.width;
            tempCanvas.height = entryForEditing.analysisDimensions.height;
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
            if (tempCtx) {
                tempCtx.drawImage(imgToEdit, 0, 0, tempCanvas.width, tempCanvas.height);
                setCurrentEditingImageData(tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height));
                setCurrentEditingGrayscaleData(getGrayscaleArrayFromCanvas(tempCtx, addLog));
                addLog(`Loaded ImageData & Grayscale (${tempCanvas.width}x${tempCanvas.height}) for ${entryForEditing.file.name} for precise star editing.`);
            } else {
                setCurrentEditingImageData(null);
                setCurrentEditingGrayscaleData(null);
                addLog(`[WARN] Could not get canvas context to load ImageData/Grayscale for ${entryForEditing.file.name}. Precise click refinement & property estimation disabled.`);
                toast({title: "Warning", description: `Could not prepare image data for ${entryForEditing.file.name}. Star property estimation disabled.`});
            }
            setCurrentEditingImageIndex(imageIndex);
            setIsStarEditingMode(true);
            addLog(`Opened star editor for ${entryForEditing.file.name}. Mode: Manual. Initial stars for edit: ${entryForEditing.analysisStars.length}. Dim: ${entryForEditing.analysisDimensions.width}x${entryForEditing.analysisDimensions.height}`);
        };
        imgToEdit.onerror = () => {
            setCurrentEditingImageData(null);
            setCurrentEditingGrayscaleData(null);
            addLog(`[ERROR] Failed to load image ${entryForEditing.file.name} for ImageData preparation for editor.`);
            toast({title: "Editor Error", description: `Could not load image ${entryForEditing.file.name} for editing stars.`, variant: "destructive"});
            setIsStarEditingMode(false);
        };
        imgToEdit.src = entryForEditing.previewUrl;

    } else {
       console.warn(`Cannot edit stars for ${finalEntryForEditing?.file?.name || 'image'}: Analysis data (isAnalyzed=${finalEntryForEditing?.isAnalyzed}), dimension data (${finalEntryForEditing?.analysisDimensions?.width}x${finalEntryForEditing?.analysisDimensions?.height}), or preview URL might be incomplete or loading failed.`);
       toast({title: "Error", description: `Could not prepare ${finalEntryForEditing?.file?.name || 'image'} for star editing. Analysis data may be missing or invalid.`, variant: "destructive"});
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
      const cropRectWidth = Math.min(currentEditingImageData.width - cropRectX, searchRadius * 2);
      const cropRectHeight = Math.min(currentEditingImageData.height - cropRectY, searchRadius * 2);

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
          let estimatedBrightness = 150;
          let estimatedContrast = 50;
          let estimatedFWHM = 2.5;

          if (currentEditingGrayscaleData && finalStarX >= 0 && finalStarY >= 0 && finalStarX < entry.analysisDimensions.width && finalStarY < entry.analysisDimensions.height) {
             const tempBrightness = calculateWindowSumBrightness(currentEditingGrayscaleData, finalStarX, finalStarY);
             const tempContrast = getLocalContrast(currentEditingGrayscaleData, Math.round(finalStarX), Math.round(finalStarY), addLog);
             const tempFWHM = estimateFWHM(currentEditingGrayscaleData, Math.round(finalStarX), Math.round(finalStarY), DETECTOR_FWHM_PROFILE_HALF_WIDTH, addLog);

             if (tempBrightness > 0) estimatedBrightness = tempBrightness;
             if (tempContrast > 0) estimatedContrast = tempContrast; // Contrast can be negative, but we're interested in magnitude of difference or positive contrast for stars
             if (tempFWHM > 0) estimatedFWHM = tempFWHM;
             addLog(`Estimated props for manual star at (${finalStarX.toFixed(0)}, ${finalStarY.toFixed(0)}): Br=${estimatedBrightness.toFixed(1)}, Co=${estimatedContrast.toFixed(1)}, Fw=${estimatedFWHM.toFixed(1)}`);
          } else {
             addLog(`Manual star at (${finalStarX.toFixed(0)}, ${finalStarY.toFixed(0)}) using default props (no grayscale data or out of bounds).`);
          }

          const newStar: Star = {
            x: finalStarX,
            y: finalStarY,
            brightness: estimatedBrightness,
            contrast: estimatedContrast,
            fwhm: estimatedFWHM,
            isManuallyAdded: true,
          };
          updatedStars.push(newStar);
          addLog(`Added manual star with estimated props to ${item.file.name}. Total stars: ${updatedStars.length}`);
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

    if (isLearningModeActive && confirmedEntry.analysisStars.length > 0) {
      const brightnessValues = confirmedEntry.analysisStars.map(s => s.brightness);
      const contrastValues = confirmedEntry.analysisStars.filter(s => s.contrast !== undefined).map(s => s.contrast!);
      const fwhmValues = confirmedEntry.analysisStars.filter(s => s.fwhm !== undefined).map(s => s.fwhm!);
      
      const characteristics = {
        avgBrightness: calculateMean(brightnessValues),
        avgContrast: contrastValues.length > 0 ? calculateMean(contrastValues) : undefined,
        avgFwhm: fwhmValues.length > 0 ? calculateMean(fwhmValues) : undefined,
      };
      addLog(`[LEARN CALC] For ${confirmedEntry.file.name}: Raw Brightness(${brightnessValues.length} vals): ${brightnessValues.map(v=>v.toFixed(0)).join(',')}. Raw Contrast(${contrastValues.length} vals): ${contrastValues.map(v=>v.toFixed(0)).join(',')}. Raw FWHM(${fwhmValues.length} vals): ${fwhmValues.map(v=>v.toFixed(1)).join(',')}`);


      const newPatternId = `${Date.now()}-${confirmedEntry.file.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const newLearnedPattern: LearnedStarPattern = {
        id: newPatternId,
        stars: [...confirmedEntry.analysisStars], 
        dimensions: { ...confirmedEntry.analysisDimensions },
        sourceFileName: confirmedEntry.file.name,
        timestamp: Date.now(),
        ...characteristics,
      };

      let patternUpdated = false;
      const updatedPatterns = allLearnedPatterns.map(p => {
        if (p.sourceFileName === newLearnedPattern.sourceFileName) { 
          patternUpdated = true;
          addLog(`[LEARN] Updating existing pattern for source file: ${p.sourceFileName} with new ID ${newLearnedPattern.id}. Old ID was ${p.id}. New characteristics learned.`);
          return { ...newLearnedPattern, id: p.id }; 
        }
        return p;
      });

      if (!patternUpdated) {
        updatedPatterns.push(newLearnedPattern);
         addLog(`[LEARN] New pattern created: ${newLearnedPattern.sourceFileName} (ID: ${newLearnedPattern.id}). Characteristics learned.`);
      }

      setAllLearnedPatterns(updatedPatterns);

      try {
        localStorage.setItem('astrostacker-learned-patterns-list', JSON.stringify(updatedPatterns));
        localStorage.setItem('astrostacker-learning-mode-active', 'true'); 
        addLog("[LEARN] Saved/Updated learned patterns list and active learning mode status to localStorage.");
      } catch (error) {
        console.error("Error saving learned pattern to localStorage:", error);
        addLog("[ERROR] Could not save learned pattern to localStorage.");
      }

      const toastTitleKey = patternUpdated ? 'starPatternOverwrittenToastTitle' : 'starPatternFirstLearnedToastTitle';
      const toastDescKey = patternUpdated ? 'starPatternOverwrittenToastDesc' : 'starPatternFirstLearnedToastDesc';

      toast({
        title: t(toastTitleKey),
        description: t(toastDescKey, {
            fileName: confirmedEntry.file.name,
            starCount: newLearnedPattern.stars.length,
            avgBrightness: characteristics.avgBrightness?.toFixed(1),
            avgContrast: characteristics.avgContrast?.toFixed(1),
            avgFwhm: characteristics.avgFwhm?.toFixed(1),
        }),
      });
      addLog(`[LEARN] ${patternUpdated ? 'Updated' : 'New'} pattern & characteristics learned from ${confirmedEntry.file.name}. AvgBr: ${characteristics.avgBrightness?.toFixed(1)}, AvgCo: ${characteristics.avgContrast?.toFixed(1)}, AvgFw: ${characteristics.avgFwhm?.toFixed(1)}`);
      setIsStarEditingMode(false);
      setCurrentEditingImageData(null);
      setCurrentEditingGrayscaleData(null);
      setCurrentEditingImageIndex(null);
    } else {
      toast({title: "Stars Confirmed", description: `Star selection saved for ${currentImageName}.`});
      if (allImageStarData.length > 1 && confirmedEntry.analysisStars && confirmedEntry.analysisDimensions && !isLearningModeActive) {
        setSourceImageForApplyMenu({
          id: confirmedEntry.id,
          fileName: confirmedEntry.file.name,
          stars: [...confirmedEntry.analysisStars],
          dimensions: { ...confirmedEntry.analysisDimensions },
        });
        setShowApplyStarOptionsMenu(true);
      } else {
        setIsStarEditingMode(false);
        setCurrentEditingImageData(null);
        setCurrentEditingGrayscaleData(null);
        setCurrentEditingImageIndex(null);
      }
    }
  };

  const handleConfirmAndNext = async () => {
    if (currentEditingImageIndex === null) return;

    const currentImageEntry = allImageStarData[currentEditingImageIndex];
    if (!currentImageEntry) return;

    const currentImageName = currentImageEntry.file.name || "current image";
    addLog(`Confirmed star selection for ${currentImageName}. Total stars: ${currentImageEntry.analysisStars.length}. Mode: Manual.`);

    setAllImageStarData(prev => prev.map((entry, idx) =>
      idx === currentEditingImageIndex ? { ...entry, userReviewed: true, starSelectionMode: 'manual' } : entry
    ));

    let patternJustLearnedOrOverwritten = false;
    if (isLearningModeActive && currentImageEntry.analysisStars.length > 0) {
      const brightnessValues = currentImageEntry.analysisStars.map(s => s.brightness);
      const contrastValues = currentImageEntry.analysisStars.filter(s => s.contrast !== undefined).map(s => s.contrast!);
      const fwhmValues = currentImageEntry.analysisStars.filter(s => s.fwhm !== undefined).map(s => s.fwhm!);

      const characteristics = {
        avgBrightness: calculateMean(brightnessValues),
        avgContrast: contrastValues.length > 0 ? calculateMean(contrastValues) : undefined,
        avgFwhm: fwhmValues.length > 0 ? calculateMean(fwhmValues) : undefined,
      };
       addLog(`[LEARN CALC C&N] For ${currentImageEntry.file.name}: Raw Brightness(${brightnessValues.length} vals): ${brightnessValues.map(v=>v.toFixed(0)).join(',')}. Raw Contrast(${contrastValues.length} vals): ${contrastValues.map(v=>v.toFixed(0)).join(',')}. Raw FWHM(${fwhmValues.length} vals): ${fwhmValues.map(v=>v.toFixed(1)).join(',')}`);


      const newPatternId = `${Date.now()}-${currentImageEntry.file.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const newLearnedPattern : LearnedStarPattern = {
        id: newPatternId,
        stars: [...currentImageEntry.analysisStars],
        dimensions: { ...currentImageEntry.analysisDimensions },
        sourceFileName: currentImageEntry.file.name,
        timestamp: Date.now(),
        ...characteristics,
      };

      let patternUpdated = false;
      const updatedPatterns = allLearnedPatterns.map(p => {
        if (p.sourceFileName === newLearnedPattern.sourceFileName) {
          patternUpdated = true;
           addLog(`[LEARN] Confirm&Next: Updating existing pattern for source file: ${p.sourceFileName}. New ID ${newLearnedPattern.id}. Old ID was ${p.id}. New characteristics learned.`);
          return { ...newLearnedPattern, id: p.id }; 
        }
        return p;
      });
      if (!patternUpdated) {
        updatedPatterns.push(newLearnedPattern);
        addLog(`[LEARN] Confirm&Next: New pattern created: ${newLearnedPattern.sourceFileName} (ID: ${newLearnedPattern.id}). Characteristics learned.`);
      }

      setAllLearnedPatterns(updatedPatterns);

      try {
        localStorage.setItem('astrostacker-learned-patterns-list', JSON.stringify(updatedPatterns));
        localStorage.setItem('astrostacker-learning-mode-active', 'true');
        addLog("[LEARN] Saved/Updated learned patterns list and active learning mode status (via Confirm & Next).");
      } catch (e) { console.error("LS save error", e); addLog("[ERROR] Confirm&Next: Could not save to localStorage."); }

      const toastTitleKey = patternUpdated ? 'starPatternOverwrittenToastTitle' : 'starPatternFirstLearnedToastTitle';
      const toastDescKey = patternUpdated ? 'starPatternOverwrittenToastDesc' : 'starPatternFirstLearnedToastDesc';

      toast({
        title: t(toastTitleKey),
        description: t(toastDescKey, {
            fileName: currentImageEntry.file.name,
            starCount: newLearnedPattern.stars.length,
            avgBrightness: characteristics.avgBrightness?.toFixed(1),
            avgContrast: characteristics.avgContrast?.toFixed(1),
            avgFwhm: characteristics.avgFwhm?.toFixed(1),
        }),
      });
      addLog(`[LEARN] ${patternUpdated ? 'Updated' : 'New'} pattern & characteristics learned from ${currentImageEntry.file.name} while using 'Confirm & Next'. AvgBr: ${characteristics.avgBrightness?.toFixed(1)}, AvgCo: ${characteristics.avgContrast?.toFixed(1)}, AvgFw: ${characteristics.avgFwhm?.toFixed(1)}`);
      patternJustLearnedOrOverwritten = true;
    } else {
        toast({title: "Stars Confirmed", description: `Star selection saved for ${currentImageName}.`});
    }

    const hasNextImage = currentEditingImageIndex < allImageStarData.length - 1;
    if (!hasNextImage) {
      setIsStarEditingMode(false);
      setCurrentEditingImageData(null);
      setCurrentEditingGrayscaleData(null);
      setCurrentEditingImageIndex(null);
      return;
    }

    if (patternJustLearnedOrOverwritten || isLearningModeActive) {
        await handleEditStarsRequest(currentEditingImageIndex + 1);
    }
    else if (allImageStarData.length > 1 && currentImageEntry.analysisStars.length > 0 && currentImageEntry.analysisDimensions && !isLearningModeActive) {
        setSourceImageForApplyMenu({
            id: currentImageEntry.id,
            fileName: currentImageEntry.file.name,
            stars: [...currentImageEntry.analysisStars],
            dimensions: { ...currentImageEntry.analysisDimensions },
        });
        setShowApplyStarOptionsMenu(true);
    } else {
        await handleEditStarsRequest(currentEditingImageIndex + 1);
    }
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
    setIsStarEditingMode(false); 
    setCurrentEditingImageIndex(null);
    setCurrentEditingImageData(null);
    setCurrentEditingGrayscaleData(null);
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
      setIsStarEditingMode(false);
      setCurrentEditingImageIndex(null);
      setCurrentEditingImageData(null);
      setCurrentEditingGrayscaleData(null);
      return;
    }
    const sourceAspectRatio = sourceWidth / sourceHeight;

    if (sourceStars.length === 0) {
      addLog("[WARN] Proportional apply skipped: Source image has no stars selected.");
      toast({ title: t('toastProportionalApplySkippedTitle'), description: t('toastProportionalApplySkippedDesc', {fileName: sourceFileName}), variant: "default" });
      setIsApplyingStarsFromMenu(false);
      setShowApplyStarOptionsMenu(false);
      setSourceImageForApplyMenu(null);
      setIsStarEditingMode(false);
      setCurrentEditingImageIndex(null);
      setCurrentEditingImageData(null);
      setCurrentEditingGrayscaleData(null);
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
          ...star, 
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
    setIsStarEditingMode(false); 
    setCurrentEditingImageIndex(null);
    setCurrentEditingImageData(null);
    setCurrentEditingGrayscaleData(null);
  };

  const handleCancelApplyStarOptionsMenu = () => {
    setShowApplyStarOptionsMenu(false);
    setSourceImageForApplyMenu(null);
    setIsStarEditingMode(false); 
    setCurrentEditingImageIndex(null);
    setCurrentEditingImageData(null);
    setCurrentEditingGrayscaleData(null);
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
    setStackedImage(null);
    setShowPostProcessEditor(false);
    setImageForPostProcessing(null);
    setEditedPreviewUrl(null);


    addLog(`Starting image stacking. Mode: ${stackingMode}. Output: ${outputFormat.toUpperCase()}. Light Files: ${allImageStarData.length}.`);
    addLog(`Bias Frames: ${useBiasFrames && biasFrameFiles.length > 0 ? `${biasFrameFiles.length} frame(s)` : 'Not Used'}.`);
    addLog(`Dark Frames: ${useDarkFrames && darkFrameFiles.length > 0 ? `${darkFrameFiles.length} frame(s)` : 'Not Used'}.`);
    addLog(`Flat Frames: ${useFlatFrames && flatFrameFiles.length > 0 ? `${flatFrameFiles.length} frame(s)` : 'Not Used'}.`);
    if (isLearningModeActive && selectedLearnedPatternIds.length > 0) {
        addLog(`[LEARN STACK] Using ${selectedLearnedPatternIds.length} selected learned pattern(s) for alignment guidance.`);
    } else if (isLearningModeActive) {
        addLog(`[LEARN STACK] Learning mode is active, but no patterns are selected. Using default alignment.`);
    }


    if (typeof window === 'undefined' || typeof document === 'undefined') {
        const envErrorMsg = "Stacking cannot proceed outside a browser environment.";
        addLog(`[ERROR] ${envErrorMsg}`);
        toast({ title: "Environment Error", description: envErrorMsg, variant: "destructive" });
        setIsProcessingStack(false);
        return;
    }

    try {
      setProgressPercent(PROGRESS_INITIAL_SETUP);
      addLog(`Initial setup complete. Progress: ${PROGRESS_INITIAL_SETUP}%.`);

      addLog(`Starting pre-stack analysis if needed...`);

      const imagesRequiringAnalysis = allImageStarData.filter(entry => !entry.isAnalyzed && !entry.isAnalyzing);

      if (imagesRequiringAnalysis.length > 0) {
          addLog(`Found ${imagesRequiringAnalysis.length} images requiring analysis.`);
          for (const imageEntry of imagesRequiringAnalysis) {
              addLog(`Analyzing image ${imageEntry.file.name} (ID: ${imageEntry.id}) for stacking process.`);
              await analyzeImageForStars(imageEntry, addLog);
          }
      } else {
          addLog("No images require pre-stack analysis at this time.");
      }

      let currentImageEntriesForStacking = [...allImageStarData];

      let stateWasModifiedByCleanup = false;
      const cleanedGlobalData = currentImageEntriesForStacking.map(entry => {
        if (entry.isAnalyzing) {
          addLog(`[STACK PREP CLEANUP] Forcing ${entry.file.name} out of 'isAnalyzing' before stacking. Current isAnalyzed: ${entry.isAnalyzed}`);
          stateWasModifiedByCleanup = true;
          return { ...entry, isAnalyzing: false }; 
        }
        return entry;
      });

      if (stateWasModifiedByCleanup) {
          setAllImageStarData(cleanedGlobalData); 
          await yieldToEventLoop(50); 
          currentImageEntriesForStacking = [...cleanedGlobalData]; 
      }
      addLog("Pre-stack analysis/preparation phase complete.");

    const imageElements: HTMLImageElement[] = [];
    addLog(`Loading ${currentImageEntriesForStacking.length} image elements from their previewUrls...`);
    for (const entry of currentImageEntriesForStacking) {
      try {
        const imgEl = await loadImage(entry.previewUrl, entry.file.name);
        imageElements.push(imgEl);
      } catch (loadError) {
         const errorMessage = loadError instanceof Error ? loadError.message : String(loadError);
         addLog(`[LOAD ERROR] ${entry.file.name}: ${errorMessage}`);
         toast({ title: `Error Loading ${entry.file.name}`, description: errorMessage, variant: "destructive" });
      }
    }
    addLog(`Successfully loaded ${imageElements.length} out of ${currentImageEntriesForStacking.length} images into HTMLImageElements.`);


    if (imageElements.length < 2) {
      const notEnoughValidMsg = `Need at least two valid images for stacking after filtering. Found ${imageElements.length}.`;
      addLog(`[ERROR] ${notEnoughValidMsg}`);
      toast({ title: "Not Enough Valid Images", description: notEnoughValidMsg, variant: "destructive" });
      setIsProcessingStack(false);
      setProgressPercent(0);
      return;
    }

    const firstValidImageIndex = currentImageEntriesForStacking.findIndex(
      entry => entry.isAnalyzed && imageElements.some(imgEl => imgEl.src === entry.previewUrl) && entry.analysisDimensions && entry.analysisDimensions.width > 0
    );

    let targetWidth: number;
    let targetHeight: number;
    let refDeterminationMethod = "Unknown";
    let defaultReferenceImageEntryForCentroidFallback: ImageStarEntry | null = null; 

    if (isLearningModeActive && selectedLearnedPatternIds.length > 0) {
        const firstSelectedPatternId = selectedLearnedPatternIds[0]; 
        const firstSelectedPattern = allLearnedPatterns.find(p => p.id === firstSelectedPatternId);

        if (firstSelectedPattern && firstSelectedPattern.dimensions.width > 0 && firstSelectedPattern.dimensions.height > 0) {
            targetWidth = firstSelectedPattern.dimensions.width;
            targetHeight = firstSelectedPattern.dimensions.height;
            refDeterminationMethod = `FirstSelectedPattern (${firstSelectedPattern.sourceFileName})`;
            addLog(`[LEARN STACK REF] Using first selected pattern '${firstSelectedPattern.sourceFileName}' for target dimensions: ${targetWidth}x${targetHeight}.`);
        } else {
            addLog(`[LEARN STACK REF WARN] First selected pattern ID '${firstSelectedPatternId}' is invalid or has no dimensions. Falling back to default ref image.`);
             if (firstValidImageIndex !== -1 && currentImageEntriesForStacking[firstValidImageIndex].analysisDimensions) {
                const dims = currentImageEntriesForStacking[firstValidImageIndex].analysisDimensions;
                targetWidth = dims.width;
                targetHeight = dims.height;
                defaultReferenceImageEntryForCentroidFallback = currentImageEntriesForStacking[firstValidImageIndex];
                refDeterminationMethod = `DefaultRef (Fallback from invalid selected pattern) (${defaultReferenceImageEntryForCentroidFallback.file.name})`;
            } else {
                const invalidRefMsg = `Reference dimensions from first selected pattern invalid, and no fallback default ref image. Cannot proceed.`;
                addLog(`[ERROR] ${invalidRefMsg}`);
                toast({ title: "Invalid Reference Dimensions", description: invalidRefMsg, variant: "destructive" });
                setIsProcessingStack(false); setProgressPercent(0); return;
            }
        }
    } else if (firstValidImageIndex !== -1 && currentImageEntriesForStacking[firstValidImageIndex].analysisDimensions) {
        const dims = currentImageEntriesForStacking[firstValidImageIndex].analysisDimensions;
        targetWidth = dims.width;
        targetHeight = dims.height;
        defaultReferenceImageEntryForCentroidFallback = currentImageEntriesForStacking[firstValidImageIndex];
        refDeterminationMethod = `DefaultRef (${defaultReferenceImageEntryForCentroidFallback.file.name})`;
         addLog(`[DEFAULT REF] Using default reference image '${defaultReferenceImageEntryForCentroidFallback.file.name}' for target dimensions: ${targetWidth}x${targetHeight}.`);
    } else {
      const noValidRefMsg = `Could not find a valid reference image (analyzed and loaded with dimensions) among images. Cannot proceed.`;
      addLog(`[ERROR] ${noValidRefMsg}`);
      toast({ title: "Invalid Reference Image", description: noValidRefMsg, variant: "destructive" });
      setIsProcessingStack(false); setProgressPercent(0); return;
    }
    addLog(`Target stacking dimensions: ${targetWidth}x${targetHeight} (determined by: ${refDeterminationMethod}).`);


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


    const numValidLightImages = imageElements.length;
    const totalPixelsInTarget = targetWidth * targetHeight;
    const normalizedImageFactor = Math.min(1, numValidLightImages / 20); 
    const veryLargePixelCount = 10000 * 10000; 
    const normalizedPixelFactor = Math.min(1, totalPixelsInTarget / veryLargePixelCount);
    const loadScore = (0.3 * normalizedImageFactor) + (0.7 * normalizedPixelFactor); 
    const dynamicDelayMs = Math.max(10, Math.min(100, 10 + Math.floor(loadScore * 90))); 
    addLog(`Calculated dynamic yield delay: ${dynamicDelayMs}ms (Load score: ${loadScore.toFixed(2)}, Images: ${numValidLightImages}, Pixels: ${totalPixelsInTarget})`);

    const globalCentroidsForFallback: ({ x: number; y: number } | null)[] = [];
    let successfulCentroidBasedAlignments = 0; 
    const centroidProgressIncrement = numValidLightImages > 0 ? PROGRESS_CENTROID_CALCULATION_TOTAL / numValidLightImages : 0;

    const tempAnalysisCanvasForFallback = document.createElement('canvas'); 
    const tempAnalysisCtxForFallback = tempAnalysisCanvasForFallback.getContext('2d', { willReadFrequently: true });
    if (!tempAnalysisCtxForFallback) throw new Error("Could not get fallback analysis canvas context.");


    addLog(`Starting fallback centroid calculation for ${numValidLightImages} valid light images...`);
    for (let i = 0; i < currentImageEntriesForStacking.length; i++) {
      const entryData = currentImageEntriesForStacking[i];
      const imgEl = imageElements.find(el => el.src === entryData.previewUrl);

      if (!imgEl) { 
          globalCentroidsForFallback.push(null); continue;
      }
      const fileNameForLog = entryData.file.name;
      let finalScaledCentroid: { x: number; y: number } | null = null;
      let method = "unknown_fallback";

      let starsForCentroidCalc: Star[] = [];
      if (entryData.starSelectionMode === 'manual' && entryData.analysisStars.length > 0) {
          starsForCentroidCalc = [...entryData.analysisStars];
      } else { 
          starsForCentroidCalc = [...entryData.initialAutoStars].sort((a,b) => b.brightness - a.brightness).slice(0, AUTO_ALIGN_TARGET_STAR_COUNT);
      }


      if (!entryData.isAnalyzed || !entryData.analysisDimensions || entryData.analysisDimensions.width === 0 || entryData.analysisDimensions.height === 0) {
          finalScaledCentroid = { x: targetWidth / 2, y: targetHeight / 2 };
          method = `geometric_fallback (no_analysis_data_or_failed_for_img_${i}_${fileNameForLog})`;
          addLog(`[FALLBACK GEOMETRIC] Image ${i} (${fileNameForLog}) due to missing or failed analysis. Centroid: (${finalScaledCentroid.x.toFixed(2)}, ${finalScaledCentroid.y.toFixed(2)})`);
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

      globalCentroidsForFallback.push(finalScaledCentroid);
      setProgressPercent(prev => Math.min(PROGRESS_INITIAL_SETUP + PROGRESS_CENTROID_CALCULATION_TOTAL, prev + centroidProgressIncrement));
      if (finalScaledCentroid) {
        addLog(`[FALLBACK CENTROID] Image ${i} (${fileNameForLog}): (${finalScaledCentroid.x.toFixed(2)}, ${finalScaledCentroid.y.toFixed(2)}) Method: ${method}`);
      } else {
        addLog(`[FALLBACK CENTROID ERROR] Image ${i} (${fileNameForLog}): Centroid calculation failed completely. Method: ${method}.`);
      }
      await yieldToEventLoop(dynamicDelayMs / 2); 
    }
    addLog(`Fallback centroid calculation complete. ${successfulCentroidBasedAlignments}/${numValidLightImages} would use star-based if affine from patterns failed.`);


    let defaultRefCentroidForFallback: { x: number; y: number } | null = null;
    if (defaultReferenceImageEntryForCentroidFallback) { 
        const defaultRefIndex = currentImageEntriesForStacking.findIndex(e => e.id === defaultReferenceImageEntryForCentroidFallback!.id);
        if(defaultRefIndex !== -1) {
            defaultRefCentroidForFallback = globalCentroidsForFallback[defaultRefIndex];
             addLog(`[FALLBACK REF CENTROID] Default reference image for fallback is ${defaultReferenceImageEntryForCentroidFallback.file.name}. Its global fallback centroid: (${defaultRefCentroidForFallback?.x.toFixed(2)}, ${defaultRefCentroidForFallback?.y.toFixed(2)})`);
        } else {
            addLog(`[FALLBACK REF CENTROID WARN] Default ref image for fallback not found in globalCentroids array. Centroid fallback may be impaired.`);
        }
    } else {
        addLog(`[FALLBACK REF CENTROID WARN] No default reference image identified for centroid fallback (e.g. if all alignment is pattern-based). This is okay if patterns work.`);
    }


    const finalImageData = new Uint8ClampedArray(targetWidth * targetHeight * 4);
    let validImagesStackedCount = 0; 
    let successfulAffinePatternAlignmentsThisStack = 0; 

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
        const currentImageEntry = currentImageEntriesForStacking.find(entry => entry.previewUrl === imgElement.src);

        if (!currentImageEntry || !currentImageEntry.analysisDimensions || currentImageEntry.analysisDimensions.width === 0) {
            if (yBandStart === 0) addLog(`[STACK SKIP WARN] Img ${i}: Cannot find entry data or valid analysis dimensions. Skipped.`);
            continue;
        }
        if (!currentImageEntry.isAnalyzed) { 
             if (yBandStart === 0) addLog(`[STACK SKIP WARN] Img ${i} (${currentImageEntry.file.name}): Not successfully analyzed. Skipped.`);
             continue;
        }

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
              calibratedLightDataArray[p] = Math.min(255, Math.max(0, (calibratedLightDataArray[p] * avgFlatIntensityR) / flatR));
              calibratedLightDataArray[p+1] = Math.min(255, Math.max(0, (calibratedLightDataArray[p+1] * avgFlatIntensityG) / flatG));
              calibratedLightDataArray[p+2] = Math.min(255, Math.max(0, (calibratedLightDataArray[p+2] * avgFlatIntensityB) / flatB));
          }
          logCalibrationMsg += "F";
        }
        if (logCalibrationMsg && i === 0 && yBandStart === 0) addLog(`[CALIBRATE] Img 0 (${currentImageEntry.file.name}): ${logCalibrationMsg.split("").join(", ")} applied.`);

        currentImageCtx.putImageData(new ImageData(calibratedLightDataArray, targetWidth, targetHeight), 0,0);


        let affineTransformAppliedForThisImage = false;
        let finalMatrixForWarp: number[][] | null = null;

        if (isLearningModeActive && selectedLearnedPatternIds.length > 0) {
             if (yBandStart === 0) addLog(`[MULTI-PATTERN] For image ${i} (${currentImageEntry.file.name}), attempting alignment with ${selectedLearnedPatternIds.length} selected pattern(s).`);

            for (const patternId of selectedLearnedPatternIds) {
                const activeLearnedPattern = allLearnedPatterns.find(p => p.id === patternId);
                if (!activeLearnedPattern) {
                    if (yBandStart === 0) addLog(`[MULTI-PATTERN WARN] Selected pattern ID ${patternId} not found for image ${i}. Skipping this pattern.`);
                    continue;
                }

                if (yBandStart === 0) addLog(`[MULTI-PATTERN TRY] Img ${i}: Trying pattern from ${activeLearnedPattern.sourceFileName} (ID: ${patternId})`);

                let referenceStarsForAffine: AstroAlignPoint[] = [];
                let referenceCentroidForAffineFallback: { x: number; y: number } | null = null;
                let effectiveReferenceDimensions = { ...activeLearnedPattern.dimensions }; 

                const learnedStarsToUse = activeLearnedPattern.stars 
                    .filter(s => s.fwhm !== undefined && s.fwhm >= ALIGNMENT_STAR_MIN_FWHM && s.fwhm <= ALIGNMENT_STAR_MAX_FWHM)
                    .sort((a, b) => b.brightness - a.brightness) 
                    .slice(0, NUM_STARS_TO_USE_FOR_AFFINE_MATCHING);

                if (learnedStarsToUse.length >= MIN_STARS_FOR_AFFINE_ALIGNMENT) {
                    referenceStarsForAffine = learnedStarsToUse.map(s => ({ x: s.x, y: s.y }));
                } else {
                    if (yBandStart === 0) addLog(`[MULTI-PATTERN WARN] Pattern ${activeLearnedPattern.sourceFileName} has only ${learnedStarsToUse.length} suitable stars (min ${MIN_STARS_FOR_AFFINE_ALIGNMENT} needed). Cannot use for affine for image ${i}.`);
                    continue; 
                }
                referenceCentroidForAffineFallback = calculateStarArrayCentroid(activeLearnedPattern.stars, addLog);
                if (referenceCentroidForAffineFallback && (effectiveReferenceDimensions.width !== targetWidth || effectiveReferenceDimensions.height !== targetHeight)) {
                    if (effectiveReferenceDimensions.width > 0 && effectiveReferenceDimensions.height > 0) {
                        referenceCentroidForAffineFallback = {
                            x: (referenceCentroidForAffineFallback.x / effectiveReferenceDimensions.width) * targetWidth,
                            y: (referenceCentroidForAffineFallback.y / effectiveReferenceDimensions.height) * targetHeight
                        };
                    } else { referenceCentroidForAffineFallback = { x: targetWidth / 2, y: targetHeight / 2 }; } 
                } else if (!referenceCentroidForAffineFallback) {
                    referenceCentroidForAffineFallback = { x: targetWidth / 2, y: targetHeight / 2 }; 
                }


                let candidateStarsForMatchingQuery: Star[] = (currentImageEntry.starSelectionMode === 'manual' && currentImageEntry.analysisStars.length > 0) ?
                                                        currentImageEntry.analysisStars : currentImageEntry.initialAutoStars;

                let candidateStarsForMatching: Star[] = [];
                const { avgBrightness, avgContrast, avgFwhm } = activeLearnedPattern; 
                if (avgBrightness !== undefined && avgContrast !== undefined) { 
                    addLog(`[MULTI-PATTERN SIMILARITY] Img ${i}: Using learned characteristics from pattern ${activeLearnedPattern.sourceFileName} (AvgBr: ${avgBrightness.toFixed(1)}, AvgCo: ${avgContrast.toFixed(1)}, AvgFw: ${avgFwhm?.toFixed(1)})`);
                    candidateStarsForMatching = candidateStarsForMatchingQuery
                        .filter(s => s.fwhm !== undefined && s.fwhm >= ALIGNMENT_STAR_MIN_FWHM && s.fwhm <= ALIGNMENT_STAR_MAX_FWHM)
                        .map(s => { 
                            const brightnessDiff = Math.abs((s.brightness || 0) - (avgBrightness || 0));
                            const contrastDiff = Math.abs((s.contrast || 0) - (avgContrast || 0));
                            const fwhmDiff = avgFwhm !== undefined && s.fwhm !== undefined ? Math.abs(s.fwhm - avgFwhm) : Infinity;
                            const score = (brightnessDiff / (Math.max(1, Math.abs(avgBrightness!)) * 0.5)) + 
                                          (contrastDiff / (Math.max(1, Math.abs(avgContrast!)) * 0.3)) +   
                                          (fwhmDiff / (Math.max(1, Math.abs(avgFwhm || 1)) * 0.2 ));       
                            return { ...s, similarityScore: score };
                        })
                        .sort((a, b) => (a.similarityScore || Infinity) - (b.similarityScore || Infinity)) 
                        .slice(0, NUM_STARS_TO_USE_FOR_AFFINE_MATCHING * 4); 
                    if (yBandStart === 0 && candidateStarsForMatching.length > 0) addLog(`[MULTI-PATTERN SIMILARITY] Img ${i} vs Pattern ${activeLearnedPattern.sourceFileName}: ${candidateStarsForMatching.length} candidates after similarity. Top score: ${candidateStarsForMatching[0]?.similarityScore?.toFixed(2)}`);
                } else { 
                     addLog(`[MULTI-PATTERN BRIGHT*CONTR] Img ${i}: Pattern ${activeLearnedPattern.sourceFileName} has no detailed characteristics. Using brightness*contrast sort for candidates.`);
                    candidateStarsForMatching = candidateStarsForMatchingQuery
                        .filter(s => s.fwhm !== undefined && s.fwhm >= ALIGNMENT_STAR_MIN_FWHM && s.fwhm <= ALIGNMENT_STAR_MAX_FWHM)
                        .sort((a, b) => (b.brightness * (b.contrast || 1)) - (a.brightness * (a.contrast || 1))) 
                        .slice(0, NUM_STARS_TO_USE_FOR_AFFINE_MATCHING * 4);
                    if (yBandStart === 0) addLog(`[MULTI-PATTERN BRIGHT*CONTR] Img ${i} vs Pattern ${activeLearnedPattern.sourceFileName}: ${candidateStarsForMatching.length} candidates.`);
                }


                const srcPtsMatched: AstroAlignPoint[] = []; 
                const dstPtsMatched: AstroAlignPoint[] = []; 
                const usedCurrentStarIndices = new Set<number>();

                const currentImageGlobalCentroid = globalCentroidsForFallback[i]; 
                let dxCentroidShiftTargetSpace = 0;
                let dyCentroidShiftTargetSpace = 0;
                if (currentImageGlobalCentroid && referenceCentroidForAffineFallback) { 
                    dxCentroidShiftTargetSpace = referenceCentroidForAffineFallback.x - currentImageGlobalCentroid.x;
                    dyCentroidShiftTargetSpace = referenceCentroidForAffineFallback.y - currentImageGlobalCentroid.y;
                }

                for (const refStar of referenceStarsForAffine) { 
                    const refStarInTargetSpaceX = (refStar.x / effectiveReferenceDimensions.width) * targetWidth;
                    const refStarInTargetSpaceY = (refStar.y / effectiveReferenceDimensions.height) * targetHeight;
                    const predictedTargetXInCurrentFrame = refStarInTargetSpaceX - dxCentroidShiftTargetSpace;
                    const predictedTargetYInCurrentFrame = refStarInTargetSpaceY - dyCentroidShiftTargetSpace;
                    const predictedXInCurrentAnalysis = (predictedTargetXInCurrentFrame / targetWidth) * currentImageEntry.analysisDimensions.width;
                    const predictedYInCurrentAnalysis = (predictedTargetYInCurrentFrame / targetHeight) * currentImageEntry.analysisDimensions.height;

                    let bestMatchIndexInCurrent = -1;
                    let minDistanceSqToPredicted = AFFINE_MATCHING_RADIUS_SQ; 
                    for (let k = 0; k < candidateStarsForMatching.length; k++) {
                        if (usedCurrentStarIndices.has(k)) continue;
                        const currentCandStar = candidateStarsForMatching[k]; 
                        const distSq = Math.pow(currentCandStar.x - predictedXInCurrentAnalysis, 2) + Math.pow(currentCandStar.y - predictedYInCurrentAnalysis, 2);
                        if (distSq < minDistanceSqToPredicted) {
                            minDistanceSqToPredicted = distSq;
                            bestMatchIndexInCurrent = k;
                        }
                    }
                    if (bestMatchIndexInCurrent !== -1) {
                        const matchedCurrentStar = candidateStarsForMatching[bestMatchIndexInCurrent];
                        srcPtsMatched.push({ x: matchedCurrentStar.x, y: matchedCurrentStar.y }); 
                        dstPtsMatched.push({ x: refStar.x, y: refStar.y }); 
                        usedCurrentStarIndices.add(bestMatchIndexInCurrent);
                    }
                    if (srcPtsMatched.length >= NUM_STARS_TO_USE_FOR_AFFINE_MATCHING) break; 
                }

                if (yBandStart === 0 && srcPtsMatched.length > 0) {
                    addLog(`[MULTI-PATTERN PAIRS SRC (Img ${i} AnlCoords)] for Pattern ${activeLearnedPattern.sourceFileName}: ${srcPtsMatched.map(p=>`(${p.x.toFixed(1)},${p.y.toFixed(1)})`).join('; ')}`);
                    addLog(`[MULTI-PATTERN PAIRS DST (Pattern ${activeLearnedPattern.sourceFileName} RefCoords)] for Img ${i}: ${dstPtsMatched.map(p=>`(${p.x.toFixed(1)},${p.y.toFixed(1)})`).join('; ')}`);
                }


                if (srcPtsMatched.length >= MIN_STARS_FOR_AFFINE_ALIGNMENT) {
                    try {
                        let estimatedMatrixAnalysisToPatternOriginal = estimateAffineTransform(srcPtsMatched, dstPtsMatched);

                        const scaleX_currAnl_to_target = targetWidth > 0 ? currentImageEntry.analysisDimensions.width / targetWidth : 1;
                        const scaleY_currAnl_to_target = targetHeight > 0 ? currentImageEntry.analysisDimensions.height / targetHeight : 1;

                        const scaleX_patternOrig_to_target = targetWidth > 0 ? effectiveReferenceDimensions.width / targetWidth : 1;
                        const scaleY_patternOrig_to_target = targetHeight > 0 ? effectiveReferenceDimensions.height / targetHeight : 1;
                        
                        finalMatrixForWarp = [
                            [
                                estimatedMatrixAnalysisToPatternOriginal[0][0] * (scaleX_currAnl_to_target / scaleX_patternOrig_to_target),
                                estimatedMatrixAnalysisToPatternOriginal[0][1] * (scaleY_currAnl_to_target / scaleX_patternOrig_to_target),
                                estimatedMatrixAnalysisToPatternOriginal[0][2] / scaleX_patternOrig_to_target
                            ],
                            [
                                estimatedMatrixAnalysisToPatternOriginal[1][0] * (scaleX_currAnl_to_target / scaleY_patternOrig_to_target),
                                estimatedMatrixAnalysisToPatternOriginal[1][1] * (scaleY_currAnl_to_target / scaleY_patternOrig_to_target),
                                estimatedMatrixAnalysisToPatternOriginal[1][2] / scaleY_patternOrig_to_target
                            ]
                        ];


                        if (yBandStart === 0) addLog(`[MULTI-PATTERN EST MATRIX (Analysis->PatternOrig)] Img ${i}, Pattern ${activeLearnedPattern.sourceFileName}: ${JSON.stringify(estimatedMatrixAnalysisToPatternOriginal.map(r => r.map(v => v.toFixed(3))))}`);
                        if (yBandStart === 0) addLog(`[MULTI-PATTERN ADJUSTED MATRIX (for warp)] Img ${i}, Pattern ${activeLearnedPattern.sourceFileName}: ${JSON.stringify(finalMatrixForWarp.map(r => r.map(v => v.toFixed(3))))}`);


                        if (finalMatrixForWarp.flat().some(val => !isFinite(val))) {
                             if (yBandStart === 0) addLog(`[MULTI-PATTERN FAIL] Img ${i}, Pattern ${activeLearnedPattern.sourceFileName}: Adjusted warp matrix has non-finite values. Matrix: ${JSON.stringify(finalMatrixForWarp)}`);
                            finalMatrixForWarp = null; 
                        } else {
                           if (yBandStart === 0) {
                                addLog(`[MULTI-PATTERN SUCCESS] Img ${i}: Pattern ${activeLearnedPattern.sourceFileName} resulted in valid matrix.`);
                                successfulAffinePatternAlignmentsThisStack++; 
                           }
                           affineTransformAppliedForThisImage = true; 
                        }
                    } catch (e) {
                        if (yBandStart === 0) addLog(`[MULTI-PATTERN ERROR] Img ${i}, Pattern ${activeLearnedPattern.sourceFileName}: estimateAffineTransform failed: ${e instanceof Error ? e.message : String(e)}.`);
                        finalMatrixForWarp = null;
                    }
                } else {
                     if (yBandStart === 0) addLog(`[MULTI-PATTERN INFO] Img ${i}, Pattern ${activeLearnedPattern.sourceFileName}: Not enough matched points (${srcPtsMatched.length}). Need at least ${MIN_STARS_FOR_AFFINE_ALIGNMENT}.`);
                }

                if (affineTransformAppliedForThisImage && finalMatrixForWarp) {
                    if (yBandStart === 0) addLog(`[MULTI-PATTERN USING] Img ${i}: Using pattern ${activeLearnedPattern.sourceFileName}.`);
                    break; 
                }
            }
        }


        tempWarpedImageCtx.clearRect(0,0,targetWidth,targetHeight); 
        if (affineTransformAppliedForThisImage && finalMatrixForWarp) {
            warpImage(currentImageCtx, tempWarpedImageCtx, finalMatrixForWarp, (yBandStart === 0 ? addLog : undefined));
        } else {
            const currentImageGlobalCentroid = globalCentroidsForFallback[i]; 
            let dx = 0, dy = 0;
            if (currentImageGlobalCentroid && defaultRefCentroidForFallback) {
                dx = defaultRefCentroidForFallback.x - currentImageGlobalCentroid.x;
                dy = defaultRefCentroidForFallback.y - currentImageGlobalCentroid.y;
            }
            tempWarpedImageCtx.drawImage(currentImageCanvas, dx, dy); 
            if (yBandStart === 0) {
                 addLog(`[ALIGN FALLBACK/NO-PATTERN] Image ${i} (${currentImageEntry.file.name}): Using centroid (dx:${dx.toFixed(2)}, dy:${dy.toFixed(2)}). Affine from patterns was ${affineTransformAppliedForThisImage ? 'attempted but ultimately failed' : 'not successful or not applicable'}.`);
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
      const noStackMsg = "No images could be successfully processed during band stacking (zero contribution). Check logs for errors during alignment or calibration.";
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
      outputMimeType = 'image/png';
      resultDataUrl = finalResultCanvas.toDataURL(outputMimeType);
      addLog(`Generated PNG image.`);
    }

    if (!resultDataUrl || resultDataUrl === "data:," || resultDataUrl.length < MIN_VALID_DATA_URL_LENGTH) {
      const previewFailMsg = `Could not generate a valid image preview in ${outputFormat.toUpperCase()} format. The resulting data URL was too short or invalid. This can happen with very large images or if the canvas is blank.`;
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

      const alignmentMessage = successfulAffinePatternAlignmentsThisStack > 0
        ? `${successfulAffinePatternAlignmentsThisStack}/${imageElements.length} images aligned using (at least one of the) selected Learned Patterns. Others used centroid fallback.`
        : `All ${imageElements.length} images aligned using centroid-based methods (Learned Patterns did not yield a successful alignment or were not used/selected).`;

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
    addLog(`[FATAL ERROR] Stacking Process Failed: ${errorMessage}. Stack trace: ${error instanceof Error ? error.stack : 'N/A'}`);
    toast({
      title: "Stacking Process Failed",
      description: `An unexpected error occurred: ${errorMessage}. Check console and logs. Very large images may cause browser instability or errors.`,
      variant: "destructive",
    });
    setStackedImage(null);
  } finally {
    setIsProcessingStack(false);
    setProgressPercent(0); 
    addLog("Image stacking process finished.");
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

  const handleLearnPinSubmit = () => {
    if (learnPinInput === LEARNING_MODE_PIN) {
      setIsLearningModeActive(true);
      try {
        localStorage.setItem('astrostacker-learning-mode-active', 'true');
        addLog("[LEARN] Learning Mode activated.");
        toast({ title: t('learningModeActivatedToastTitle'), description: t('learningModeActivatedToastDesc') });
      } catch (error) {
        console.error("Error managing localStorage for learning mode:", error);
        addLog("[ERROR] Could not save learning mode status to localStorage.");
      }
    } else {
      toast({ title: t('incorrectPinToastTitle'), description: t('incorrectPinToastDesc'), variant: "destructive" });
      addLog("[LEARN] Incorrect PIN entered for Learning Mode.");
    }
    setShowLearnPinDialog(false);
    setLearnPinInput("");
  };

  const toggleLearningMode = () => {
    if (isLearningModeActive) {
      setIsLearningModeActive(false);
      try {
        localStorage.removeItem('astrostacker-learning-mode-active'); 
        addLog("[LEARN] Learning Mode deactivated. Stored patterns and selections remain.");
      } catch (error) {
        console.error("Error clearing learning mode status from localStorage:", error);
        addLog("[ERROR] Could not clear learning mode status from localStorage.");
      }
      toast({ title: t('learningModeDeactivatedToastTitle'), description: t('learningModeDeactivatedToastDesc') });
    } else {
      setShowLearnPinDialog(true); 
    }
  };

 const handleTogglePatternSelection = (patternId: string) => {
    setSelectedLearnedPatternIds(prevSelectedIds => {
        const newSelectedIds = prevSelectedIds.includes(patternId)
            ? prevSelectedIds.filter(id => id !== patternId)
            : [...prevSelectedIds, patternId];
        try {
            localStorage.setItem('astrostacker-selected-pattern-ids', JSON.stringify(newSelectedIds));
            addLog(`[LEARN] Updated selected patterns. Count: ${newSelectedIds.length}. IDs: ${newSelectedIds.join(', ')}. Saved to localStorage.`);
        } catch (e) {
            addLog(`[LEARN ERROR] Could not store selected pattern IDs: ${e}`);
        }
        return newSelectedIds;
    });
};

  const handleDeleteLearnedPattern = (patternIdToDelete: string) => {
    const patternName = allLearnedPatterns.find(p=>p.id === patternIdToDelete)?.sourceFileName || 'pattern';
    const updatedPatterns = allLearnedPatterns.filter(p => p.id !== patternIdToDelete);
    setAllLearnedPatterns(updatedPatterns);

    const updatedSelectedIds = selectedLearnedPatternIds.filter(id => id !== patternIdToDelete);
    setSelectedLearnedPatternIds(updatedSelectedIds);

    try {
      localStorage.setItem('astrostacker-learned-patterns-list', JSON.stringify(updatedPatterns));
      localStorage.setItem('astrostacker-selected-pattern-ids', JSON.stringify(updatedSelectedIds)); 
      addLog(`[LEARN] Deleted learned pattern ID: ${patternIdToDelete} (${patternName}). Updated list and selection in localStorage.`);
      toast({title: t('patternDeletedToastTitle'), description: t('patternDeletedToastDesc', {fileName: patternName})});

    } catch (e) {
      addLog(`[LEARN ERROR] Could not update localStorage after deleting pattern: ${e}`);
    }
  };

  const handleClearAllLearnedPatterns = () => {
    setAllLearnedPatterns([]);
    setSelectedLearnedPatternIds([]); 
    try {
      localStorage.removeItem('astrostacker-learned-patterns-list');
      localStorage.removeItem('astrostacker-selected-pattern-ids'); 
      addLog("[LEARN] All learned patterns and selections cleared by user (also from localStorage).");
    } catch (error) {
      console.error("Error clearing all learned patterns from localStorage:", error);
      addLog("[ERROR] Could not clear all learned patterns from localStorage.");
    }
    toast({ title: t('allPatternsClearedToastTitle'), description: t('allPatternsClearedToastDesc') });
  };

  const handleTestImageFileAdded = async (files: File[]) => {
    if (files.length === 0) return;
    const file = files[0];
    setTestImageFile(file);
    setTestImageDetectedStars([]); 
    addLog(`[LEARN TEST] Test image selected: ${file.name}`);
    try {
        const url = await fileToDataURL(file);
        setTestImagePreviewUrl(url);

        const img = new Image();
        img.onload = () => {
            setTestImageAnalysisDimensions({ width: img.naturalWidth, height: img.naturalHeight });
            addLog(`[LEARN TEST] Test image preview loaded for ${file.name} (${img.naturalWidth}x${img.naturalHeight})`);
        };
        img.onerror = () => {
            addLog(`[LEARN TEST ERROR] Could not load test image preview for ${file.name}`);
            toast({title: "Test Image Load Error", description: `Could not load preview for ${file.name}.`, variant: "destructive"});
            setTestImagePreviewUrl(null);
            setTestImageAnalysisDimensions(null);
        };
        img.src = url;
    } catch (error) {
        addLog(`[LEARN TEST ERROR] Could not process test image ${file.name}: ${error}`);
        toast({title: "Test Image Error", description: `Error processing ${file.name}.`, variant: "destructive"});
        setTestImagePreviewUrl(null);
        setTestImageAnalysisDimensions(null);
    }
  };

  const handleRunLearnTest = async () => {
    if (!testImageFile || !testImagePreviewUrl || !testImageAnalysisDimensions) {
        toast({ title: t('noTestImageToastTitle'), description: t('noTestImageToastDesc'), variant: "destructive"});
        return;
    }
    if (selectedLearnedPatternIds.length !== 1) { 
        toast({ title: t('learnTestSelectSinglePatternTitle'), description: t('learnTestSelectSinglePatternDesc'), variant: "destructive"});
        return;
    }
    const activePatternForTest = allLearnedPatterns.find(p => p.id === selectedLearnedPatternIds[0]);

    if (!isLearningModeActive || !activePatternForTest) {
        toast({ title: t('noActivePatternForTestToastTitle'), description: t('noActivePatternForTestToastDesc'), variant: "destructive"});
        return;
    }

    addLog(`[LEARN TEST] Starting analysis of ${testImageFile.name} with pattern from ${activePatternForTest.sourceFileName}`);
    setIsAnalyzingTestImage(true);
    setTestImageDetectedStars([]);

    try {
        const imgEl = await loadImage(testImagePreviewUrl, testImageFile.name);
        const { width: analysisW, height: analysisH } = testImageAnalysisDimensions;

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = analysisW;
        tempCanvas.height = analysisH;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        if (!tempCtx) throw new Error("Could not get canvas context for test image analysis.");
        tempCtx.drawImage(imgEl, 0, 0, analysisW, analysisH);
        const grayscaleTestData = getGrayscaleArrayFromCanvas(tempCtx, addLog);

        const detectedPointsOnTest: DetectedStarPoint[] = detectStarsWithNewPipeline(grayscaleTestData, addLog);
        addLog(`[LEARN TEST] Raw detection on test image: ${detectedPointsOnTest.length} points.`);

        const { avgBrightness, avgContrast, avgFwhm } = activePatternForTest;
        addLog(`[LEARN TEST] Using pattern characteristics: AvgBr=${avgBrightness?.toFixed(1)}, AvgCo=${avgContrast?.toFixed(1)}, AvgFw=${avgFwhm?.toFixed(1)}`);

        const recognizedStars: Star[] = detectedPointsOnTest
            .filter(p => p.fwhm >= ALIGNMENT_STAR_MIN_FWHM && p.fwhm <= ALIGNMENT_STAR_MAX_FWHM) 
            .map(p => { 
                let similarityScore = Infinity;
                if (avgBrightness !== undefined && avgContrast !== undefined) { 
                    const brightnessDiff = Math.abs(p.windowSumBrightness - avgBrightness);
                    const contrastDiff = Math.abs(p.contrast - avgContrast);
                    let fwhmDiff = 0;
                    if (avgFwhm !== undefined && p.fwhm !== undefined) { 
                        fwhmDiff = Math.abs(p.fwhm - avgFwhm);
                    }
                    similarityScore = (brightnessDiff / (Math.max(1, Math.abs(avgBrightness)))) +
                                      (contrastDiff / (Math.max(1, Math.abs(avgContrast)))) +
                                      (fwhmDiff / (Math.max(1, Math.abs(avgFwhm || 1)))); 
                }
                return { ...p, similarityScore }; 
            })
            .sort((a, b) => (a.similarityScore || Infinity) - (b.similarityScore || Infinity)) 
            .slice(0, LEARN_TEST_MAX_STARS_TO_SHOW) 
            .map(p => ({ 
                x: p.x,
                y: p.y,
                brightness: p.windowSumBrightness,
                fwhm: p.fwhm,
                contrast: p.contrast,
                isManuallyAdded: false, 
            }));

        setTestImageDetectedStars(recognizedStars);
        addLog(`[LEARN TEST] Found ${recognizedStars.length} stars matching pattern characteristics on ${testImageFile.name}.`);
        toast({
            title: t('testAnalysisCompleteToastTitle'),
            description: recognizedStars.length > 0 ?
                         t('testAnalysisCompleteToastDesc', { count: recognizedStars.length, fileName: testImageFile.name }) :
                         t('testAnalysisNoStarsFoundToastDesc', { fileName: testImageFile.name }),
        });

    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        addLog(`[LEARN TEST ERROR] Analysis failed for ${testImageFile.name}: ${errMsg}`);
        toast({ title: "Learn Test Failed", description: errMsg, variant: "destructive" });
    } finally {
        setIsAnalyzingTestImage(false);
    }
  };


  const canStartStacking = allImageStarData.length >= 2;
  const isUiDisabled = isProcessingStack ||
                       isProcessingDarkFrames ||
                       isProcessingFlatFrames ||
                       isProcessingBiasFrames ||
                       (currentEditingImageIndex !== null && (allImageStarData.find((e,i)=>i===currentEditingImageIndex)?.isAnalyzing)) ||
                       isApplyingStarsFromMenu ||
                       isAnalyzingTestImage;

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
                                isAnalyzing={entry.isAnalyzing}
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

                     <Card className="mt-4 shadow-md">
                      <CardHeader className="pb-3 pt-4">
                          <CardTitle className="flex items-center text-lg">
                              <Brain className="mr-2 h-5 w-5 text-accent" />
                              {t('learningModeCardTitle')}
                          </CardTitle>
                          <CardDescription className="text-xs">{t('learningModeCardDescription')}</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3 pb-4">
                          {isLearningModeActive && (
                            <Badge variant="outline" className="border-green-500 text-green-500 mb-2 inline-flex items-center">
                              <BadgeAlert className="mr-1 h-3 w-3" /> {t('learningModeActiveIndicator')}
                            </Badge>
                          )}
                          <Button onClick={toggleLearningMode} variant="outline" className="w-full" disabled={isUiDisabled && !showLearnPinDialog}>
                              {isLearningModeActive ? <><X className="mr-2 h-4 w-4" />{t('stopLearningSession')}</> : <><KeyRound className="mr-2 h-4 w-4" />{t('startLearningSession')}</>}
                          </Button>

                          {isLearningModeActive && selectedLearnedPatternIds.length > 0 && (
                            <div className="text-xs text-muted-foreground p-3 border rounded-md space-y-1 bg-muted/10 mt-2">
                              <p className="font-semibold text-foreground">{t('selectedPatternsTitle', { count: selectedLearnedPatternIds.length })}</p>
                                {selectedLearnedPatternIds.map(id => {
                                    const pattern = allLearnedPatterns.find(p => p.id === id);
                                    return pattern ? <span key={id} className="inline-block bg-accent/20 text-accent-foreground rounded px-1.5 py-0.5 mr-1 mb-1 text-xs">{pattern.sourceFileName}</span> : null;
                                })}
                            </div>
                          )}
                           {isLearningModeActive && selectedLearnedPatternIds.length === 0 && allLearnedPatterns.length > 0 && (
                             <p className="text-xs text-muted-foreground italic p-2 border rounded-md">{t('noActivePatternSelectedInfo')}</p>
                          )}
                          {isLearningModeActive && allLearnedPatterns.length === 0 && (
                             <p className="text-xs text-muted-foreground italic p-2 border rounded-md">{t('noPatternLearnedYetInfo')}</p>
                          )}
                           {!isLearningModeActive && allLearnedPatterns.length > 0 && (
                             <p className="text-xs text-muted-foreground italic p-2 border rounded-md">{t('patternStoredButModeOffInfo', {count: allLearnedPatterns.length})}</p>
                          )}

                          {isLearningModeActive && allLearnedPatterns.length > 0 && (
                            <div className="mt-3">
                                <Label className="text-sm font-semibold mb-1 block">{t('allLearnedPatternsListTitle')} ({allLearnedPatterns.length})</Label>
                                <ScrollArea className="h-40 border rounded-md p-2 bg-background/50">
                                    {allLearnedPatterns.map(pattern => (
                                        <div key={pattern.id} className={`p-2 mb-1.5 rounded-md border ${selectedLearnedPatternIds.includes(pattern.id) ? 'bg-accent/20 border-accent' : 'bg-muted/20'}`}>
                                            <div className="flex items-center justify-start">
                                                <Checkbox
                                                    id={`select-pattern-${pattern.id}`}
                                                    checked={selectedLearnedPatternIds.includes(pattern.id)}
                                                    onCheckedChange={() => handleTogglePatternSelection(pattern.id)}
                                                    disabled={isUiDisabled}
                                                    aria-label={t('selectPatternCheckboxLabel', {fileName: pattern.sourceFileName})}
                                                    className="mr-2 h-4 w-4"
                                                />
                                                <p className="text-xs font-medium truncate text-foreground flex-grow">{pattern.sourceFileName}</p>
                                            </div>
                                            <p className="text-xs text-muted-foreground pl-6"> {/* Indent details to align with text */}
                                                {pattern.stars.length} stars, {pattern.dimensions.width}x{pattern.dimensions.height}px
                                            </p>
                                             <p className="text-xs text-muted-foreground truncate pl-6">
                                                AvgBr: {pattern.avgBrightness?.toFixed(1)}, AvgCo: {pattern.avgContrast?.toFixed(1)}, AvgFw: {pattern.avgFwhm?.toFixed(1)}
                                            </p>
                                            <p className="text-xs text-muted-foreground pl-6">Learned: {new Date(pattern.timestamp).toLocaleDateString()}</p>
                                            <div className="flex gap-1 mt-1.5 pl-6">
                                                <Button
                                                    size="sm"
                                                    variant="destructive"
                                                    onClick={() => handleDeleteLearnedPattern(pattern.id)}
                                                    className="h-6 px-1.5 py-0.5 text-xs" 
                                                    disabled={isUiDisabled}
                                                >
                                                    <Trash2 className="mr-1 h-3 w-3" /> {t('deletePatternButtonText')}
                                                </Button>
                                            </div>
                                        </div>
                                    ))}
                                </ScrollArea>
                                {allLearnedPatterns.length > 0 && (
                                  <Button onClick={handleClearAllLearnedPatterns} size="sm" variant="link" className="text-destructive p-0 h-auto mt-2 text-xs" disabled={isUiDisabled || allLearnedPatterns.length === 0}>
                                    {t('clearAllLearnedPatternsButton')}
                                  </Button>
                                )}
                            </div>
                          )}
                      </CardContent>
                    </Card>

                    {isLearningModeActive && (
                        <Card className="mt-4 shadow-md">
                            <CardHeader className="pb-3 pt-4">
                                <CardTitle className="flex items-center text-lg">
                                    <TestTube2 className="mr-2 h-5 w-5 text-accent" />
                                    {t('learnTestCardTitle')}
                                </CardTitle>
                                <CardDescription className="text-xs">{t('learnTestCardDescription')}</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3 pb-4">
                                <ImageUploadArea
                                    onFilesAdded={handleTestImageFileAdded}
                                    isProcessing={isUiDisabled}
                                    multiple={false}
                                />
                                {testImagePreviewUrl && testImageAnalysisDimensions && (
                                    <div className="mt-3 space-y-2">
                                        <h4 className="text-sm font-semibold">{t('testImagePreviewTitle', {fileName: testImageFile?.name || 'Test Image'})}</h4>
                                        <StarAnnotationCanvas
                                            imageUrl={testImagePreviewUrl}
                                            stars={testImageDetectedStars}
                                            analysisWidth={testImageAnalysisDimensions.width}
                                            analysisHeight={testImageAnalysisDimensions.height}
                                            onCanvasClick={() => {}} 
                                            canvasDisplayWidth={STAR_ANNOTATION_MAX_DISPLAY_WIDTH / 1.5} 
                                            starColorOverride="rgba(0, 255, 0, 0.8)" 
                                        />
                                         {testImageDetectedStars.length > 0 && (
                                            <p className="text-xs text-center text-green-400">{t('recognizedStarsCount', {count: testImageDetectedStars.length})}</p>
                                        )}
                                    </div>
                                )}
                                 {selectedLearnedPatternIds.length !== 1 && testImageFile && (
                                    <Alert variant="default" className="mt-2">
                                        <Info className="h-4 w-4" />
                                        <AlertTitle>{t('learnTestSelectSinglePatternTitle')}</AlertTitle>
                                        <AlertDescription>{t('learnTestSelectSinglePatternDesc')}</AlertDescription>
                                    </Alert>
                                )}
                                <Button
                                    onClick={handleRunLearnTest}
                                    className="w-full"
                                    disabled={isUiDisabled || !testImageFile || selectedLearnedPatternIds.length !== 1}
                                >
                                    {isAnalyzingTestImage ? (
                                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('analyzingTestImageProgress')}</>
                                    ) : (
                                        <>{t('runPatternTestButton')}</>
                                    )}
                                </Button>
                            </CardContent>
                        </Card>
                    )}


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
                          title={currentEditingImageIndex !== null && currentEditingImageIndex >= allImageStarData.length - 1 ? "This is the last image in the queue." : ""}
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
                        <Button onClick={() => {setIsStarEditingMode(false); setCurrentEditingImageIndex(null); setCurrentEditingImageData(null); setCurrentEditingGrayscaleData(null);}} variant="ghost" className="w-full text-muted-foreground" disabled={isUiDisabled}>
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
                            <span className={
                                log.message.startsWith('[ERROR]') || log.message.startsWith('[ANALYSIS ERROR CAUGHT]') ||
                                log.message.startsWith('[FITS ERROR]') || log.message.startsWith('[FATAL ERROR]') ||
                                log.message.startsWith('[DETECTOR ERROR]') || log.message.startsWith('[DETECTOR CANVAS ERROR]') ||
                                log.message.startsWith('[FWHM EST ERROR]') || log.message.startsWith('[AFFINE ERROR]') ||
                                log.message.startsWith('[RAW JS ERROR]') || log.message.startsWith('[RAW UNAVAILABLE]') ||
                                log.message.startsWith('[RAW CALIB. UNAVAILABLE]')  ? 'text-destructive' :
                                (log.message.startsWith('[WARN]') || log.message.includes('Warning:') ||
                                 log.message.startsWith('[FWHM EST WARN]') || log.message.startsWith('[DETECTOR WARN]') ||
                                 log.message.startsWith('[ALIGN WARN]') || log.message.startsWith('[LOCAL CENTROID WARN]') ||
                                 log.message.startsWith('[STACK SKIP WARN]') || log.message.startsWith('[AFFINE WARN]') ||
                                 log.message.startsWith('[AFFINE FAIL]') || log.message.startsWith('[STACK LEARN WARN]') ||
                                 log.message.startsWith('[ALIGN REF WARN]') || log.message.startsWith('[ALIGN FALLBACK WARN]') ||
                                 log.message.startsWith('[MULTI-PATTERN WARN]') ?
                                 'text-yellow-500' :
                                 (log.message.startsWith('[LEARN') || log.message.startsWith('[AFFINE REF PREP]') || log.message.startsWith('[AFFINE MATCH') || log.message.startsWith('[MULTI-PATTERN') ? 'text-sky-400' : 'text-foreground/80'))
                            }>{log.message}</span>
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

      <AlertDialog open={showLearnPinDialog} onOpenChange={setShowLearnPinDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('enterPinDialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('enterPinDialogDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="learn-pin-input">{t('pinPlaceholder')}</Label>
            <Input
              id="learn-pin-input"
              type="password"
              value={learnPinInput}
              onChange={(e) => setLearnPinInput(e.target.value)}
              placeholder={t('pinPlaceholder')}
              onKeyDown={(e) => e.key === 'Enter' && handleLearnPinSubmit()}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setLearnPinInput(""); setShowLearnPinDialog(false); }}>{t('cancelEditing')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleLearnPinSubmit}>{t('submitPinButton')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>


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

