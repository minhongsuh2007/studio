
// This is a new server-side-only alignment library, consolidating logic for the API.
// It is adapted from the client-side libraries.

import sharp from 'sharp';

// --- Types ---
export type Point = { x: number; y: number };
export type Star = Point & { brightness: number; size: number };
export type StackingMode = 'average' | 'median' | 'sigma' | 'laplacian';
export type AlignmentMethod = 'standard' | 'consensus' | 'planetary' | 'dumb';

export interface ImageQueueEntry {
  id: string;
  imageData: ImageData; // Now mandatory for server-side
  detectedStars: Star[];
  analysisDimensions: { width: number; height: number; };
};
export type Transform = {
    dx: number;
    dy: number;
    angle: number;
    scale: number;
};


// --- UTILITIES ---

export function detectBrightBlobs(
  imageData: ImageData,
  width: number,
  height: number,
  threshold: number = 180, // Lowered threshold for server processing
  log: (msg: string) => void
): Star[] {
    const { data } = imageData;
    const visited = new Uint8Array(width * height);
    const stars: Star[] = [];
    const minSize = 2; 
    const maxSize = 500;

    const getNeighbors = (pos: number): number[] => {
        const neighbors = [];
        const x = pos % width;
        const y = Math.floor(pos / width);
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                    neighbors.push(ny * width + nx);
                }
            }
        }
        return neighbors;
    };
    
    const isPixelAboveThreshold = (idx: number) => {
        const base = idx * 4;
        return data[base] > threshold && data[base + 1] > threshold && data[base + 2] > threshold;
    }

    for (let i = 0; i < width * height; i++) {
        if (visited[i] || !isPixelAboveThreshold(i)) continue;

        const queue = [i];
        visited[i] = 1;
        const blobPixels: number[] = [];
        
        while (queue.length > 0) {
            const p = queue.shift()!;
            blobPixels.push(p);

            for (const n of getNeighbors(p)) {
                if (!visited[n] && isPixelAboveThreshold(n)) {
                    visited[n] = 1;
                    queue.push(n);
                }
            }
        }
        
        if (blobPixels.length < minSize || blobPixels.length > maxSize) continue;

        let totalBrightness = 0;
        let weightedX = 0;
        let weightedY = 0;

        for (const p of blobPixels) {
            const b_idx = p * 4;
            const brightness = (data[b_idx] + data[b_idx+1] + data[b_idx+2]) / 3;
            const x = p % width;
            const y = Math.floor(p / width);
            totalBrightness += brightness;
            weightedX += x * brightness;
            weightedY += y * brightness;
        }

        if (totalBrightness > 0) {
            stars.push({
                x: weightedX / totalBrightness,
                y: weightedY / totalBrightness,
                brightness: totalBrightness,
                size: blobPixels.length,
            });
        }
    }
    
    log(`[detectBrightBlobs] Found ${stars.length} star candidates.`);
    return stars.sort((a, b) => b.brightness - a.brightness);
}


function getTransformFromTwoStars(refStars: Star[], targetStars: Star[]): Transform | null {
    if (refStars.length < 2 || targetStars.length < 2) {
        return null;
    }
    const [ref1, ref2] = refStars;
    const [target1, target2] = targetStars;

    const refVec = { x: ref2.x - ref1.x, y: ref2.y - ref1.y };
    const targetVec = { x: target2.x - target1.x, y: target2.y - target1.y };

    const refAngle = Math.atan2(refVec.y, refVec.x);
    const targetAngle = Math.atan2(targetVec.y, targetVec.x);
    let angle = targetAngle - refAngle;

    const refDist = Math.hypot(refVec.x, refVec.y);
    const targetDist = Math.hypot(targetVec.x, targetVec.y);

    if (refDist < 1e-6) return null;
    let scale = targetDist / refDist;
    if (scale === 0) return null;

    const cosAngle = Math.cos(-angle);
    const sinAngle = Math.sin(-angle);
    const rotatedTargetX = target1.x * cosAngle - target1.y * sinAngle;
    const rotatedTargetY = target1.x * sinAngle + target1.y * cosAngle;

    const dx = ref1.x - rotatedTargetX * scale;
    const dy = ref1.y - rotatedTargetY * scale;

    return { dx, dy, angle: -angle, scale };
}

