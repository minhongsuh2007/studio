
'use server';

import type { Star } from './astro-align';

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

/**
 * Extracts a pixel patch and calculates characteristics for a given star.
 */
function getStarCharacteristics(star: Star, imageData: SimpleImageData): StarCharacteristics | null {
  const { width, height, data } = imageData;
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

      if (px >= 0 && px < width && py >= 0 && py < height) {
        const idx = (py * width + px) * 4;
        // Using a simple grayscale conversion for brightness
        const brightness = (data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114);
        pixels.push(brightness);
        sumBrightness += brightness;
        if (brightness > peakBrightness) {
          peakBrightness = brightness;
        }
      }
    }
  }

  if (pixels.length === 0) return null;

  const avgBrightness = sumBrightness / pixels.length;
  if (avgBrightness === 0) return null;
  
  const sumSqDiff = pixels.reduce((sum, p) => sum + (p - avgBrightness) ** 2, 0);
  const stdDev = Math.sqrt(sumSqDiff / pixels.length);
  const avgContrast = stdDev / avgBrightness;

  // Full Width at Half Maximum (FWHM) estimation
  const halfMax = peakBrightness / 2;
  const brightPixels = pixels.filter(p => p > halfMax);
  const fwhm = brightPixels.length > 0 ? Math.sqrt(brightPixels.length / Math.PI) * 2 : 0;

  return {
    avgBrightness,
    avgContrast,
    fwhm,
    pixelCount: star.size > 0 ? star.size : brightPixels.length, // Use a fallback for manually added stars
  };
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
  const characteristics = stars
    .map(star => getStarCharacteristics(star, imageData))
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
  matchThreshold = 0.75 // How similar a star needs to be to be considered a match
}: {
  allDetectedStars: Star[],
  imageData: SimpleImageData,
  learnedPatterns: LearnedPattern[],
  matchThreshold?: number
}): Promise<Star[]> {
  if (learnedPatterns.length === 0) return [];
  
  const matchedStars: Star[] = [];

  for (const star of allDetectedStars) {
    const starChars = getStarCharacteristics(star, imageData);
    if (!starChars) continue;
    
    const matchScore = compareCharacteristics(starChars, learnedPatterns);
    
    if (matchScore >= matchScore) {
      matchedStars.push(star);
    }
  }

  return matchedStars;
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
      // Simple scoring based on weighted difference. Lower is better.
      const brightDiff = Math.abs(starChars.avgBrightness - learnedChar.avgBrightness) / learnedChar.avgBrightness;
      const contrastDiff = Math.abs(starChars.avgContrast - learnedChar.avgContrast) / (learnedChar.avgContrast + 1e-6);
      const fwhmDiff = Math.abs(starChars.fwhm - learnedChar.fwhm) / (learnedChar.fwhm + 1e-6);
      const sizeDiff = Math.abs(starChars.pixelCount - learnedChar.pixelCount) / learnedChar.pixelCount;
      
      const score = 1 - (0.4 * brightDiff + 0.3 * fwhmDiff + 0.2 * contrastDiff + 0.1 * sizeDiff);

      if (score > bestScore) {
        bestScore = score;
      }
    }
  }
  return bestScore;
}
