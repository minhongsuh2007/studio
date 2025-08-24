
'use client';

import type { Star, StackingMode, Transform, ImageQueueEntry } from '@/lib/astro-align';
import { warpImage, stackImagesAverage, stackImagesMedian, stackImagesSigmaClip, stackImagesLaplacian } from '@/lib/astro-align';
import type * as tf from '@tensorflow/tfjs';
import { findMatchingStars } from './ai-star-matcher';

interface ModelPackage {
    model: tf.LayersModel;
    normalization: {
        means: number[];
        stds: number[];
    };
}


/**
 * Detects the brightest pixels in an image. Starts with a threshold of 255
 * and lowers it until at least 25 pixels are found.
 */
function detectBrightestPixels(imageData: ImageData, addLog: (message: string) => void, fileName: string): Star[] {
    const { data, width } = imageData;
    let stars: Star[] = [];
    let threshold = 255;
    const minThreshold = 200; // Stop if threshold gets too low to avoid performance issues

    while (stars.length < 25 && threshold >= minThreshold) {
        stars = []; // Reset for each new threshold attempt
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] >= threshold && data[i + 1] >= threshold && data[i + 2] >= threshold) {
                const x = (i / 4) % width;
                const y = Math.floor((i / 4) / width);
                stars.push({
                    x,
                    y,
                    brightness: (data[i] + data[i+1] + data[i+2])/3,
                    size: 1,
                });
            }
        }
        
        if (stars.length < 25) {
            threshold--;
        }
    }
    addLog(`[DUMB-DETECT] Found ${stars.length} pixels in ${fileName} at threshold ${threshold}.`);
    return stars;
}


/**
 * Calculates the transformation required to align two point sets.
 */
