
'use server';

import type { Star } from './astro-align';
import { detectStarsAI } from './ai-star-detection';
import { detectStars } from './astro-align';

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
    data: number[] | Uint8ClampedArray;
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


// --- Cross-Validation Star Matching ---

function findMatchesByRatio(allDetectedStars: Star[], imageData: SimpleImageData, grayData: Uint8Array, learnedPatterns: LearnedPattern[], tolerance: number): Star[] {
    const matchedStars: Star[] = [];
    const getBrightness = (rgb: [number, number, number]) => 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    
    for (const star of allDetectedStars) {
        const starChars = getStarCharacteristics(star, imageData, grayData);
        if (!starChars) continue;
        
        for (const pattern of learnedPatterns) {
            for (const learnedChar of pattern.characteristics) {
                const starCenterBrightness = getBrightness(starChars.centerRGB);
                const star3x3Brightness = getBrightness(starChars.patch3x3RGB);
                
                const learnedCenterBrightness = getBrightness(learnedChar.centerRGB);
                const learned3x3Brightness = getBrightness(learnedChar.patch3x3RGB);
                
                if (learnedCenterBrightness === 0 || learned3x3Brightness === 0) continue;
                
                const starRatio = starCenterBrightness / (star3x3Brightness + 1e-6);
                const learnedRatio = learnedCenterBrightness / (learned3x3Brightness + 1e-6);
                
                const ratioDiff = Math.abs(starRatio - learnedRatio) / learnedRatio;

                if (ratioDiff < tolerance) {
                    matchedStars.push(star);
                    break;
                }
            }
            if (matchedStars.some(s => s === star)) break;
        }
    }
    return matchedStars;
}

function findMatchesByRelationship(allDetectedStars: Star[], imageData: SimpleImageData, grayData: Uint8Array, learnedPatterns: LearnedPattern[], tolerance: number): Star[] {
    const matchedStars: Star[] = [];
    const getBrightness = (rgb: [number, number, number]) => 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    const rgbDistance = (c1: [number, number, number], c2: [number, number, number]) => Math.sqrt((c1[0] - c2[0])**2 + (c1[1] - c2[1])**2 + (c1[2] - c2[2])**2);
    
    for (const star of allDetectedStars) {
        const starChars = getStarCharacteristics(star, imageData, grayData);
        if (!starChars) continue;
        
        for (const pattern of learnedPatterns) {
            for (const learnedChar of pattern.characteristics) {
                // Brightness relationship
                const starBrightnessDiff = getBrightness(starChars.centerRGB) - getBrightness(starChars.patch3x3RGB);
                const learnedBrightnessDiff = getBrightness(learnedChar.centerRGB) - getBrightness(learnedChar.patch3x3RGB);
                const brightnessRelationshipError = Math.abs(starBrightnessDiff - learnedBrightnessDiff) / (Math.abs(learnedBrightnessDiff) + 10);
                
                // Color relationship
                const starColorDiff = rgbDistance(starChars.centerRGB, starChars.patch3x3RGB);
                const learnedColorDiff = rgbDistance(learnedChar.centerRGB, learnedChar.patch3x3RGB);
                const colorRelationshipError = Math.abs(starColorDiff - learnedColorDiff) / (learnedColorDiff + 10);
                
                if (brightnessRelationshipError < tolerance && colorRelationshipError < tolerance) {
                    matchedStars.push(star);
                    break; 
                }
            }
            if (matchedStars.some(s => s === star)) break;
        }
    }
    return matchedStars;
}


export async function findMatchingStars({
  imageData,
  learnedPatterns,
}: {
  imageData: SimpleImageData,
  learnedPatterns: LearnedPattern[],
}): Promise<{matchedStars: Star[], logs: string[]}> {
  const logs: string[] = [];
  try {
    logs.push(`Starting cross-validation match process with ${learnedPatterns.length} patterns.`);
    if (learnedPatterns.length === 0) return { matchedStars: [], logs };
    
    const grayData = toGrayscale(imageData);
    if (!grayData) {
        logs.push("Error: Failed to convert image to grayscale.");
        return { matchedStars: [], logs };
    }
    
    const allDetectedForAI = detectStarsAI(imageData as ImageData, imageData.width, imageData.height, 50);

    let tolerance = 0.1;
    let finalStars: Star[] = [];

    while (finalStars.length < 10) {
        logs.push(`Attempting cross-validation with tolerance ${tolerance.toFixed(2)}`);

        // Method 1: Standard non-AI detection
        const standardStars = detectStars(imageData as ImageData, imageData.width, imageData.height, 60);

        // Method 2: AI Ratio-based matching
        const ratioStars = findMatchesByRatio(allDetectedForAI, imageData, grayData, learnedPatterns, tolerance * 2);

        // Method 3: AI Relationship-based matching (2-stage filter)
        const relationshipStars = findMatchesByRelationship(allDetectedForAI, imageData, grayData, learnedPatterns, tolerance);

        logs.push(`Found: Standard(${standardStars.length}), Ratio(${ratioStars.length}), Relationship(${relationshipStars.length})`);

        // Find intersection of all three methods
        const standardStarSet = new Set(standardStars.map(s => `${Math.round(s.x)},${Math.round(s.y)}`));
        const ratioStarSet = new Set(ratioStars.map(s => `${Math.round(s.x)},${Math.round(s.y)}`));
        
        finalStars = relationshipStars.filter(s => {
            const key = `${Math.round(s.x)},${Math.round(s.y)}`;
            return standardStarSet.has(key) && ratioStarSet.has(key);
        });

        if (finalStars.length >= 10) {
            logs.push(`Cross-validation successful. Found ${finalStars.length} stars common to all 3 methods.`);
            break;
        }

        // Loosen tolerance for the next attempt
        tolerance *= 1.5; 
        logs.push(`Found ${finalStars.length} stars. Loosening tolerance and retrying.`);
    }

    return { matchedStars: finalStars, logs };

  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    logs.push(`CRASH in findMatchingStars! ${errorMessage}`);
    console.error("Error in findMatchingStars:", e);
    throw new Error(`A critical error occurred in findMatchingStars: ${errorMessage}`);
  }
}
