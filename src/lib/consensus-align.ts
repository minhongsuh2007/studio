
'use client';

import type { Star, StackingMode, Transform } from '@/lib/astro-align';
import { warpImage, stackImagesAverage, stackImagesMedian, stackImagesSigmaClip, stackImagesLaplacian, detectBrightBlobs } from '@/lib/astro-align';
import type * as tf from '@tensorflow/tfjs';
import { findMatchingStars } from './ai-star-matcher';

// This type definition is duplicated from page.tsx to avoid circular dependencies.
interface ImageQueueEntry {
  id: string;
  file: File;
  imageData: ImageData | null;
  detectedStars: Star[];
  analysisDimensions: { width: number; height: number; };
  aiVerifiedStars?: Star[];
};

interface ModelPackage {
    model: tf.LayersModel;
    normalization: {
        means: number[];
        stds: number[];
    };
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
    
    // To align target1 to ref1 after rotation and scaling:
    const rotatedTargetX = targetStar1.x * cosAngle - targetStar1.y * sinAngle;
    const rotatedTargetY = targetStar1.x * sinAngle + targetStar1.y * cosAngle;

    const dx = refStar1.x - rotatedTargetX * scale;
    const dy = refStar1.y - rotatedTargetY * scale;

    return { dx, dy, angle: -angle, scale };
}

/**
 * Given sets of stars from multiple images, finds the pair of stars that is most commonly shared.
 */
