'use client';

import type { Star, StackingMode, Transform, ImageQueueEntry } from '@/lib/astro-align';
import { warpImage, stackImagesAverage, stackImagesMedian, stackImagesSigmaClip, stackImagesLaplacian } from '@/lib/astro-align';

/**
 * Detects pixels that are pure white (255, 255, 255).
 */
function detectWhitePixels(imageData: ImageData): Star[] {
    const { data, width } = imageData;
    const stars: Star[] = [];

    for (let i = 0; i < data.length; i += 4) {
        if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) {
            const x = (i / 4) % width;
            const y = Math.floor((i / 4) / width);
            stars.push({
                x,
                y,
                brightness: 255,
                size: 1,
            });
        }
    }
    return stars;
}

/**
 * Calculates the transformation required to align two point sets.
 */
function getTransformFromStarPair(refStar1: Star, refStar2: Star, targetStar1: Star, targetStar2: Star): Transform | null {
    if (!refStar1 || !refStar2 || !targetStar1 || !targetStar2) {
        return null;
    }

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

/**
 * Finds the most common pair of white pixels across all images.
 */
function findBestGlobalPair(
    allImageStars: { imageId: string; stars: Star[] }[],
    addLog: (message: string) => void
): { refPair: Star[]; targetPairs: Record<string, Star[]>; imageIds: string[] } | null {
    if (allImageStars.length < 2) {
        addLog("[DUMB-ALIGN] Need at least 2 images to find a global pair.");
        return null;
    }

    const refImageStars = allImageStars[0].stars;
    if (refImageStars.length < 2) {
        addLog("[DUMB-ALIGN] Reference image has fewer than 2 white pixels.");
        return null;
    }

    let bestPairInfo = {
        refPair: null as Star[] | null,
        targetPairs: {} as Record<string, Star[]>,
        count: 0
    };

    const DIST_TOLERANCE = 5; // 5 pixels tolerance for distance mismatch

    for (let i = 0; i < refImageStars.length; i++) {
        for (let j = i + 1; j < refImageStars.length; j++) {
            const currentRefPair = [refImageStars[i], refImageStars[j]];
            const refDist = Math.hypot(currentRefPair[1].x - currentRefPair[0].x, currentRefPair[1].y - currentRefPair[0].y);
            if (refDist < 5) continue; // Ignore pairs that are too close

            let currentTargetPairs: Record<string, Star[]> = { [allImageStars[0].imageId]: currentRefPair };
            let matchCount = 1;

            for (let k = 1; k < allImageStars.length; k++) {
                const targetImage = allImageStars[k];
                if (targetImage.stars.length < 2) continue;

                let bestTargetMatch: { pair: Star[], error: number } | null = null;

                for (let m = 0; m < targetImage.stars.length; m++) {
                    for (let n = m + 1; n < targetImage.stars.length; n++) {
                        const targetPair = [targetImage.stars[m], targetImage.stars[n]];
                        const targetDist = Math.hypot(targetPair[1].x - targetPair[0].x, targetPair[1].y - targetPair[0].y);

                        const distError = Math.abs(targetDist - refDist);

                        if (distError < DIST_TOLERANCE) {
                            if (!bestTargetMatch || distError < bestTargetMatch.error) {
                                bestTargetMatch = { pair: targetPair, error: distError };
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
        addLog("[DUMB-ALIGN] Could not find a white pixel pair shared by at least 2 images.");
        return null;
    }

    const imageIdsWithPair = Object.keys(bestPairInfo.targetPairs);
    addLog(`[DUMB-ALIGN] Found best pair, shared across ${bestPairInfo.count} images.`);
    return {
        refPair: bestPairInfo.refPair!,
        targetPairs: bestPairInfo.targetPairs,
        imageIds: imageIdsWithPair
    };
}


// --- MAIN DUMB ALIGNMENT & STACKING FUNCTION ---
export async function dumbAlignAndStack({
    imageEntries,
    stackingMode,
    addLog,
    setProgress,
}: {
    imageEntries: ImageQueueEntry[];
    stackingMode: StackingMode;
    addLog: (message: string) => void;
    setProgress: (progress: number) => void;
}): Promise<Uint8ClampedArray> {
    addLog("[DUMB-ALIGN] Starting dumb alignment based on white pixels.");
    if (imageEntries.length < 2) {
        throw new Error("Dumb stacking requires at least two images.");
    }

    addLog("[DUMB-ALIGN] Step 1: Detecting white pixels in all images...");
    const allImageWhitePixels = imageEntries.map((entry, index) => {
        if (!entry.imageData) return { imageId: entry.id, stars: [] };
        const whitePixels = detectWhitePixels(entry.imageData);
        addLog(`[DUMB-ALIGN] Found ${whitePixels.length} white pixels in ${entry.file.name}.`);
        setProgress(0.3 * ((index + 1) / imageEntries.length));
        return { imageId: entry.id, stars: whitePixels };
    }).filter(data => data.stars.length >= 2);

    if (allImageWhitePixels.length < 2) {
        throw new Error("Fewer than two images have enough white pixels for alignment.");
    }

    addLog("[DUMB-ALIGN] Step 2: Finding the most common white pixel pair...");
    const globalPair = findBestGlobalPair(allImageWhitePixels, addLog);

    if (!globalPair) {
        throw new Error("Dumb alignment failed: Could not find a reliable white pixel pair shared across multiple images.");
    }

    const { refPair, targetPairs, imageIds } = globalPair;
    const refImageId = imageIds[0];
    const refEntry = imageEntries.find(e => e.id === refImageId)!;
    const { width, height } = refEntry.analysisDimensions;

    setProgress(0.5);

    addLog(`[DUMB-ALIGN] Step 3: Aligning ${imageIds.length} images that contain the common pair.`);
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

        const transform = getTransformFromStarPair(refPair[0], refPair[1], targetPairs[entry.id][0], targetPairs[entry.id][1]);

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