export function warpImage(
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
            
            if (x_floor < 0 || x_floor >= srcWidth - 1 || y_floor < 0 || y_floor >= srcHeight - 1) {
                continue; 
            }
            
            const x_ratio = srcX - x_floor;
            const y_ratio = srcY - y_floor;

            const dstIdx = (y * srcWidth + x) * 4;

            for (let channel = 0; channel < 4; channel++) {
                 const c00 = srcData[(y_floor * srcWidth + x_floor) * 4 + channel];
                 const c10 = srcData[(y_floor * srcWidth + x_floor + 1) * 4 + channel];
                 const c01 = srcData[((y_floor + 1) * srcWidth + x_floor) * 4 + channel];
                 const c11 = srcData[((y_floor + 1) * srcWidth + x_floor + 1) * 4 + channel];

                 const c_x0 = c00 * (1 - x_ratio) + c10 * x_ratio;
                 const c_x1 = c01 * (1 - x_ratio) + c11 * x_ratio;

                 dstData[dstIdx + channel] = c_x0 * (1 - y_ratio) + c_x1 * y_ratio;
            }
            if (dstData[dstIdx] > 0 || dstData[dstIdx+1] > 0 || dstData[dstIdx+2] > 0) {
              dstData[dstIdx+3] = 255;
            }
        }
    }
    return dstData;
}


// --- STACKING IMPLEMENTATIONS ---

