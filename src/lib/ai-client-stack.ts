
// @ts-nocheck
'use client';

import type { StackingMode, Transform } from '@/lib/astro-align';
import { findMatchingStars, type LearnedPattern } from '@/lib/ai-star-matcher';
import type { Star } from '@/lib/astro-align';
import { detectStarsAI } from './ai-star-detection';

// This type definition is duplicated from page.tsx to avoid circular dependencies.
interface ImageQueueEntry {
  id: string;
  file: File;
  previewUrl: string;
  isAnalyzing: boolean;
  isAnalyzed: boolean;
  analysisDimensions: { width: number; height: number };
  imageData: ImageData | null;
  detectedStars: Star[];
}


/**
 * Calculates the transformation required to align two point sets.
 * Solves for the similarity transform (translation, rotation, scale).
 */
function getTransformFromStarPair(refStar1: Star, refStar2: Star, targetStar1: Star, targetStar2: Star): Transform | null {
    if (!refStar1 || !refStar2 || !targetStar1 || !targetStar2) {
        return null;
    }

    // Vectors from star1 to star2
    const refVec = { x: refStar2.x - refStar1.x, y: refStar2.y - refStar1.y };
    const targetVec = { x: targetStar2.x - targetStar1.x, y: targetStar2.y - targetStar1.y };

    // Angle of each vector
    const refAngle = Math.atan2(refVec.y, refVec.x);
    const targetAngle = Math.atan2(targetVec.y, targetVec.x);
    let angle = targetAngle - refAngle;

    // Scale from the lengths of the vectors
    const refDist = Math.sqrt(refVec.x * refVec.x + refVec.y * refVec.y);
    const targetDist = Math.sqrt(targetVec.x * targetVec.x + targetVec.y * targetVec.y);

    if (refDist === 0) return null;
    let scale = targetDist / refDist;
    if (scale === 0) return null;

    const cosAngle = Math.cos(-angle);
    const sinAngle = Math.sin(-angle);
    const rotatedTargetX = targetStar1.x * cosAngle - targetStar1.y * sinAngle;
    const rotatedTargetY = targetStar1.x * sinAngle + targetStar1.y * cosAngle;

    const dx = refStar1.x - rotatedTargetX * scale;
    const dy = refStar1.y - rotatedTargetY * scale;

    return { dx, dy, angle: -angle, scale };
}

/**
 * Given a set of reference stars and target stars, finds the best pair that exists in both sets.
 * "Best" is defined as the pair with the most similar geometric relationship (distance, angle).
 */
function findBestSharedStarPair(refStars: Star[], targetStars: Star[], addLog: (message: string) => void): { refPair: Star[], targetPair: Star[] } | null {
    if (refStars.length < 2 || targetStars.length < 2) {
        addLog("[PAIR-FIND] Not enough stars in one of the sets to find a pair.");
        return null;
    }

    let bestMatch = {
        refPair: null,
        targetPair: null,
        error: Infinity
    };
    
    // Iterate through all possible pairs in the reference set
    for (let i = 0; i < refStars.length; i++) {
        for (let j = i + 1; j < refStars.length; j++) {
            const refPair = [refStars[i], refStars[j]];
            const refDistSq = (refPair[1].x - refPair[0].x)**2 + (refPair[1].y - refPair[0].y)**2;
            const refAngle = Math.atan2(refPair[1].y - refPair[0].y, refPair[1].x - refPair[0].x);

            // Now find the best corresponding pair in the target set
            for (let k = 0; k < targetStars.length; k++) {
                for (let l = k + 1; l < targetStars.length; l++) {
                    const targetPair = [targetStars[k], targetStars[l]];
                    const targetDistSq = (targetPair[1].x - targetPair[0].x)**2 + (targetPair[1].y - targetPair[0].y)**2;
                    const targetAngle = Math.atan2(targetPair[1].y - targetPair[0].y, targetPair[1].x - targetPair[0].x);

                    // Compare normalized distance and angle difference
                    const distError = Math.abs(targetDistSq - refDistSq) / refDistSq; // Normalized distance error
                    const angleError = Math.abs(targetAngle - refAngle) / (2 * Math.PI); // Normalized angle error
                    
                    const totalError = distError + angleError; // Simple error metric

                    if (totalError < bestMatch.error) {
                        bestMatch = { refPair, targetPair, error: totalError };
                    }

                    // Check the swapped target pair as well
                    const targetPairSwapped = [targetStars[l], targetStars[k]];
                    const targetAngleSwapped = Math.atan2(targetPairSwapped[1].y - targetPairSwapped[0].y, targetPairSwapped[1].x - targetPairSwapped[0].x);
                    const angleErrorSwapped = Math.abs(targetAngleSwapped - refAngle) / (2 * Math.PI);
                    const totalErrorSwapped = distError + angleErrorSwapped;

                    if (totalErrorSwapped < bestMatch.error) {
                        bestMatch = { refPair, targetPair: targetPairSwapped, error: totalErrorSwapped };
                    }
                }
            }
        }
    }
    
    const ACCEPTABLE_ERROR_THRESHOLD = 0.1; // Heuristic: 10% tolerance for combined error
    if (bestMatch.refPair && bestMatch.error < ACCEPTABLE_ERROR_THRESHOLD) {
        addLog(`[PAIR-FIND] Found best matching pair with error score: ${bestMatch.error.toFixed(4)}`);
        return { refPair: bestMatch.refPair, targetPair: bestMatch.targetPair };
    }

    addLog(`[PAIR-FIND] No reliable star pair found. Best error score (${bestMatch.error.toFixed(4)}) exceeded threshold.`);
    return null;
}


