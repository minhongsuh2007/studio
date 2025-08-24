
'use client';

import type { Star } from './astro-align';
import * as tf from '@tensorflow/tfjs';

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


// --- New Star Matching Logic with TFJS ---

function mean(arr: number[]) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function featuresFromCharacteristics(c: StarCharacteristics): number[] {
    const f_centerRGB = mean(c.centerRGB || []);
    const f_patch3 = mean(c.patch3x3RGB || []);
    const f_patch5 = mean(c.patch5x5RGB || []);
    return [
        c.avgBrightness ?? 0,
        c.avgContrast ?? 0,
        c.fwhm ?? 0,
        c.pixelCount ?? 0,
        f_centerRGB,
        f_patch3,
        f_patch5,
    ];
}


export function buildModel(): tf.LayersModel {
    const model = tf.sequential();
    model.add(tf.layers.dense({ inputShape: [7], units: 32, activation: 'relu' }));
    model.add(tf.layers.dropout({ rate: 0.2 }));
    model.add(tf.layers.dense({ units: 16, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));
    return model;
}

export function predictSingle(model: tf.LayersModel, means: number[], stds: number[], features: number[]): number {
  const norm = features.map((v, j) => (v - means[j]) / (stds[j] || 1));
  const input = tf.tensor2d([norm]);
  const p = model.predict(input) as tf.Tensor;
  const prob = p.dataSync()[0];
  tf.dispose([input, p]);
  return prob;
}

export async function findMatchingStars({
  imageData,
  candidates,
  model,
  normalization,
  probabilityThreshold = 0.5,
}: {
  imageData: SimpleImageData,
  candidates: Star[],
  model: tf.LayersModel,
  normalization: { means: number[], stds: number[] },
  probabilityThreshold?: number,
}): Promise<{matchedStars: Star[], logs: string[]}> {
    const logs: string[] = [];
    try {
        if (candidates.length === 0) {
            logs.push("No initial candidates provided.");
            return { matchedStars: [], logs };
        }

        logs.push(`Received ${candidates.length} candidates to verify with AI.`);

        // 1. Extract features for all candidates
        const allCharacteristics = (await extractCharacteristicsFromImage({ stars: candidates, imageData }))
            .map((char, index) => ({ char, star: candidates[index] }))
            .filter(item => item.char);

        // 2. Predict with the model
        const matchedStars: Star[] = [];
        for (const { char, star } of allCharacteristics) {
            const features = featuresFromCharacteristics(char!);
            const probability = predictSingle(model, normalization.means, normalization.stds, features);
            if (probability > probabilityThreshold) {
                matchedStars.push(star);
            }
        }

        logs.push(`AI classified ${matchedStars.length} candidates as stars with >${(probabilityThreshold*100).toFixed(0)}% confidence.`);

        matchedStars.sort((a, b) => b.brightness - a.brightness);
        return { matchedStars, logs };

    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        logs.push(`CRASH in findMatchingStars! ${errorMessage}`);
        console.error("Error in findMatchingStars:", e);
        throw new Error(`A critical error occurred in findMatchingStars: ${errorMessage}`);
    }
}