function getTransform(refPoints: Star[], targetPoints: Star[]): Transform | null {
    if (refPoints.length < 2 || targetPoints.length < 2) return null;
    
    // Use the first two points to get an initial transform
    const refStar1 = refPoints[0];
    const refStar2 = refPoints[1];
    const targetStar1 = targetPoints[0];
    const targetStar2 = targetPoints[1];

    const refVec = { x: refStar2.x - refStar1.x, y: refStar2.y - refStar1.y };
    const targetVec = { x: targetStar2.x - targetStar1.x, y: targetStar2.y - targetStar1.y };

    const refAngle = Math.atan2(refVec.y, refVec.x);
    const targetAngle = Math.atan2(targetVec.y, targetVec.x);
    let angle = targetAngle - refAngle;

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

// Generates a scale-invariant signature for a quadrilateral.
function getQuadSignature(p1: Star, p2: Star, p3: Star, p4: Star): number[] | null {
    const d = (a: Star, b: Star) => Math.hypot(b.x - a.x, b.y - a.y);
    const sides = [d(p1, p2), d(p2, p3), d(p3, p4), d(p4, p1)];
    const diagonals = [d(p1, p3), d(p2, p4)];
    
    const allLengths = [...sides, ...diagonals].sort((a,b)=>a-b);
    const primaryLength = allLengths[allLengths.length - 1]; // Use longest length for normalization
    if (primaryLength < 1e-6) return null;

    return allLengths.map(len => len / primaryLength);
}


/**
 * Finds the most common pattern of 4 bright pixels across all images.
 */
function findBestGlobalPattern(
    allImageStars: { imageId: string; stars: Star[] }[],
    addLog: (message: string) => void
): { refPattern: Star[]; targetPatterns: Record<string, Star[]>; imageIds: string[] } | null {
    if (allImageStars.length < 2) {
        addLog("[DUMB-ALIGN] Need at least 2 images to find a global pattern.");
        return null;
    }

    const refImage = allImageStars.find(img => img.stars.length >= 4);
    if (!refImage) {
        addLog("[DUMB-ALIGN] No image has at least 4 bright pixels to form a reference pattern.");
        return null;
    }
    
    const refStars = refImage.stars;
    addLog(`[DUMB-ALIGN] Using ${refImage.imageId} as reference with ${refStars.length} candidates.`);

    let bestMatch = {
        count: 0,
        refPattern: null as Star[] | null,
        targetPatterns: {} as Record<string, Star[]>,
    };

    const SIGNATURE_TOLERANCE = 0.05; // 5% tolerance
    const MAX_REF_PATTERNS = 100; // Limit iterations to prevent freezing

    // Iterate through a limited number of possible patterns in the reference image
    for (let i = 0; i < Math.min(refStars.length, MAX_REF_PATTERNS); i++) {
        for (let j = i + 1; j < refStars.length; j++) {
            for (let k = j + 1; k < refStars.length; k++) {
                for (let l = k + 1; l < refStars.length; l++) {
                    
                    const refPattern = [refStars[i], refStars[j], refStars[k], refStars[l]];
                    const refSignature = getQuadSignature(...refPattern);
                    if (!refSignature) continue;

                    let currentMatchCount = 1;
                    const currentTargetPatterns: Record<string, Star[]> = { [refImage.imageId]: refPattern };

                    // Check this pattern against all other images
                    for (const targetImage of allImageStars) {
                        if (targetImage.imageId === refImage.imageId) continue;
                        if (targetImage.stars.length < 4) continue;

                        let bestTargetMatch: { pattern: Star[], error: number } | null = null;
                        
                        // Find the best matching pattern in the target image
                        for (let ti = 0; ti < targetImage.stars.length; ti++) {
                        for (let tj = ti + 1; tj < targetImage.stars.length; tj++) {
                        for (let tk = tj + 1; tk < targetImage.stars.length; tk++) {
                        for (let tl = tk + 1; tl < targetImage.stars.length; tl++) {
                            const targetPattern = [targetImage.stars[ti], targetImage.stars[tj], targetImage.stars[tk], targetImage.stars[tl]];
                            const targetSignature = getQuadSignature(...targetPattern);
                            if (!targetSignature) continue;

                            const error = refSignature.reduce((sum, val, idx) => sum + Math.abs(val - targetSignature[idx]), 0);

                            if (error / refSignature.length < SIGNATURE_TOLERANCE) {
                                if (!bestTargetMatch || error < bestTargetMatch.error) {
                                    bestTargetMatch = { pattern: targetPattern, error: error };
                                }
                            }
                        }}}}

                        if (bestTargetMatch) {
                            currentTargetPatterns[targetImage.imageId] = bestTargetMatch.pattern;
                            currentMatchCount++;
                        }
                    }
                    
                    if (currentMatchCount > bestMatch.count) {
                        bestMatch = {
                            count: currentMatchCount,
                            refPattern: refPattern,
                            targetPatterns: currentTargetPatterns
                        };
                    }
                }
            }
        }
    }


    if (bestMatch.count < 2) {
        addLog("[DUMB-ALIGN] Could not find a 4-pixel pattern shared by at least 2 images.");
        return null;
    }

    const imageIdsWithPattern = Object.keys(bestMatch.targetPatterns);
    addLog(`[DUMB-ALIGN] Found best pattern of 4 pixels, shared across ${bestMatch.count} images.`);
    return {
        refPattern: bestMatch.refPattern!,
        targetPatterns: bestMatch.targetPatterns,
        imageIds: imageIdsWithPattern
    };
}

async function getAiVerifiedPixels(
    entry: ImageQueueEntry,
    modelPackage: ModelPackage,
    addLog: (msg: string) => void
): Promise<Star[]> {
    if (!entry.imageData) return [];
    
    addLog(`[DUMB-AI] AI verifying pixels for ${entry.file.name}...`);
    
    // 1. Get initial bright pixel candidates
    const candidates = detectBrightestPixels(entry.imageData, addLog, entry.file.name);
    if (candidates.length === 0) return [];

    // 2. Group nearby pixels into clusters
    const clusters: Star[][] = [];
    const visited = new Set<Star>();
    const CLUSTER_RADIUS = 5;

    for (const cand of candidates) {
        if (visited.has(cand)) continue;

        const cluster = [cand];
        visited.add(cand);

        for (const otherCand of candidates) {
            if (!visited.has(otherCand)) {
                const dist = Math.hypot(cand.x - otherCand.x, cand.y - otherCand.y);
                if (dist < CLUSTER_RADIUS) {
                    cluster.push(otherCand);
                    visited.add(otherCand);
                }
            }
        }
        clusters.push(cluster);
    }
    addLog(`[DUMB-AI] Grouped ${candidates.length} pixels into ${clusters.length} local clusters.`);

    // 3. For each cluster, ask AI to pick the best one
    const aiVerifiedStars: Star[] = [];
    const {data, width, height} = entry.imageData;

    for (const cluster of clusters) {
        if (cluster.length === 1) {
            // If only one pixel in cluster, still verify it with AI
            const { rankedStars } = await findMatchingStars({
                imageData: { data: Array.from(data), width, height },
                candidates: cluster,
                model: modelPackage.model,
                normalization: modelPackage.normalization,
            });
            if (rankedStars && rankedStars.length > 0 && rankedStars[0].probability > 0.1) {
                aiVerifiedStars.push(rankedStars[0].star);
            }

        } else {
             const { rankedStars } = await findMatchingStars({
                imageData: { data: Array.from(data), width, height },
                candidates: cluster,
                model: modelPackage.model,
                normalization: modelPackage.normalization,
            });

            // Add the top-ranked star from the cluster if it exists
            if (rankedStars && rankedStars.length > 0) {
                aiVerifiedStars.push(rankedStars[0].star);
            }
        }
    }
    
    addLog(`[DUMB-AI] AI selected ${aiVerifiedStars.length} final candidates from clusters.`);
    return aiVerifiedStars;
}


// --- MAIN DUMB ALIGNMENT & STACKING FUNCTION ---
export async function dumbAlignAndStack({
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
    addLog("[DUMB-ALIGN] Starting dumb alignment based on brightest pixels.");
    if (imageEntries.length < 2) {
        throw new Error("Dumb stacking requires at least two images.");
    }

    addLog("[DUMB-ALIGN] Step 1: Detecting candidate pixels in all images...");
    const allImageBrightPixels: { imageId: string; stars: Star[] }[] = [];

    for(const [index, entry] of imageEntries.entries()) {
        let pixels: Star[];
        if (modelPackage) {
            pixels = await getAiVerifiedPixels(entry, modelPackage, addLog);
        } else {
            if (!entry.imageData) {
                 pixels = [];
            } else {
                 pixels = detectBrightestPixels(entry.imageData, addLog, entry.file.name);
            }
        }
        if (pixels.length >= 4) {
            allImageBrightPixels.push({ imageId: entry.id, stars: pixels });
        }
        setProgress(0.3 * ((index + 1) / imageEntries.length));
    }


    if (allImageBrightPixels.length < 2) {
        throw new Error("Fewer than two images have at least 4 candidate pixels for alignment.");
    }

    addLog("[DUMB-ALIGN] Step 2: Finding the most common bright pixel pattern (4 pixels)...");
    const globalPattern = findBestGlobalPattern(allImageBrightPixels, addLog);

    if (!globalPattern) {
        throw new Error("Dumb alignment failed: Could not find a reliable 4-pixel pattern shared across multiple images.");
    }

    const { refPattern, targetPatterns, imageIds } = globalPattern;
    const refImageId = imageIds[0];
    const refEntry = imageEntries.find(e => e.id === refImageId)!;
    const { width, height } = refEntry.analysisDimensions;

    setProgress(0.5);

    addLog(`[DUMB-ALIGN] Step 3: Aligning ${imageIds.length} images that contain the common pattern.`);
    const alignedImageDatas: (Uint8ClampedArray | null)[] = [];

    for (let i = 0; i < imageEntries.length; i++) {
        const entry = imageEntries[i];
        const progress = 0.5 + (0.4 * (i + 1) / imageEntries.length);

        if (!imageIds.includes(entry.id) || !entry.imageData) {
            alignedImageDatas.push(null);
            setProgress(progress);
            continue;
        }

        if (entry.id === refEntry.id) {
            alignedImageDatas.push(entry.imageData.data);
            setProgress(progress);
            continue;
        }

        const transform = getTransform(refPattern, targetPatterns[entry.id]);

        if (!transform) {
            alignedImageDatas.push(null);
            setProgress(progress);
            continue;
        }

        const warpedData = warpImage(entry.imageData.data, width, height, transform);
        alignedImageDatas.push(warpedData);
        setProgress(progress);
    }

    const validImagesToStack = alignedImageDatas.filter(d => d !== null);
    addLog(`[DUMB-ALIGN] Step 4: Stacking ${validImagesToStack.length} images with mode: ${stackingMode}.`);
    setProgress(0.99);

    if (validImagesToStack.length < 2) {
        throw new Error("Dumb Stacking failed: Fewer than 2 images remained after alignment.");
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
    addLog("[DUMB-ALIGN] Stacking complete.");
    return stackedResult;
}