/**
 * Warps an image using a similarity transform (translation, rotation, scale).
 * Uses bilinear interpolation for smoother results.
 */
function warpImage(
    srcData: Uint8ClampedArray,
    srcWidth: number,
    srcHeight: number,
    transform: Transform
): Uint8ClampedArray {
    const dstData = new Uint8ClampedArray(srcData.length);
    const { dx, dy, angle, scale } = transform;

    if (scale === 0) return dstData; 

    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);
    
    const invScale = 1 / scale;

    for (let y = 0; y < srcHeight; y++) {
        for (let x = 0; x < srcWidth; x++) {
            
            const x1 = x - dx;
            const y1 = y - dy;

            const x2 = x1 * invScale;
            const y2 = y1 * invScale;

            const srcX = x2 * cosAngle + y2 * sinAngle;
            const srcY = -x2 * sinAngle + y2 * cosAngle;

            const x_floor = Math.floor(srcX);
            const y_floor = Math.floor(srcY);
            const x_ceil = x_floor + 1;
            const y_ceil = y_floor + 1;
            
            if (x_floor < 0 || x_ceil >= srcWidth || y_floor < 0 || y_ceil >= srcHeight) {
                continue; 
            }
            
            const x_ratio = srcX - x_floor;
            const y_ratio = srcY - y_floor;

            const dstIdx = (y * srcWidth + x) * 4;

            for (let channel = 0; channel < 4; channel++) {
                 const c00 = srcData[(y_floor * srcWidth + x_floor) * 4 + channel];
                 const c10 = srcData[(y_floor * srcWidth + x_ceil) * 4 + channel];
                 const c01 = srcData[(y_ceil * srcWidth + x_floor) * 4 + channel];
                 const c11 = srcData[(y_ceil * srcWidth + x_ceil) * 4 + channel];

                 if (c00 === undefined || c10 === undefined || c01 === undefined || c11 === undefined) continue;

                 const c_x0 = c00 * (1 - x_ratio) + c10 * x_ratio;
                 const c_x1 = c01 * (1 - x_ratio) + c11 * x_ratio;

                 dstData[dstIdx + channel] = c_x0 * (1 - y_ratio) + c_x1 * y_ratio;
            }
             if (dstData[dstIdx+3] === 0 && (dstData[dstIdx] > 0 || dstData[dstIdx+1] > 0 || dstData[dstIdx+2] > 0)) {
              dstData[dstIdx+3] = 255;
            }
        }
    }
    return dstData;
}


// --- STACKING IMPLEMENTATIONS ---

