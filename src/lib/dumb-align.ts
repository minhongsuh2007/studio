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

function findBestGlobalLines(
    allImagePixels: { imageId: string; stars: Star[] }[],
    addLog: (message: string) => void
): { refPoints: Star[]; targetPoints: Record<string, Star[]>; imageIds: string[] } | null {
    if (allImagePixels.length < 2) {
        addLog("[DUMB-PATTERN] Need at least 2 images.");
        return null;
    }

    const findBestLine = (candidates: { imageId: string; stars: Star[] }[]) => {
        const refImage = candidates.find(c => c.stars.length > 1);
        if (!refImage) return null;

        const refPixels = refImage.stars;
        let bestMatch = {
            count: 0,
            refPair: null as Star[] | null,
            targetPairs: {} as Record<string, Star[]>,
            length: 0,
        };

        const DISTANCE_TOLERANCE = 5; // Pixel distance tolerance

        for (let i = 0; i < refPixels.length; i++) {
            for (let j = i + 1; j < refPixels.length; j++) {
                const refPair = [refPixels[i], refPixels[j]];
                const refDist = Math.hypot(refPair[1].x - refPair[0].x, refPair[1].y - refPair[0].y);

                let currentMatchCount = 1;
                const currentTargetPairs: Record<string, Star[]> = { [refImage.imageId]: refPair };

                for (const targetImage of candidates) {
                    if (targetImage.imageId === refImage.imageId) continue;
                    const targetPixels = targetImage.stars;
                    if (targetPixels.length < 2) continue;

                    let bestTargetPair: Star[] | null = null;
                    let minError = Infinity;

                    for (let ti = 0; ti < targetPixels.length; ti++) {
                        for (let tj = ti + 1; tj < targetPixels.length; tj++) {
                            const targetPair = [targetPixels[ti], targetPixels[tj]];
                            const targetDist = Math.hypot(targetPair[1].x - targetPair[0].x, targetPair[1].y - targetPair[0].y);
                            const distError = Math.abs(refDist - targetDist);
                            
                            if (distError < DISTANCE_TOLERANCE && distError < minError) {
                                minError = distError;
                                bestTargetPair = targetPair;
                            }
                        }
                    }

                    if (bestTargetPair) {
                        currentTargetPairs[targetImage.imageId] = bestTargetPair;
                        currentMatchCount++;
                    }
                }
                
                // Prioritize pairs found in more images, then by length
                if (currentMatchCount > bestMatch.count || (currentMatchCount === bestMatch.count && refDist > bestMatch.length)) {
                    bestMatch = {
                        count: currentMatchCount,
                        refPair,
                        targetPairs: currentTargetPairs,
                        length: refDist,
                    };
                }
            }
        }
        if (bestMatch.count < 2) return null;
        return bestMatch;
    };

    const firstLineMatch = findBestLine(allImagePixels);
    if (!firstLineMatch) {
        addLog(`[DUMB-PATTERN] Could not find a common line pattern.`);
        return null;
    }
    addLog(`[DUMB-PATTERN] Found first common line across ${firstLineMatch.count} images.`);
    
    const imageIdsWithFirstLine = Object.keys(firstLineMatch.targetPairs);
    
    // --- Find second, independent line ---
    const remainingCandidates = allImagePixels
        .filter(p => imageIdsWithFirstLine.includes(p.imageId))
        .map(p => {
            const usedStars = new Set(firstLineMatch.targetPairs[p.imageId]);
            return {
                imageId: p.imageId,
                stars: p.stars.filter(s => !usedStars.has(s)),
            };
        });

    const secondLineMatch = findBestLine(remainingCandidates);
    
    const finalRefPoints: Star[] = [...firstLineMatch.refPair!];
    const finalTargetPoints: Record<string, Star[]> = {};
    for (const id of imageIdsWithFirstLine) {
        finalTargetPoints[id] = [...firstLineMatch.targetPairs[id]];
    }

    let finalImageIds = imageIdsWithFirstLine;

    if (secondLineMatch) {
        addLog(`[DUMB-PATTERN] Found second independent line across ${secondLineMatch.count} images.`);
        finalRefPoints.push(...secondLineMatch.refPair!);
        
        finalImageIds = Object.keys(secondLineMatch.targetPairs).filter(id => imageIdsWithFirstLine.includes(id));
        
        for (const id of finalImageIds) {
            finalTargetPoints[id].push(...secondLineMatch.targetPairs[id]);
        }

    } else {
        addLog(`[DUMB-PATTERN] Could not find a second independent line. Proceeding with one.`);
    }

    if (finalRefPoints.length < 4) {
        addLog(`[DUMB-PATTERN] Fewer than 4 common points found. Falling back to 2-point alignment.`);
    }
     if (finalImageIds.length < 2) {
        addLog(`[DUMB-PATTERN] Fewer than 2 images share a common pattern. Aborting.`);
        return null;
    }
    
    return {
        refPoints: finalRefPoints,
        targetPoints: finalTargetPoints,
        imageIds: finalImageIds,
    };
}


