
'use server';

import type { Star } from './astro-align';
import { detectStarsAI } from './ai-star-detection';


// The characteristics of a star that we want to learn.
export interface StarCharacteristics {
  avgBrightness: number;
  avgContrast: number;
  fwhm: number;
  pixelCount: number;
}

// A pattern is a collection of characteristics from stars you've selected.
export interface LearnedPattern {
  id: string; // Typically a generic name, since it aggregates data
  timestamp: number;
  sourceImageIds: string[]; // Keep track of which images contributed
  characteristics: StarCharacteristics[];
}

// A simplified representation of ImageData suitable for server-side processing
export interface SimpleImageData {
    data: number[]; // Use a plain array for serialization
    width: number;
    height: number;
}


const PATCH_SIZE = 7; // 7x7 pixel patch around the star center
const PATCH_RADIUS = Math.floor(PATCH_SIZE / 2);

function toGrayscale(imageData: SimpleImageData): Uint8Array | null {
  try {
    const len = imageData.data.length / 4;
    const gray = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      const r = imageData.data[i * 4];
      const g = imageData.data[i * 4 + 1];
      const b = imageData.data[i * 4 + 2];
      gray[i] = (0.299 * r + 0.587 * g + 0.114 * b);
    }
    return gray;
  } catch(e) {
    return null;
  }
}


/**
 * Extracts a pixel patch and calculates characteristics for a given star.
 */
function getStarCharacteristics(star: Star, imageData: SimpleImageData, grayData: Uint8Array): StarCharacteristics | null {
  try {
    const { width } = imageData;
    const { x, y } = star;
    
    const startX = Math.round(x) - PATCH_RADIUS;
    const startY = Math.round(y) - PATCH_RADIUS;

    const pixels: number[] = [];
    let sumBrightness = 0;
    let peakBrightness = 0;

    for (let j = 0; j < PATCH_SIZE; j++) {
      for (let i = 0; i < PATCH_SIZE; i++) {
        const px = startX + i;
        const py = startY + j;

        if (px >= 0 && px < imageData.width && py >= 0 && py < imageData.height) {
          const idx = py * width + px;
          const brightness = grayData[idx];
          if (brightness !== undefined) {
            pixels.push(brightness);
            sumBrightness += brightness;
            if (brightness > peakBrightness) {
              peakBrightness = brightness;
            }
          }
        }
      }
    }

    if (pixels.length === 0) return null;

    const avgBrightness = sumBrightness / pixels.length;
    if (avgBrightness === 0) return null;
    
    const sumSqDiff = pixels.reduce((sum, p) => sum + (p - avgBrightness) ** 2, 0);
    const stdDev = Math.sqrt(sumSqDiff / pixels.length);
    const avgContrast = stdDev / (avgBrightness + 1e-6); // Added epsilon for safety

    const halfMax = peakBrightness / 2;
    const brightPixels = pixels.filter(p => p > halfMax);
    const fwhm = brightPixels.length > 0 ? Math.sqrt(brightPixels.length / Math.PI) * 2 : 0;

    return {
      avgBrightness,
      avgContrast,
      fwhm,
      pixelCount: star.size > 0 ? star.size : brightPixels.length,
    };
  } catch (e) {
    return null;
  }
}


/**
 * Analyzes manually selected stars from a single image and returns their characteristics.
 */
export async function extractCharacteristicsFromImage({
  stars,
  imageData
}: {
  stars: Star[],
  imageData: SimpleImageData
}): Promise<StarCharacteristics[]> {
  
  const grayData = toGrayscale(imageData);
  if (!grayData) return [];
  
  const characteristics = stars
    .map(star => getStarCharacteristics(star, imageData, grayData))
    .filter((c): c is StarCharacteristics => c !== null);

  return characteristics;
}


/**
 * Finds all stars in an image that match the learned patterns.
 */
export async function findMatchingStars({
  allDetectedStars,
  imageData,
  learnedPatterns,
  matchThreshold = 0.75
}: {
  allDetectedStars: Star[],
  imageData: SimpleImageData,
  learnedPatterns: LearnedPattern[],
  matchThreshold?: number
}): Promise<{matchedStars: Star[], logs: string[]}> {
  const logs: string[] = [];
  try {
    logs.push(`[findMatchingStars] Starting match process with ${allDetectedStars.length} detected stars and ${learnedPatterns.length} patterns.`);
    if (learnedPatterns.length === 0) return { matchedStars: [], logs };
    
    const grayData = toGrayscale(imageData);
    if (!grayData) {
        logs.push("[findMatchingStars] Error: Failed to convert image to grayscale.");
        return { matchedStars: [], logs };
    }

    const matchedStars: Star[] = [];

    for (const star of allDetectedStars) {
        const starChars = getStarCharacteristics(star, imageData, grayData);
        if (!starChars) continue;
        
        const matchScore = compareCharacteristics(starChars, learnedPatterns);
        
        if (matchScore >= matchThreshold) {
            matchedStars.push(star);
        }
    }

    logs.push(`[findMatchingStars] Found ${matchedStars.length} stars matching the patterns.`);
    return { matchedStars, logs };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    logs.push(`[findMatchingStars] CRASH! ${errorMessage}`);
    console.error("Error in findMatchingStars:", e);
    throw new Error(`A critical error occurred in findMatchingStars: ${errorMessage}`);
  }
}


/**
 * Compares a star's characteristics to a set of learned patterns.
 */
function compareCharacteristics(
  starChars: StarCharacteristics,
  learnedPatterns: LearnedPattern[]
): number {
  let bestScore = 0;

  for (const pattern of learnedPatterns) {
    for (const learnedChar of pattern.characteristics) {
      const brightDiff = Math.abs(starChars.avgBrightness - learnedChar.avgBrightness) / (learnedChar.avgBrightness + 1e-6);
      const contrastDiff = Math.abs(starChars.avgContrast - learnedChar.avgContrast) / (learnedChar.avgContrast + 1e-6);
      const fwhmDiff = Math.abs(starChars.fwhm - learnedChar.fwhm) / (learnedChar.fwhm + 1e-6);
      const sizeDiff = Math.abs(starChars.pixelCount - learnedChar.pixelCount) / (learnedChar.pixelCount + 1e-6);
      
      const totalDiff = (0.4 * brightDiff + 0.3 * fwhmDiff + 0.2 * contrastDiff + 0.1 * sizeDiff);
      const score = Math.max(0, 1 - totalDiff);

      if (score > bestScore) {
        bestScore = score;
      }
    }
  }
  return bestScore;
}