function findBestGlobalPair(
  allImageStars: { imageId: string; stars: Star[] }[],
  addLog: (message: string) => void
): { refPair: Star[]; targetPairs: Record<string, Star[]>; imageIds: string[] } | null {
    if (allImageStars.length < 2) {
        addLog("[CONSENSUS] Need at least 2 images to find a global pair.");
        return null;
    }

    const refImage = allImageStars[0];
    const refImageStars = refImage.stars.sort((a,b) => b.brightness - a.brightness).slice(0, 50);

    if (refImageStars.length < 2) {
        addLog("[CONSENSUS] Reference image has fewer than 2 candidate stars.");
        return null;
    }
    
    let bestPairInfo = {
        refPair: null as Star[] | null,
        targetPairs: {} as Record<string, Star[]>,
        count: 0
    };

    const DIST_TOLERANCE = 0.05; // 5% tolerance for distance mismatch

    // Iterate through all possible pairs in the reference image
    for (let i = 0; i < refImageStars.length; i++) {
        for (let j = i + 1; j < refImageStars.length; j++) {
            const currentRefPair = [refImageStars[i], refImageStars[j]];
            const refDist = Math.hypot(currentRefPair[1].x - currentRefPair[0].x, currentRefPair[1].y - currentRefPair[0].y);

            let currentTargetPairs: Record<string, Star[]> = { [refImage.imageId]: currentRefPair };
            let matchCount = 1;

            // Check this pair against all other images
            for (let k = 1; k < allImageStars.length; k++) {
                const targetImage = allImageStars[k];
                const targetStars = targetImage.stars.sort((a,b) => b.brightness - a.brightness).slice(0, 50);

                if (targetStars.length < 2) continue;
                
                let bestTargetMatch: { pair: Star[], error: number } | null = null;

                // Find the best matching pair in the target image
                for (let m = 0; m < targetStars.length; m++) {
                    for (let n = m + 1; n < targetStars.length; n++) {
                        // Check both orderings of the pair
                        const checkPairs: [Star, Star][] = [ [targetStars[m], targetStars[n]], [targetStars[n], targetStars[m]] ];
                        
                        for (const targetPair of checkPairs) {
                            const targetDist = Math.hypot(targetPair[1].x - targetPair[0].x, targetPair[1].y - targetPair[0].y);
                            const distError = Math.abs(targetDist - refDist) / refDist;

                            if (distError < DIST_TOLERANCE) {
                                if (!bestTargetMatch || distError < bestTargetMatch.error) {
                                    bestTargetMatch = { pair: targetPair, error: distError };
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
            
            if (matchCount > bestPairInfo.count) {
                bestPairInfo = { refPair: currentRefPair, targetPairs: currentTargetPairs, count: matchCount };
            }
        }
    }

    if (bestPairInfo.count < 2) {
        addLog(`[CONSENSUS] Could not find a star pair shared by at least 2 images. Aborting.`);
        return null;
    }
    
    const imageIdsWithPair = Object.keys(bestPairInfo.targetPairs);
    addLog(`[CONSENSUS] Found best pair, shared across ${bestPairInfo.count} images.`);
    return {
        refPair: bestPairInfo.refPair!,
        targetPairs: bestPairInfo.targetPairs,
        imageIds: imageIdsWithPair
    };
}


// --- MAIN CONSENSUS ALIGNMENT & STACKING FUNCTION ---
export async function consensusAlignAndStack({
    imageEntries,
    stackingMode,
    modelPackage,
    addLog,
    setProgress,
}: {
    imageEntries: ImageQueueEntry[];
    stackingMode: StackingMode;
    modelPackage?: ModelPackage;
    addLog: (message: string) => void;
    setProgress: (progress: number) => void;
}): Promise<Uint8ClampedArray> {
  addLog("[CONSENSUS] Starting global consensus stacking.");
  if (imageEntries.length < 2) {
    throw new Error("Consensus stacking requires at least two images.");
  }
  
  // 1. Get stars for all images. Prioritize AI-verified stars if available.
  addLog("[CONSENSUS] Verifying stars for alignment...");
  let allImageStars: { imageId: string, stars: Star[] }[] = [];

  for (const [index, entry] of imageEntries.entries()) {
    if (!entry.imageData) continue;

    let starsForAlignment: Star[] = [];

    if (modelPackage) {
        const { data, width, height } = entry.imageData;
        const { rankedStars, logs } = await findMatchingStars({
            imageData: { data: Array.from(data), width, height },
            candidates: entry.detectedStars,
            model: modelPackage.model,
            normalization: modelPackage.normalization,
        });
        logs.forEach(logMsg => addLog(`[AI-DETECT] ${entry.file.name}: ${logMsg}`));

        // Automatically take the top 10 most probable stars
        starsForAlignment = rankedStars.slice(0, 10).map(rs => rs.star);
        entry.aiVerifiedStars = starsForAlignment; // Store for potential display
        addLog(`[CONSENSUS] Using top ${starsForAlignment.length} AI-verified stars for ${entry.file.name}.`);

    } else {
        starsForAlignment = entry.detectedStars;
        addLog(`[CONSENSUS] No AI model. Using ${entry.detectedStars.length} detected stars for ${entry.file.name}.`);
    }
    
    if (starsForAlignment.length > 1) {
        allImageStars.push({ imageId: entry.id, stars: starsForAlignment });
    }
    setProgress(0.2 * ((index + 1) / imageEntries.length));
  }

  if (allImageStars.length < 2) {
      throw new Error("Fewer than two images have enough detected stars for consensus alignment.");
  }

  
  // 2. Find the best globally shared pair of stars
  addLog("[CONSENSUS] Finding the most common star pair across all images...");
  const globalPairInfo = findBestGlobalPair(allImageStars, addLog);

  if (!globalPairInfo) {
      throw new Error("Consensus alignment failed: Could not find a reliable star pair shared across multiple images.");
  }
  
  const { refPair, targetPairs, imageIds } = globalPairInfo;
  
  const refImageId = Object.keys(targetPairs)[0];
  const refEntry = imageEntries.find(e => e.id === refImageId)!;
  const { width, height } = refEntry.analysisDimensions;

  setProgress(0.4);

  // 3. Align and collect image data for the images that share the global pair
  addLog(`[CONSENSUS] Aligning ${imageIds.length} images that contain the global star pair.`);
  const alignedImageDatas: (Uint8ClampedArray | null)[] = [];

  for (let i = 0; i < imageEntries.length; i++) {
    const entry = imageEntries[i];
    const progress = 0.4 + (0.5 * (i + 1) / imageEntries.length);
    
    // Ensure the image is part of the consensus set and has valid data
    if (!imageIds.includes(entry.id) || !entry.imageData || !entry.imageData.data) {
        if (imageIds.includes(entry.id)) {
             addLog(`[CONSENSUS] Discarding ${entry.file.name}: does not have valid image data despite being in consensus set.`);
        }
        alignedImageDatas.push(null);
        setProgress(progress);
        continue;
    }

    if (entry.id === refEntry.id) {
        alignedImageDatas.push(entry.imageData.data);
        addLog(`[CONSENSUS] Using ${entry.file.name} as alignment reference.`);
        setProgress(progress);
        continue;
    }
    
    const [ref1, ref2] = refPair;
    const [target1, target2] = targetPairs[entry.id];
    const transform = getTransformFromStarPair(ref1, ref2, target1, target2);

    if (!transform) {
        addLog(`[CONSENSUS] Discarding ${entry.file.name}: failed to compute transform.`);
        alignedImageDatas.push(null);
        setProgress(progress);
        continue;
    }
    
    addLog(`[CONSENSUS] Aligning ${entry.file.name}...`);
    const { width, height } = entry.analysisDimensions;
    const warpedData = warpImage(entry.imageData.data, width, height, transform);
    alignedImageDatas.push(warpedData);
    setProgress(progress);
  }

  // 4. Stack the aligned images
  addLog(`[CONSENSUS] Stacking ${alignedImageDatas.filter(d => d !== null).length} images with mode: ${stackingMode}.`);
  setProgress(0.99);

  if (alignedImageDatas.filter(d => d !== null).length < 2) {
      throw new Error("Consensus Stacking failed: Fewer than 2 images remained after filtering for the global pair.");
  }

  let stackedResult;
  switch (stackingMode) {
    case 'median':
        stackedResult = stackImagesMedian(alignedImageDatas);
        break;
    case 'sigma':
        stackedResult = stackImagesSigmaClip(alignedImageDatas);
        break;
    case 'laplacian':
        stackedResult = stackImagesLaplacian(alignedImageDatas, width, height);
        break;
    case 'average':
    default:
        stackedResult = stackImagesAverage(alignedImageDatas);
        break;
  }
  setProgress(1);
  addLog("[CONSENSUS] Stacking complete.");
  return stackedResult;
}