function stackImagesAverage(images: (Uint8ClampedArray | null)[]): Uint8ClampedArray {
    const validImages = images.filter((img): img is Uint8ClampedArray => img !== null);
    if (validImages.length === 0) throw new Error("No valid images to stack");
    const length = validImages[0].length;
    const accum = new Float32Array(length);
    const counts = new Uint8Array(length / 4);

    for (const img of validImages) {
        for (let i = 0; i < length; i += 4) {
            if (img[i+3] > 128) {
                accum[i] += img[i];
                accum[i + 1] += img[i + 1];
                accum[i + 2] += img[i + 2];
                counts[i / 4]++;
            }
        }
    }

    const result = new Uint8ClampedArray(length);
    for (let i = 0; i < length; i += 4) {
        const count = counts[i / 4];
        if (count > 0) {
            result[i] = accum[i] / count;
            result[i + 1] = accum[i + 1] / count;
            result[i + 2] = accum[i + 2] / count;
            result[i + 3] = 255;
        }
    }
    return result;
}

function stackImagesMedian(images: (Uint8ClampedArray | null)[]): Uint8ClampedArray {
    const validImages = images.filter((img): img is Uint8ClampedArray => img !== null);
    if (validImages.length === 0) throw new Error("No valid images to stack");
    const length = validImages[0].length;
    const result = new Uint8ClampedArray(length);
    
    for (let i = 0; i < length; i += 4) {
        const r: number[] = [], g: number[] = [], b: number[] = [];
        for (const img of validImages) {
            if (img[i + 3] > 128) {
                r.push(img[i]);
                g.push(img[i+1]);
                b.push(img[i+2]);
            }
        }

        if (r.length > 0) {
            r.sort((a, b) => a - b);
            g.sort((a, b) => a - b);
            b.sort((a, b) => a - b);
            const mid = Math.floor(r.length / 2);
            result[i] = r.length % 2 !== 0 ? r[mid] : (r[mid - 1] + r[mid]) / 2;
            result[i + 1] = g.length % 2 !== 0 ? g[mid] : (g[mid - 1] + g[mid]) / 2;
            result[i + 2] = b.length % 2 !== 0 ? b[mid] : (b[mid - 1] + b[mid]) / 2;
            result[i + 3] = 255;
        }
    }
    return result;
}

function stackImagesSigmaClip(images: (Uint8ClampedArray | null)[], sigma = 2.0): Uint8ClampedArray {
    const validImages = images.filter((img): img is Uint8ClampedArray => img !== null);
    if (validImages.length === 0) throw new Error("No valid images to stack");
    const length = validImages[0].length;
    const result = new Uint8ClampedArray(length);

    for (let i = 0; i < length; i += 4) {
        let hasData = false;
        for (let channel = 0; channel < 3; channel++) {
            const pixelValues: number[] = [];
            for (const img of validImages) {
                if (img[i + 3] > 128) {
                    pixelValues.push(img[i + channel]);
                }
            }

            if (pixelValues.length === 0) continue;
            hasData = true;

            if (pixelValues.length < 3) {
                 result[i + channel] = pixelValues.reduce((a, b) => a + b, 0) / pixelValues.length;
                 continue;
            }
            
            const sum = pixelValues.reduce((a,b) => a+b, 0);
            const mean = sum / pixelValues.length;
            const stdev = Math.sqrt(pixelValues.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / pixelValues.length);

            if (stdev === 0) {
                 result[i + channel] = mean;
                 continue;
            }

            const threshold = sigma * stdev;
            const filtered = pixelValues.filter(v => Math.abs(v - mean) < threshold);
            
            if (filtered.length > 0) {
                result[i + channel] = filtered.reduce((a, b) => a + b, 0) / filtered.length;
            } else { // If all pixels are outliers, use median
                 pixelValues.sort((a,b) => a-b);
                 const mid = Math.floor(pixelValues.length / 2);
                 result[i + channel] = pixelValues.length % 2 !== 0 ? pixelValues[mid] : (pixelValues[mid - 1] + pixelValues[mid]) / 2;
            }
        }
        if (hasData) {
            result[i + 3] = 255;
        }
    }
    return result;
}


