
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

function getTriangleSignature(p1: Star, p2: Star, p3: Star) {
    const d12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const d23 = Math.hypot(p3.x - p2.x, p3.y - p2.y);
    const d31 = Math.hypot(p1.x - p3.x, p1.y - p3.y);
    const sides = [d12, d23, d31].sort((a,b)=>a-b);
    if(sides[0] < 1e-6) return null;
    // Return ratio of sides to make it scale-invariant
    return [sides[1] / sides[0], sides[2] / sides[0]];
}


/**
 * Finds the most consistent geometric pattern (triangle) of stars across multiple images.
 */
function findGeometricConsensus(
    allImageRankedStars: { imageId: string; rankedStars: { star: Star; probability: number; }[] }[],
    addLog: (message: string) => void
): { refPair: Star[]; targetPairs: Record<string, Star[]>; imageIds: string[] } | null {
    if (allImageRankedStars.length < 2) {
        addLog("[CONSENSUS] Need at least 2 images to find a consensus.");
        return null;
    }

    const refImage = allImageRankedStars[0];
    const refStars = refImage.rankedStars.map(rs => rs.star);
    if (refStars.length < 3) {
        addLog(`[CONSENSUS] Reference image '${refImage.imageId}' has fewer than 3 AI-verified stars.`);
        return null;
    }

    let bestMatch = {
        count: 0,
        refTriangle: null as Star[] | null,
        targetTriangles: {} as Record<string, Star[]>
    };

    const SIGNATURE_TOLERANCE = 0.05; // 5% tolerance for side ratios

    // Iterate through all possible triangles in the reference image
    for (let i = 0; i < refStars.length; i++) {
        for (let j = i + 1; j < refStars.length; j++) {
            for (let k = j + 1; k < refStars.length; k++) {
                const refTriangle = [refStars[i], refStars[j], refStars[k]];
                const refSignature = getTriangleSignature(...refTriangle);
                if (!refSignature) continue;

                let currentMatchCount = 1;
                const currentTargetTriangles: Record<string, Star[]> = { [refImage.imageId]: refTriangle };

                // Look for this triangle in other images
                for (let imgIdx = 1; imgIdx < allImageRankedStars.length; imgIdx++) {
                    const targetImage = allImageRankedStars[imgIdx];
                    const targetStars = targetImage.rankedStars.map(rs => rs.star);
                    if (targetStars.length < 3) continue;

                    let foundMatchInImage = false;
                    for (let ti = 0; ti < targetStars.length && !foundMatchInImage; ti++) {
                        for (let tj = ti + 1; tj < targetStars.length && !foundMatchInImage; tj++) {
                            for (let tk = tj + 1; tk < targetStars.length && !foundMatchInImage; tk++) {
                                const targetTriangle = [targetStars[ti], targetStars[tj], targetStars[tk]];
                                const targetSignature = getTriangleSignature(...targetTriangle);
                                if (!targetSignature) continue;

                                const error1 = Math.abs(refSignature[0] - targetSignature[0]);
                                const error2 = Math.abs(refSignature[1] - targetSignature[1]);

                                if (error1 < SIGNATURE_TOLERANCE && error2 < SIGNATURE_TOLERANCE) {
                                    currentMatchCount++;
                                    currentTargetTriangles[targetImage.imageId] = targetTriangle;
                                    foundMatchInImage = true;
                                }
                            }
                        }
                    }
                }
                
                if (currentMatchCount > bestMatch.count) {
                    bestMatch = {
                        count: currentMatchCount,
                        refTriangle: refTriangle,
                        targetTriangles: currentTargetTriangles
                    };
                }
            }
        }
    }

    if (bestMatch.count < 2) {
        addLog("[CONSENSUS] Could not find a common geometric pattern across at least 2 images.");
        return null;
    }

    addLog(`[CONSENSUS] Found a common pattern of 3 stars across ${bestMatch.count} images.`);
    
    // Convert the triangles back to pairs for the existing transform logic
    const imageIds = Object.keys(bestMatch.targetTriangles);
    const refPair = [bestMatch.refTriangle![0], bestMatch.refTriangle![1]];
    const targetPairs: Record<string, Star[]> = {};
    for (const id of imageIds) {
        targetPairs[id] = [bestMatch.targetTriangles[id][0], bestMatch.targetTriangles[id][1]];
    }

    return { refPair, targetPairs, imageIds };
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
  
  // 1. Get AI-ranked stars for all images
  addLog("[CONSENSUS] Step 1: Getting AI-ranked star candidates for all images...");
  const allImageRankedStars: { imageId: string; rankedStars: { star: Star; probability: number; }[] }[] = [];

  for (const [index, entry] of imageEntries.entries()) {
    if (!entry.imageData) continue;

    let starsToConsider: Star[] = entry.detectedStars;

    if (modelPackage) {
        const { data, width, height } = entry.imageData;
        const { rankedStars, logs } = await findMatchingStars({
            imageData: { data: Array.from(data), width, height },
            candidates: starsToConsider,
            model: modelPackage.model,
            normalization: modelPackage.normalization,
        });
        logs.forEach(logMsg => addLog(`[AI-DETECT] ${entry.file.name}: ${logMsg}`));

        if (rankedStars && rankedStars.length > 0) {
            allImageRankedStars.push({ imageId: entry.id, rankedStars });
        } else {
            addLog(`[AI-DETECT] No probable stars found for ${entry.file.name}.`);
        }
    } else {
        // If no AI model, create a dummy ranking based on brightness
        const rankedStars = entry.detectedStars
            .sort((a, b) => b.brightness - a.brightness)
            .map(star => ({ star, probability: star.brightness / 1000 })); // Normalize brightness as pseudo-probability
        allImageRankedStars.push({ imageId: entry.id, rankedStars });
        addLog(`[CONSENSUS] No AI model. Using ${entry.detectedStars.length} detected stars for ${entry.file.name}.`);
    }
    
    setProgress(0.3 * ((index + 1) / imageEntries.length));
  }

  if (allImageRankedStars.length < 2) {
      throw new Error("Fewer than two images have enough stars for consensus alignment.");
  }
  
  // 2. Find the best geometrically consistent set of stars
  addLog("[CONSENSUS] Step 2: Finding the most common geometric star pattern...");
  const globalConsensus = findGeometricConsensus(allImageRankedStars, addLog);

  if (!globalConsensus) {
      throw new Error("Consensus alignment failed: Could not find a reliable star pattern shared across multiple images.");
  }
  
  const { refPair, targetPairs, imageIds } = globalConsensus;
  
  const refImageId = Object.keys(targetPairs)[0];
  const refEntry = imageEntries.find(e => e.id === refImageId)!;
  const { width, height } = refEntry.analysisDimensions;

  setProgress(0.5);

  // 3. Align and collect image data for the images that were part of the consensus
  addLog(`[CONSENSUS] Step 3: Aligning ${imageIds.length} images that contain the common pattern.`);
  const alignedImageDatas: (Uint8ClampedArray | null)[] = [];

  for (let i = 0; i < imageEntries.length; i++) {
    const entry = imageEntries[i];
    const progress = 0.5 + (0.4 * (i + 1) / imageEntries.length);
    
    if (!imageIds.includes(entry.id) || !entry.imageData || !entry.imageData.data) {
        addLog(`[CONSENSUS] Excluding ${entry.file.name}: Not part of the geometric consensus.`);
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
  const validImagesToStack = alignedImageDatas.filter(d => d !== null);
  addLog(`[CONSENSUS] Step 4: Stacking ${validImagesToStack.length} images with mode: ${stackingMode}.`);
  setProgress(0.99);

  if (validImagesToStack.length < 2) {
      throw new Error("Consensus Stacking failed: Fewer than 2 images remained after filtering for the common pattern.");
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
