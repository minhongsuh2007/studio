
'use server';

import type { Star } from './astro-align';

export interface StarCharacteristics {
  avgBrightness: number;
  avgContrast: number;
  fwhm: number;
  pixelCount: number;
  centerRGB: [number, number, number];
  patch3x3RGB: [number, number, number];
  patch5x5RGB: [number, number, number];
}

export interface LearnedPattern {
  id: string; 
  timestamp: number;
  sourceImageIds: string[];
  characteristics: StarCharacteristics[];
}

export interface SimpleImageData {
    data: number[];
    width: number;
    height: number;
}

function getPatchRgb(
    imageData: SimpleImageData, 
    centerX: number, 
    centerY: number, 
    patchSize: number
): [number, number, number] | null {
    const { data, width, height } = imageData;
    const radius = Math.floor(patchSize / 2);
    
    let sumR = 0, sumG = 0, sumB = 0;
    let count = 0;

    const startX = Math.round(centerX) - radius;
    const startY = Math.round(centerY) - radius;

    for (let j = 0; j < patchSize; j++) {
        for (let i = 0; i < patchSize; i++) {
            const px = startX + i;
            const py = startY + j;

            if (px >= 0 && px < width && py >= 0 && py < height) {
                if (radius > 0 && i === radius && j === radius) continue; // Exclude center for surrounding patches

                const idx = (py * width + px) * 4;
                sumR += data[idx];
                sumG += data[idx + 1];
                sumB += data[idx + 2];
                count++;
            }
        }
    }

    if (count === 0) return null;
    return [sumR / count, sumG / count, sumB / count];
}

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

function getStarCharacteristics(star: Star, imageData: SimpleImageData, grayData: Uint8Array): StarCharacteristics | null {
  try {
    const { width } = imageData;
    const { x, y } = star;
    
    const startX = Math.round(x) - 3;
    const startY = Math.round(y) - 3;

    const pixels: number[] = [];
    let sumBrightness = 0;
    let peakBrightness = 0;

    for (let j = 0; j < 7; j++) {
      for (let i = 0; i < 7; i++) {
        const px = startX + i;
        const py = startY + j;
        if (px >= 0 && px < imageData.width && py >= 0 && py < imageData.height) {
          const idx = py * width + px;
          const brightness = grayData[idx];
          pixels.push(brightness);
          sumBrightness += brightness;
          if (brightness > peakBrightness) peakBrightness = brightness;
        }
      }
    }

    if (pixels.length === 0) return null;
    const avgBrightness = sumBrightness / pixels.length;
    if (avgBrightness === 0) return null;
    
    const sumSqDiff = pixels.reduce((sum, p) => sum + (p - avgBrightness) ** 2, 0);
    const stdDev = Math.sqrt(sumSqDiff / pixels.length);
    const avgContrast = stdDev / (avgBrightness + 1e-6);

    const halfMax = peakBrightness / 2;
    const brightPixels = pixels.filter(p => p > halfMax);
    const fwhm = brightPixels.length > 0 ? Math.sqrt(brightPixels.length / Math.PI) * 2 : 0;

    const centerIdx = (Math.round(y) * width + Math.round(x)) * 4;
    const centerRGB: [number, number, number] = [imageData.data[centerIdx], imageData.data[centerIdx+1], imageData.data[centerIdx+2]];
    const patch3x3RGB = getPatchRgb(imageData, x, y, 3);
    const patch5x5RGB = getPatchRgb(imageData, x, y, 5);

    if (!patch3x3RGB || !patch5x5RGB) return null;

    return {
      avgBrightness,
      avgContrast,
      fwhm,
      pixelCount: star.size > 0 ? star.size : brightPixels.length,
      centerRGB,
      patch3x3RGB,
      patch5x5RGB,
    };
  } catch (e) {
    return null;
  }
}

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

