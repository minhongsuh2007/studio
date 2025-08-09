
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


// --- New Star Matching Logic ---

function isCandidateBlob(imageData: SimpleImageData, x: number, y: number): boolean {
    const { data, width, height } = imageData;
    const radius = 1; // For a 3x3 patch

    for (let j = -radius; j <= radius; j++) {
        for (let i = -radius; i <= radius; i++) {
            const px = x + i;
            const py = y + j;

            if (px < 0 || px >= width || py < 0 || py >= height) {
                return false; // Out of bounds
            }
            
            const idx = (py * width + px) * 4;
            if (data[idx] < 200 || data[idx + 1] < 200 || data[idx + 2] < 200) {
                return false; // Condition not met
            }
        }
    }
    return true; // All pixels in 3x3 are > 200
}

function isStarByBrightnessRelationship(imageData: SimpleImageData, grayData: Uint8Array, x: number, y: number): boolean {
    const { width } = imageData;
    const centerIdx = y * width + x;
    const centerBrightness = grayData[centerIdx];

    let surroundingBrightnessSum = 0;
    let count = 0;
    const radius = 1;

    for (let j = -radius; j <= radius; j++) {
        for (let i = -radius; i <= radius; i++) {
            if (i === 0 && j === 0) continue;
            
            const px = x + i;
            const py = y + j;
            const pIdx = py * width + px;
            surroundingBrightnessSum += grayData[pIdx];
            count++;
        }
    }

    const avgSurroundingBrightness = surroundingBrightnessSum / count;

    // A real star should be significantly brighter than its immediate surroundings.
    // And surroundings should not be completely black (avoids single hot pixels).
    return centerBrightness > avgSurroundingBrightness * 1.1 && avgSurroundingBrightness > 10;
}


export async function findMatchingStars({
  imageData,
  learnedPatterns, // This is kept for API compatibility but not used in the new logic
}: {
  imageData: SimpleImageData,
  learnedPatterns: LearnedPattern[],
}): Promise<{matchedStars: Star[], logs: string[]}> {
  const logs: string[] = [];
  try {
    logs.push("Starting new 2-step star detection logic.");
    const { data, width, height } = imageData;
    
    const grayData = toGrayscale(imageData);
    if (!grayData) {
        logs.push("Error: Failed to convert image to grayscale.");
        return { matchedStars: [], logs };
    }
    
    const finalStars: Star[] = [];
    const visited = new Uint8Array(width * height);

    // Iterate through each pixel, but skip borders
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = y * width + x;
            if (visited[idx]) continue;

            // Step 1: Find strong candidates where a 3x3 patch is very bright
            if (isCandidateBlob(imageData, x, y)) {
                // Mark the 3x3 area as visited to avoid re-checking adjacent pixels of the same blob
                for (let j = -1; j <= 1; j++) {
                    for (let i = -1; i <= 1; i++) {
                        visited[(y + j) * width + (x + i)] = 1;
                    }
                }

                // Step 2: Refine with brightness relationship check
                if (isStarByBrightnessRelationship(imageData, grayData, x, y)) {
                    // We found a likely star. For now, treat its properties simply.
                    // A more advanced version could do a center-of-mass calculation here.
                    const brightness = grayData[idx];
                    finalStars.push({
                        x: x,
                        y: y,
                        brightness: brightness,
                        size: 1, // Placeholder size
                    });
                }
            }
        }
    }
    
    logs.push(`Detection complete. Found ${finalStars.length} stars.`);
    
    // Sort by brightness to keep the API consistent
    finalStars.sort((a, b) => b.brightness - a.brightness);
    
    return { matchedStars: finalStars, logs };

  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    logs.push(`CRASH in findMatchingStars! ${errorMessage}`);
    console.error("Error in findMatchingStars:", e);
    throw new Error(`A critical error occurred in findMatchingStars: ${errorMessage}`);
  }
}