// --- MAIN AI ALIGNMENT & STACKING FUNCTION ---
export async function aiClientAlignAndStack(
  imageEntries: ImageQueueEntry[],
  learnedPatterns: LearnedPattern[],
  mode: StackingMode,
  addLog: (message: string) => void,
  setProgress: (progress: number) => void
): Promise<Uint8ClampedArray> {
  addLog("[AI-CLIENT] Starting AI-guided client-side stacking.");
  if (imageEntries.length === 0 || !imageEntries[0].imageData) {
    throw new Error("No valid images provided for stacking.");
  }
  
  const refEntry = imageEntries[0];
  const { width, height } = refEntry.analysisDimensions;

  // Find reference stars using AI
  addLog(`[AI-CLIENT] Finding reference stars in ${refEntry.file.name} using AI patterns.`);
  const aiDetectedRefStars = detectStarsAI(refEntry.imageData, width, height, 50);

  const { matchedStars: refStars, logs: refLogs } = await findMatchingStars({
      allDetectedStars: aiDetectedRefStars,
      imageData: { data: Array.from(refEntry.imageData.data), width, height },
      learnedPatterns
  });
  refLogs.forEach(log => addLog(`[AI-REF] ${log}`));

  if (refStars.length < 2) {
      throw new Error(`AI alignment failed: Found only ${refStars.length} matching stars in the reference image. At least 2 are required.`);
  }
  addLog(`[AI-CLIENT] Found ${refStars.length} reference stars candidates.`);

  const alignedImageDatas: (Uint8ClampedArray | null)[] = [refEntry.imageData.data];
  
  for (let i = 1; i < imageEntries.length; i++) {
    const targetEntry = imageEntries[i];
    const progress = (i + 1) / imageEntries.length;
    addLog(`--- Aligning Image ${i+1}/${imageEntries.length}: ${targetEntry.file.name} ---`);

    if (!targetEntry.imageData) {
      alignedImageDatas.push(null);
      setProgress(progress);
      addLog(`[AI-CLIENT] Skipping ${targetEntry.file.name}: missing image data.`);
      continue;
    }

    addLog(`[AI-CLIENT] Finding target stars in ${targetEntry.file.name}`);
    const aiDetectedTargetStars = detectStarsAI(targetEntry.imageData, width, height, 50);
    const { matchedStars: targetStars, logs: targetLogs } = await findMatchingStars({
        allDetectedStars: aiDetectedTargetStars,
        imageData: { data: Array.from(targetEntry.imageData.data), width, height },
        learnedPatterns
    });
    targetLogs.forEach(log => addLog(`[AI-TGT] ${log}`));

    if (targetStars.length < 2) {
        alignedImageDatas.push(null);
        setProgress(progress);
        addLog(`[AI-CLIENT] Skipping ${targetEntry.file.name}: Found only ${targetStars.length} matching stars.`);
        continue;
    }
    addLog(`[AI-CLIENT] Found ${targetStars.length} target star candidates for ${targetEntry.file.name}.`);
    
    const sharedPair = findBestSharedStarPair(refStars, targetStars, addLog);

    if (!sharedPair) {
        alignedImageDatas.push(null);
        setProgress(progress);
        addLog(`[AI-CLIENT] Skipping ${targetEntry.file.name}: Could not find a reliable shared star pair.`);
        continue;
    }

    const [ref1, ref2] = sharedPair.refPair;
    const [target1, target2] = sharedPair.targetPair;
    const transform = getTransformFromStarPair(ref1, ref2, target1, target2);


    if (!transform) {
        alignedImageDatas.push(null);
        setProgress(progress);
        addLog(`[AI-CLIENT] Skipping ${targetEntry.file.name}: Could not compute transform from shared pair.`);
        continue;
    }
    addLog(`[AI-CLIENT] Transform for ${targetEntry.file.name}: scale=${transform.scale.toFixed(3)}, angle=${(transform.angle*180/Math.PI).toFixed(2)}°, dx=${transform.dx.toFixed(2)}, dy=${transform.dy.toFixed(2)}`);
    
    const warpedData = warpImage(targetEntry.imageData.data, width, height, transform);
    alignedImageDatas.push(warpedData);
    
    setProgress(progress);
  }

  addLog(`[AI-CLIENT] All images processed. Stacking with mode: ${mode}...`);
  setProgress(1);

  switch (mode) {
    case 'median':
        return stackImagesMedian(alignedImageDatas);
    case 'sigma':
        return stackImagesSigmaClip(alignedImageDatas);
    case 'average':
    default:
        return stackImagesAverage(alignedImageDatas);
  }
}