export function stackImagesAverage(images: (Uint8ClampedArray | null)[]): Uint8ClampedArray {
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

export function stackImagesMedian(images: (Uint8ClampedArray | null)[]): Uint8ClampedArray {
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

export function stackImagesSigmaClip(images: (Uint8ClampedArray | null)[], sigma = 2.0): Uint8ClampedArray {
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
            } else { 
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

export function stackImagesLaplacian(
    imagesData: (Uint8ClampedArray | null)[],
    width: number,
    height: number
): Uint8ClampedArray {
    const validImages = imagesData.filter((img): img is Uint8ClampedArray => img !== null);
    if (validImages.length === 0) throw new Error("No valid images to stack");
    const length = validImages[0].length;
    const result = new Uint8ClampedArray(length);

    const processedImages = validImages.map(data => {
        const gray = new Uint8Array(width * height);
        const laplacian = new Float32Array(width * height);
        for (let i = 0; i < gray.length; i++) {
            gray[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114);
        }

        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const i = y * width + x;
                const p = gray[i] * 8 -
                          (gray[i - 1] + gray[i + 1] +
                           gray[i - width] + gray[i + width] +
                           gray[i - width - 1] + gray[i - width + 1] +
                           gray[i + width - 1] + gray[i + width + 1]);
                laplacian[i] = Math.abs(p);
            }
        }
        return { data, laplacian };
    });

    for (let i = 0; i < width * height; i++) {
        let bestImageIndex = -1;
        let maxLaplacian = -1;

        for (let k = 0; k < processedImages.length; k++) {
            if (processedImages[k].data[i * 4 + 3] > 128) {
                const currentLaplacian = processedImages[k].laplacian[i];
                if (currentLaplacian > maxLaplacian) {
                    maxLaplacian = currentLaplacian;
                    bestImageIndex = k;
                }
            }
        }

        const dstIdx = i * 4;
        if (bestImageIndex !== -1) {
            const bestImage = processedImages[bestImageIndex];
            result[dstIdx] = bestImage.data[dstIdx];
            result[dstIdx + 1] = bestImage.data[dstIdx + 1];
            result[dstIdx + 2] = bestImage.data[dstIdx + 2];
            result[dstIdx + 3] = 255;
        }
    }
    return result;
}

// --- ALIGNMENT ALGORITHMS ---

export async function alignAndStack(
  imageEntries: ImageQueueEntry[],
  manualRefStars: Star[], // This will be empty for API calls
  mode: StackingMode,
  setProgress: (progress: number) => void,
  log: (msg: string) => void,
): Promise<Uint8ClampedArray> {
  log("[ALIGN-STD] Starting Standard 2-star alignment.");
  const refEntry = imageEntries[0];
  const { width, height } = refEntry.analysisDimensions;
  
  refEntry.detectedStars = detectBrightBlobs(refEntry.imageData, width, height, 180, log);
  const refStars = refEntry.detectedStars.slice(0, 50);

  if (refStars.length < 2) {
    throw new Error("Reference image has fewer than 2 detected stars for Standard alignment.");
  }
  
  const alignedImageDatas: (Uint8ClampedArray | null)[] = [refEntry.imageData.data];

  for (let i = 1; i < imageEntries.length; i++) {
    const targetEntry = imageEntries[i];
    targetEntry.detectedStars = detectBrightBlobs(targetEntry.imageData, targetEntry.analysisDimensions.width, targetEntry.analysisDimensions.height, 180, log);
    const targetStars = targetEntry.detectedStars.slice(0, 50);

    if (targetStars.length < 2) {
        alignedImageDatas.push(null);
        continue;
    }

    const transform = getTransformFromTwoStars(refStars, targetStars);
    if (!transform) {
        alignedImageDatas.push(null);
        continue;
    }
    
    const warpedData = warpImage(targetEntry.imageData.data, width, height, transform);
    alignedImageDatas.push(warpedData);
  }

  // Final stacking
  switch (mode) {
    case 'median': return stackImagesMedian(alignedImageDatas);
    case 'sigma': return stackImagesSigmaClip(alignedImageDatas);
    case 'laplacian': return stackImagesLaplacian(alignedImageDatas, width, height);
    case 'average': default: return stackImagesAverage(alignedImageDatas);
  }
}

function getTriangleSignature(p1: Star, p2: Star, p3: Star) {
    const d12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const d23 = Math.hypot(p3.x - p2.x, p3.y - p2.y);
    const d31 = Math.hypot(p1.x - p3.x, p1.y - p3.y);
    const sides = [d12, d23, d31].sort((a,b)=>a-b);
    if(sides[0] < 1e-6) return null;
    return [sides[1] / sides[0], sides[2] / sides[0]];
}

function findGeometricConsensus(
    allImageStarSets: { imageId: string; stars: Star[] }[],
    log: (message: string) => void
): { refPair: Star[]; targetPairs: Record<string, Star[]>; imageIds: string[] } | null {
    if (allImageStarSets.length < 2) return null;

    const refImage = allImageStarSets[0];
    const refStars = refImage.stars;
    if (refStars.length < 3) return null;

    let bestMatch = { count: 0, refTriangle: null as Star[] | null, targetTriangles: {} as Record<string, Star[]> };
    const SIGNATURE_TOLERANCE = 0.05; 

    for (let i = 0; i < refStars.length; i++) {
        for (let j = i + 1; j < refStars.length; j++) {
            for (let k = j + 1; k < refStars.length; k++) {
                const refTriangle = [refStars[i], refStars[j], refStars[k]];
                const refSignature = getTriangleSignature(...refTriangle);
                if (!refSignature) continue;

                let currentMatchCount = 1;
                const currentTargetTriangles: Record<string, Star[]> = { [refImage.imageId]: refTriangle };

                for (let imgIdx = 1; imgIdx < allImageStarSets.length; imgIdx++) {
                    const targetImage = allImageStarSets[imgIdx];
                    if (targetImage.stars.length < 3) continue;

                    let foundMatchInImage = false;
                    for (let ti = 0; ti < targetImage.stars.length && !foundMatchInImage; ti++) {
                        for (let tj = ti + 1; tj < targetImage.stars.length && !foundMatchInImage; tj++) {
                            for (let tk = tj + 1; tk < targetImage.stars.length && !foundMatchInImage; tk++) {
                                const targetTriangle = [targetImage.stars[ti], targetImage.stars[tj], targetImage.stars[tk]];
                                const targetSignature = getTriangleSignature(...targetTriangle);
                                if (!targetSignature) continue;

                                if (Math.abs(refSignature[0] - targetSignature[0]) < SIGNATURE_TOLERANCE && Math.abs(refSignature[1] - targetSignature[1]) < SIGNATURE_TOLERANCE) {
                                    currentMatchCount++;
                                    currentTargetTriangles[targetImage.imageId] = targetTriangle;
                                    foundMatchInImage = true;
                                }
                            }
                        }
                    }
                }
                
                if (currentMatchCount > bestMatch.count) {
                    bestMatch = { count: currentMatchCount, refTriangle, targetTriangles: currentTargetTriangles };
                }
            }
        }
    }

    if (bestMatch.count < 2) {
        log("[CONSENSUS] Could not find a common geometric pattern.");
        return null;
    }

    log(`[CONSENSUS] Found common pattern across ${bestMatch.count} images.`);
    
    const imageIds = Object.keys(bestMatch.targetTriangles);
    const refPair = [bestMatch.refTriangle![0], bestMatch.refTriangle![1]];
    const targetPairs: Record<string, Star[]> = {};
    for (const id of imageIds) {
        targetPairs[id] = [bestMatch.targetTriangles[id][0], bestMatch.targetTriangles[id][1]];
    }

    return { refPair, targetPairs, imageIds };
}

export async function consensusAlignAndStack({
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
    addLog("[ALIGN-CONSENSUS] Starting Consensus alignment.");
  
    const allImageStarSets: { imageId: string; stars: Star[] }[] = [];
    for (const entry of imageEntries) {
        const stars = detectBrightBlobs(entry.imageData, entry.analysisDimensions.width, entry.analysisDimensions.height, 180, addLog).slice(0, 100);
        if (stars.length > 2) {
            allImageStarSets.push({ imageId: entry.id, stars });
        }
    }

    if (allImageStarSets.length < 2) throw new Error("Fewer than two images have enough stars for consensus alignment.");
  
    const globalConsensus = findGeometricConsensus(allImageStarSets, addLog);
    if (!globalConsensus) throw new Error("Consensus alignment failed: Could not find a reliable star pattern.");
  
    const { refPair, targetPairs, imageIds } = globalConsensus;
    const refImageId = imageIds[0];
    const refEntry = imageEntries.find(e => e.id === refImageId)!;
    const { width, height } = refEntry.analysisDimensions;

    const alignedImageDatas: (Uint8ClampedArray | null)[] = [];

    for (const entry of imageEntries) {
        if (!imageIds.includes(entry.id)) {
            alignedImageDatas.push(null);
            continue;
        }

        if (entry.id === refEntry.id) {
            alignedImageDatas.push(entry.imageData.data);
            continue;
        }
    
        const [ref1, ref2] = refPair;
        const [target1, target2] = targetPairs[entry.id];
        const transform = getTransformFromTwoStars([ref1, ref2], [target1, target2]);

        if (!transform) {
            alignedImageDatas.push(null);
            continue;
        }
    
        const warpedData = warpImage(entry.imageData.data, width, height, transform);
        alignedImageDatas.push(warpedData);
    }
  
    // Final stacking
    switch (stackingMode) {
        case 'median': return stackImagesMedian(alignedImageDatas);
        case 'sigma': return stackImagesSigmaClip(alignedImageDatas);
        case 'laplacian': return stackImagesLaplacian(alignedImageDatas, width, height);
        case 'average': default: return stackImagesAverage(alignedImageDatas);
    }
}

// Dummy/Planetary aligners are simplified here for brevity and robustness on server
export async function planetaryAlignAndStack(
  imageEntries: ImageQueueEntry[],
  mode: StackingMode,
  addLog: (message: string) => void,
  setProgress: (progress: number) => void,
  qualityPercent: number,
): Promise<Uint8ClampedArray> {
    addLog("[ALIGN-PLANETARY] Planetary alignment is compute-intensive and best-effort on server.");
    // For server-side, we simplify and use consensus as a robust fallback.
    return consensusAlignAndStack({imageEntries, stackingMode: mode, addLog, setProgress});
}

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
    addLog("[ALIGN-DUMB] Dumb alignment is experimental on server.");
    // For server-side, we simplify and use consensus as a robust fallback.
    return consensusAlignAndStack({imageEntries, stackingMode, addLog, setProgress});
}