function getTransform(refPoints: Star[], targetPoints: Star[]): Transform | null {
    if (refPoints.length < 2 || targetPoints.length < 2) return null;
    
    // Using RANSAC or a more robust method for multiple points would be ideal,
    // but for simplicity and performance, we'll use the first pair.
    // If 4 points are available, we could average two transforms, but that's also complex.
    // So let's stick to the most reliable pair (the first line found).
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

async function getAiVerifiedPixels(
    entry: ImageQueueEntry,
    modelPackage: ModelPackage,
    addLog: (msg: string) => void
): Promise<Star[]> {
    if (!entry.imageData) return [];
    
    addLog(`[DUMB-AI] AI verifying pixels for ${entry.file.name}...`);
    
    const candidates = detectBrightestPixels(entry.imageData, addLog, entry.file.name);
    if (candidates.length === 0) return [];

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

    const aiVerifiedStars: Star[] = [];
    const {data, width, height} = entry.imageData;

    for (const cluster of clusters) {
        if (cluster.length === 1) {
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
        if (pixels.length >= 4) { // Need at least 4 points for two lines
            allImageBrightPixels.push({ imageId: entry.id, stars: pixels });
        }
        setProgress(0.3 * ((index + 1) / imageEntries.length));
    }


    if (allImageBrightPixels.length < 2) {
        throw new Error("Fewer than two images have at least 4 candidate pixels for alignment.");
    }
    
    addLog(`[DUMB-ALIGN] Step 2: Finding common line patterns...`);
    const globalPattern = findBestGlobalLines(allImageBrightPixels, addLog);

    if (!globalPattern) {
        throw new Error("Could not find a common pattern. Try using the 'Consensus' method.");
    }
    
    const { refPoints, targetPoints, imageIds } = globalPattern;
    
    const refImageId = imageIds[0];
    const refEntry = imageEntries.find(e => e.id === refImageId)!;
    const { width, height } = refEntry.analysisDimensions;

    setProgress(0.5);

    addLog(`[DUMB-ALIGN] Step 3: Aligning ${imageIds.length} images to reference based on the pattern.`);
    const alignedImageDatas: (Uint8ClampedArray | null)[] = [];


    for (const [index, entry] of imageEntries.entries()) {
        const progress = 0.5 + (0.4 * (index + 1) / imageEntries.length);

        if (!imageIds.includes(entry.id) || !entry.imageData) {
            alignedImageDatas.push(null);
            setProgress(progress);
            continue;
        }
        
        if (entry.id === refImageId) {
            alignedImageDatas.push(entry.imageData.data);
            setProgress(progress);
            continue;
        }

        const currentTargetPoints = targetPoints[entry.id];
        const transform = getTransform(refPoints, currentTargetPoints);

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
