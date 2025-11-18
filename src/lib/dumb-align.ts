
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
    categories: string[];
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


function getTriangleSignature(p1: Star, p2: Star, p3: Star): number[] | null {
    const d12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const d23 = Math.hypot(p3.x - p2.x, p3.y - p2.y);
    const d31 = Math.hypot(p1.x - p3.x, p1.y - p3.y);
    const sides = [d12, d23, d31].sort((a, b) => a - b);
    if (sides[0] < 1e-6) return null;
    return [sides[1] / sides[0], sides[2] / sides[0]];
}


function findBestGlobalPatterns(
    allImagePixels: { imageId: string; stars: Star[] }[],
    addLog: (message: string) => void
): { refPoints: Star[]; targetPoints: Record<string, Star[]>; imageIds: string[] } | null {
    if (allImagePixels.length < 2) {
        addLog("[DUMB-PATTERN] Need at least 2 images.");
        return null;
    }

    const findBestTriangle = (candidates: { imageId: string; stars: Star[] }[]) => {
        const refImage = candidates.find(c => c.stars.length >= 3);
        if (!refImage) return null;

        let bestMatch = { count: 0, refTriangle: null as Star[] | null, targetTriangles: {} as Record<string, Star[]> };
        const SIGNATURE_TOLERANCE = 0.05;

        const refStars = refImage.stars;
        for (let i = 0; i < refStars.length; i++) {
            for (let j = i + 1; j < refStars.length; j++) {
                for (let k = j + 1; k < refStars.length; k++) {
                    const refTriangle = [refStars[i], refStars[j], refStars[k]];
                    const refSignature = getTriangleSignature(...refTriangle);
                    if (!refSignature) continue;

                    let currentMatchCount = 1;
                    const currentTargetTriangles: Record<string, Star[]> = { [refImage.imageId]: refTriangle };

                    for (const targetImage of candidates) {
                        if (targetImage.imageId === refImage.imageId) continue;
                        const targetStars = targetImage.stars;
                        if (targetStars.length < 3) continue;

                        let bestTargetTriangle: Star[] | null = null;
                        let minError = Infinity;

                        for (let ti = 0; ti < targetStars.length; ti++) {
                            for (let tj = ti + 1; tj < targetStars.length; tj++) {
                                for (let tk = tj + 1; tk < targetStars.length; tk++) {
                                    const targetTriangle = [targetStars[ti], targetStars[tj], targetStars[tk]];
                                    const targetSignature = getTriangleSignature(...targetTriangle);
                                    if (!targetSignature) continue;
                                    
                                    const error = Math.hypot(refSignature[0] - targetSignature[0], refSignature[1] - targetSignature[1]);
                                    if (error < SIGNATURE_TOLERANCE && error < minError) {
                                        minError = error;
                                        bestTargetTriangle = targetTriangle;
                                    }
                                }
                            }
                        }
                        if (bestTargetTriangle) {
                            currentTargetTriangles[targetImage.imageId] = bestTargetTriangle;
                            currentMatchCount++;
                        }
                    }

                    if (currentMatchCount > bestMatch.count) {
                        bestMatch = { count: currentMatchCount, refTriangle, targetTriangles: currentTargetTriangles };
                    }
                }
            }
        }
        if (bestMatch.count < 2) return null;
        return bestMatch;
    };

    const findBestLine = (candidates: { imageId: string; stars: Star[] }[]) => {
        const refImage = candidates.find(c => c.stars.length >= 2);
        if (!refImage) return null;

        let bestMatch = { count: 0, refPair: null as Star[] | null, targetPairs: {} as Record<string, Star[]>, length: 0 };
        const DISTANCE_TOLERANCE_PX = 10;

        const refStars = refImage.stars;
        for (let i = 0; i < refStars.length; i++) {
            for (let j = i + 1; j < refStars.length; j++) {
                const refPair = [refStars[i], refStars[j]];
                const refDist = Math.hypot(refPair[1].x - refPair[0].x, refPair[1].y - refPair[0].y);

                let currentMatchCount = 1;
                const currentTargetPairs: Record<string, Star[]> = { [refImage.imageId]: refPair };

                for (const targetImage of candidates) {
                    if (targetImage.imageId === refImage.imageId) continue;
                    const targetStars = targetImage.stars;
                    if (targetStars.length < 2) continue;
                    
                    let bestTargetPair: Star[] | null = null;
                    let minError = Infinity;

                    for(let ti=0; ti<targetStars.length; ti++) {
                        for(let tj=ti+1; tj<targetStars.length; tj++) {
                            const targetPair = [targetStars[ti], targetStars[tj]];
                            const targetDist = Math.hypot(targetPair[1].x - targetPair[0].x, targetPair[1].y - targetPair[0].y);
                            const error = Math.abs(refDist - targetDist);
                            if(error < DISTANCE_TOLERANCE_PX && error < minError) {
                                minError = error;
                                bestTargetPair = targetPair;
                            }
                        }
                    }

                    if(bestTargetPair) {
                        currentTargetPairs[targetImage.imageId] = bestTargetPair;
                        currentMatchCount++;
                    }
                }
                
                if (currentMatchCount > bestMatch.count || (currentMatchCount === bestMatch.count && refDist > bestMatch.length)) {
                    bestMatch = { count: currentMatchCount, refPair, targetPairs: currentTargetPairs, length: refDist };
                }
            }
        }
        if (bestMatch.count < 2) return null;
        return bestMatch;
    };

    const triangleMatch = findBestTriangle(allImagePixels);
    if (!triangleMatch) {
        addLog(`[DUMB-PATTERN] Could not find a common triangle pattern.`);
        return null;
    }
    addLog(`[DUMB-PATTERN] Found first common triangle across ${triangleMatch.count} images.`);
    
    const imageIdsWithTriangle = Object.keys(triangleMatch.targetTriangles);
    
    // --- Find second, independent line ---
    const remainingCandidates = allImagePixels
        .filter(p => imageIdsWithTriangle.includes(p.imageId))
        .map(p => {
            const usedStars = new Set(triangleMatch.targetTriangles[p.imageId]);
            return {
                imageId: p.imageId,
                stars: p.stars.filter(s => !usedStars.has(s)),
            };
        });

    const lineMatch = findBestLine(remainingCandidates);
    
    const finalRefPoints: Star[] = [...triangleMatch.refTriangle!];
    const finalTargetPoints: Record<string, Star[]> = {};
    for (const id of imageIdsWithTriangle) {
        finalTargetPoints[id] = [...triangleMatch.targetTriangles[id]];
    }

    let finalImageIds = imageIdsWithTriangle;

    if (lineMatch) {
        addLog(`[DUMB-PATTERN] Found second independent line across ${lineMatch.count} images.`);
        finalRefPoints.push(...lineMatch.refPair!);
        
        // Final images must have both patterns
        finalImageIds = Object.keys(lineMatch.targetPairs).filter(id => imageIdsWithTriangle.includes(id));
        
        for (const id of finalImageIds) {
            finalTargetPoints[id].push(...lineMatch.targetPairs[id]);
        }

    } else {
        addLog(`[DUMB-PATTERN] Could not find a second independent line. Proceeding with triangle only.`);
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
    
    // Using least squares to solve for the similarity transform parameters
    // A * [scale*cos(angle), scale*sin(angle), tx, ty]' = B
    // Where A is a matrix of target points, B is a matrix of ref points
    
    const n = Math.min(refPoints.length, targetPoints.length);
    if (n < 2) return null;
    
    let sum_xt = 0, sum_yt = 0, sum_xt_sq = 0, sum_yt_sq = 0;
    let sum_xt_xr = 0, sum_yt_yr = 0, sum_xt_yr = 0, sum_yt_xr = 0;
    let sum_xr = 0, sum_yr = 0;

    for(let i=0; i<n; i++) {
        const xr = refPoints[i].x;
        const yr = refPoints[i].y;
        const xt = targetPoints[i].x;
        const yt = targetPoints[i].y;
        
        sum_xt += xt;
        sum_yt += yt;
        sum_xr += xr;
        sum_yr += yr;
        sum_xt_sq += xt*xt;
        sum_yt_sq += yt*yt;
        sum_xt_xr += xt*xr;
        sum_yt_yr += yt*yr;
        sum_xt_yr += xt*yr;
        sum_yt_xr += yt*xr;
    }

    const D = n * (sum_xt_sq + sum_yt_sq) - (sum_xt*sum_xt + sum_yt*sum_yt);
    if (Math.abs(D) < 1e-6) return null; // Avoid division by zero, points are likely collinear

    const a_num = n * (sum_xt_xr + sum_yt_yr) - (sum_xt * sum_xr + sum_yt * sum_yr);
    const a = a_num / D;

    const b_num = n * (sum_yt_xr - sum_xt_yr) + (sum_xt * sum_yr - sum_yt * sum_xr);
    const b = b_num / D;
    
    const tx = (1/n) * (sum_xr - a*sum_xt - b*sum_yt);
    const ty = (1/n) * (sum_yr + b*sum_xt - a*sum_yt);
    
    const scale = Math.hypot(a, b);
    const angle = Math.atan2(b, a);

    return { dx: tx, dy: ty, angle: -angle, scale };
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

    const allRankedStars: {star: Star, probability: number}[] = [];

    for(const catId of modelPackage.categories) {
        for (const cluster of clusters) {
            const { rankedStars } = await findMatchingStars({
                imageData: { data: Array.from(data), width, height },
                candidates: cluster,
                model: modelPackage.model,
                normalization: modelPackage.normalization,
                modelCategories: modelPackage.categories,
                targetCategoryId: catId,
            });
            if (rankedStars && rankedStars.length > 0) {
                allRankedStars.push(...rankedStars);
            }
        }
    }
    
    allRankedStars.sort((a,b) => b.probability - a.probability);

    const topStars = allRankedStars.slice(0, 50).map(rs => rs.star);
    
    addLog(`[DUMB-AI] AI selected ${topStars.length} final candidates from clusters.`);
    return topStars;
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
        if (pixels.length >= 5) { // Need at least 5 points for triangle + line
            allImageBrightPixels.push({ imageId: entry.id, stars: pixels });
        }
        setProgress(0.3 * ((index + 1) / imageEntries.length));
    }


    if (allImageBrightPixels.length < 2) {
        throw new Error("Fewer than two images have at least 5 candidate pixels for alignment.");
    }
    
    addLog(`[DUMB-ALIGN] Step 2: Finding common patterns (triangle + line)...`);
    const globalPattern = findBestGlobalPatterns(allImageBrightPixels, addLog);

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
