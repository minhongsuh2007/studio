
// @ts-nocheck
'use client';

// This file is deprecated as of the latest changes.
// The AI alignment logic has been reverted to use the standard 2-star alignment for reliability.
// This file is kept to avoid breaking potential imports but is no longer actively used in the stacking pipeline.

import type * as tf from '@tensorflow/tfjs';
import type { StackingMode, Transform } from '@/lib/astro-align';
import { findMatchingStars } from '@/lib/ai-star-matcher';
import type { Star } from '@/lib/astro-align';
import { detectBrightBlobs } from './astro-align';

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

interface ModelPackage {
    model: tf.LayersModel;
    normalization: {
        means: number[],
        stds: number[]
    }
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
    const refDist = Math.hypot(refVec.x, refVec.y);
    const targetDist = Math.hypot(targetVec.x, targetVec.y);

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
 * Given sets of stars from multiple images, finds the pair of stars that is most commonly shared.
 */
function findBestGlobalPair(allImageStars: { imageId: string; stars: Star[] }[], addLog: (message: string) => void): { refPair: Star[]; targetPairs: Record<string, Star[]>; imageIds: string[] } | null {
    if (allImageStars.length < 2) {
        addLog("[GLOBAL-PAIR] Need at least 2 images to find a global pair.");
        return null;
    }

    const refImageStars = allImageStars[0].stars;
    if (refImageStars.length < 2) {
        addLog("[GLOBAL-PAIR] Reference image has fewer than 2 candidate stars.");
        return null;
    }
    
    let bestPairInfo = {
        refPair: null as Star[] | null,
        targetPairs: {} as Record<string, Star[]>,
        count: 0
    };

    const DIST_TOLERANCE = 0.05; // 5% tolerance for distance mismatch
    const ANGLE_TOLERANCE_RAD = 0.05; // ~2.8 degrees tolerance

    // Iterate through all possible pairs in the reference image
    for (let i = 0; i < refImageStars.length; i++) {
        for (let j = i + 1; j < refImageStars.length; j++) {
            const currentRefPair = [refImageStars[i], refImageStars[j]];
            const refDist = Math.hypot(currentRefPair[1].x - currentRefPair[0].x, currentRefPair[1].y - currentRefPair[0].y);
            const refAngle = Math.atan2(currentRefPair[1].y - currentRefPair[0].y, currentRefPair[1].x - currentRefPair[0].x);

            let currentTargetPairs: Record<string, Star[]> = { [allImageStars[0].imageId]: currentRefPair };
            let matchCount = 1;

            // Check this pair against all other images
            for (let k = 1; k < allImageStars.length; k++) {
                const targetImage = allImageStars[k];
                if (targetImage.stars.length < 2) continue;
                
                let bestTargetMatch: { pair: Star[], error: number } | null = null;

                // Find the best matching pair in the target image
                for (let m = 0; m < targetImage.stars.length; m++) {
                    for (let n = m + 1; n < targetImage.stars.length; n++) {
                        const checkPairs = [ [targetImage.stars[m], targetImage.stars[n]], [targetImage.stars[n], targetImage.stars[m]] ];
                        
                        for (const targetPair of checkPairs) {
                            const targetDist = Math.hypot(targetPair[1].x - targetPair[0].x, targetPair[1].y - targetPair[0].y);
                            const targetAngle = Math.atan2(targetPair[1].y - targetPair[0].y, targetPair[1].x - targetPair[0].x);

                            const distError = Math.abs(targetDist - refDist) / refDist;
                            const angleError = Math.abs(targetAngle - refAngle);

                            if (distError < DIST_TOLERANCE && angleError < ANGLE_TOLERANCE_RAD) {
                                const totalError = distError + angleError / ANGLE_TOLERANCE_RAD; // Normalized error
                                if (!bestTargetMatch || totalError < bestTargetMatch.error) {
                                    bestTargetMatch = { pair: targetPair, error: totalError };
                                }
                            }
                        }
                    }
                }

                if (bestTargetMatch) {
                    currentTargetPairs[targetImage.imageId] = bestTargetMatch.pair;
                    matchCount++;
                }
            }
            
            // If this pair is found in more images than the previous best, update it
            if (matchCount > bestPairInfo.count) {
                bestPairInfo = { refPair: currentRefPair, targetPairs: currentTargetPairs, count: matchCount };
            }
        }
    }

    if (bestPairInfo.count < 2) {
        addLog(`[GLOBAL-PAIR] Could not find a star pair shared by at least 2 images. Aborting.`);
        return null;
    }
    
    const imageIdsWithPair = Object.keys(bestPairInfo.targetPairs);
    addLog(`[GLOBAL-PAIR] Found best pair, shared across ${bestPairInfo.count} images: [${imageIdsWithPair.join(', ')}]`);
    return {
        refPair: bestPairInfo.refPair!,
        targetPairs: bestPairInfo.targetPairs,
        imageIds: imageIdsWithPair
    };
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
  modelPackage: ModelPackage,
  mode: StackingMode,
  addLog: (message: string) => void,
  setProgress: (progress: number) => void
): Promise<Uint8ClampedArray> {
  addLog("[AI-CLIENT] Starting global consensus AI stacking.");
  if (imageEntries.length < 2) {
    throw new Error("AI stacking requires at least two images.");
  }
  
  // 1. Find candidate stars in ALL images first using the TFJS model
  const allImageStars: { imageId: string; stars: Star[] }[] = [];
  addLog("[AI-CLIENT] Step 1: Generating candidates and verifying with AI model...");
  for (const entry of imageEntries) {
      if (!entry.imageData) continue;
      
      const { width, height } = entry.analysisDimensions;
      
      let finalStars: Star[] = [];
      let currentProbThreshold = 0.8;
      
      const initialCandidates = detectBrightBlobs(entry.imageData, width, height);

      while(finalStars.length < 10 && currentProbThreshold >= 0.1) {
          addLog(`[AI-MATCH] ${entry.file.name}: Verifying ${initialCandidates.length} candidates with threshold ${currentProbThreshold.toFixed(2)}...`);
          
          const { matchedStars, logs } = await findMatchingStars({
              imageData: { data: Array.from(entry.imageData.data), width, height },
              candidates: initialCandidates,
              model: modelPackage.model,
              normalization: modelPackage.normalization,
              probabilityThreshold: currentProbThreshold
          });

          logs.forEach(logMsg => addLog(`[AI-MATCH] ${entry.file.name}: ${logMsg}`));

          finalStars = matchedStars;
          if (finalStars.length < 10) {
              currentProbThreshold -= 0.1;
          } else {
              break;
          }
      }

      const topStars = finalStars.sort((a, b) => b.brightness - a.brightness);
      
      if (topStars.length > 1) {
          allImageStars.push({ imageId: entry.id, stars: topStars });
          addLog(`[AI-CLIENT] Image ${entry.file.name}: Finalized with ${topStars.length} AI-verified stars (Threshold: ${currentProbThreshold.toFixed(2)}).`);
      } else {
        addLog(`[AI-CLIENT] Image ${entry.file.name} has < 2 AI-verified stars, excluding from pair search.`);
      }
      setProgress(0.25 * ((imageEntries.indexOf(entry) + 1) / imageEntries.length)); // 25% of progress for this stage
  }
  
  // 2. Find the best globally shared pair of stars
  addLog("[AI-CLIENT] Step 2: Finding the most common star pair across all images.");
  const globalPairInfo = findBestGlobalPair(allImageStars, addLog);

  if (!globalPairInfo) {
      throw new Error("AI alignment failed: Could not find a reliable star pair shared across multiple images.");
  }
  
  const { refPair, targetPairs, imageIds } = globalPairInfo;
  const refEntry = imageEntries.find(e => e.id === imageIds[0]);
  if (!refEntry) {
      throw new Error("Could not find the reference image entry for the global pair.");
  }

  // 3. Align and collect image data for the images that share the global pair
  addLog(`[AI-CLIENT] Step 3: Aligning ${imageIds.length} images that contain the global pair.`);
  const alignedImageDatas: (Uint8ClampedArray | null)[] = [];
  const refImageInPair = imageEntries.find(e => e.id === Object.keys(targetPairs)[0]);
  alignedImageDatas.push(refImageInPair!.imageData!.data); // The first image is the reference

  for (let i = 0; i < imageEntries.length; i++) {
    const entry = imageEntries[i];
    const progress = 0.25 + (0.5 * (i + 1) / imageEntries.length); // This stage is 50% of progress
    
    if (!imageIds.includes(entry.id) || !entry.imageData) {
        addLog(`[AI-CLIENT] Discarding ${entry.file.name}: does not contain the global star pair.`);
        setProgress(progress);
        continue;
    }

    if (entry.id === refImageInPair!.id) { // It's the reference, already added
        addLog(`[AI-CLIENT] Using ${entry.file.name} as alignment reference.`);
        setProgress(progress);
        continue;
    }
    
    const [ref1, ref2] = refPair;
    const [target1, target2] = targetPairs[entry.id];
    const transform = getTransformFromStarPair(ref1, ref2, target1, target2);

    if (!transform) {
        addLog(`[AI-CLIENT] Discarding ${entry.file.name}: failed to compute transform.`);
        setProgress(progress);
        continue;
    }
    
    addLog(`[AI-CLIENT] Aligning ${entry.file.name}...`);
    const { width, height } = entry.analysisDimensions;
    const warpedData = warpImage(entry.imageData.data, width, height, transform);
    alignedImageDatas.push(warpedData);
    setProgress(progress);
  }

  // 4. Stack the aligned images
  addLog(`[AI-CLIENT] Step 4: Stacking ${alignedImageDatas.length} images with mode: ${mode}.`);
  setProgress(0.99);

  if (alignedImageDatas.length < 2) {
      throw new Error("AI Stacking failed: Fewer than 2 images remained after filtering for the global pair.");
  }

  let stackedResult;
  switch (mode) {
    case 'median':
        stackedResult = stackImagesMedian(alignedImageDatas);
        break;
    case 'sigma':
        stackedResult = stackImagesSigmaClip(alignedImageDatas);
        break;
    case 'average':
    default:
        stackedResult = stackImagesAverage(alignedImageDatas);
        break;
  }
  setProgress(1);
  addLog("[AI-CLIENT] Stacking complete.");
  return stackedResult;
}