export async function findMatchingStars({
  allDetectedStars,
  imageData,
  learnedPatterns,
}: {
  allDetectedStars: Star[],
  imageData: SimpleImageData,
  learnedPatterns: LearnedPattern[],
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

    let matchedStars: Star[] = [];
    let brightnessTolerance = 0.2; // Start with a strict 20%
    let rgbTolerance = 0.15; // Start with a strict 15%
    const MAX_BRIGHTNESS_TOLERANCE = 0.8;
    const MAX_RGB_TOLERANCE = 0.7;
    let attempts = 0;

    while (matchedStars.length < 10 && attempts < 10) {
      matchedStars = []; // Reset for each attempt
      logs.push(`[AI-MATCH] Attempt #${attempts + 1}: Finding matches with Brightness Tolerance=${(brightnessTolerance*100).toFixed(0)}%, RGB Tolerance=${(rgbTolerance*100).toFixed(0)}%`);

      for (const star of allDetectedStars) {
          const starChars = getStarCharacteristics(star, imageData, grayData);
          if (!starChars) continue;
          
          if (compareCharacteristics(starChars, learnedPatterns, brightnessTolerance, rgbTolerance)) {
              matchedStars.push(star);
          }
      }

      if (matchedStars.length < 10) {
        brightnessTolerance = Math.min(MAX_BRIGHTNESS_TOLERANCE, brightnessTolerance * 1.5);
        rgbTolerance = Math.min(MAX_RGB_TOLERANCE, rgbTolerance * 1.5);
      }
      attempts++;
    }


    logs.push(`[findMatchingStars] Found ${matchedStars.length} stars matching the patterns after ${attempts} attempt(s).`);
    return { matchedStars, logs };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    logs.push(`[findMatchingStars] CRASH! ${errorMessage}`);
    console.error("Error in findMatchingStars:", e);
    throw new Error(`A critical error occurred in findMatchingStars: ${errorMessage}`);
  }
}

function compareCharacteristics(
  starChars: StarCharacteristics,
  learnedPatterns: LearnedPattern[],
  brightnessTolerance: number,
  rgbTolerance: number
): boolean {
  const getBrightness = (rgb: [number, number, number]) => 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  const rgbDistance = (c1: [number, number, number], c2: [number, number, number]) => {
      const total1 = c1[0] + c1[1] + c1[2] + 1e-6;
      const total2 = c2[0] + c2[1] + c2[2] + 1e-6;
      const r1 = c1[0] / total1, g1 = c1[1] / total1;
      const r2 = c2[0] / total2, g2 = c2[1] / total2;
      return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2);
  };

  const starCenterBrightness = getBrightness(starChars.centerRGB);
  const star3x3Brightness = getBrightness(starChars.patch3x3RGB);
  const star5x5Brightness = getBrightness(starChars.patch5x5RGB);

  for (const pattern of learnedPatterns) {
    for (const learnedChar of pattern.characteristics) {
      // --- Stage 1: Brightness Filtering ---
      const learnedCenterBrightness = getBrightness(learnedChar.centerRGB);
      const learned3x3Brightness = getBrightness(learnedChar.patch3x3RGB);
      const learned5x5Brightness = getBrightness(learnedChar.patch5x5RGB);

      const centerBrightDiff = Math.abs(starCenterBrightness - learnedCenterBrightness) / (learnedCenterBrightness + 1e-6);
      const bright3x3Diff = Math.abs(star3x3Brightness - learned3x3Brightness) / (learned3x3Brightness + 1e-6);
      const bright5x5Diff = Math.abs(star5x5Brightness - learned5x5Brightness) / (learned5x5Brightness + 1e-6);

      if (centerBrightDiff > brightnessTolerance || bright3x3Diff > brightnessTolerance || bright5x5Diff > brightnessTolerance) {
        continue; // Failed brightness test
      }

      // --- Stage 2: Color Filtering ---
      const centerRgbDiff = rgbDistance(starChars.centerRGB, learnedChar.centerRGB);
      const patch3RgbDiff = rgbDistance(starChars.patch3x3RGB, learnedChar.patch3x3RGB);
      const patch5RgbDiff = rgbDistance(starChars.patch5x5RGB, learnedChar.patch5x5RGB);

      if (centerRgbDiff > rgbTolerance || patch3RgbDiff > rgbTolerance || patch5RgbDiff > rgbTolerance) {
          continue; // Failed color test
      }
      
      // If both tests passed for any learned characteristic, it's a match.
      return true;
    }
  }
  return false;
}
