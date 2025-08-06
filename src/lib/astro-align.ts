// --- Types ---
export type Point = { x: number; y: number };
export type Star = Point & { brightness: number; size: number };
export type StackingMode = 'average' | 'median' | 'sigma';
export interface ImageQueueEntry {
  id: string;
  imageData: ImageData | null;
  detectedStars: Star[];
  analysisDimensions: { width: number; height: number; };
};

// --- UTILITY FUNCTIONS ---
function toGrayscale(imageData: ImageData): Uint8Array {
  const len = imageData.data.length / 4;
  const gray = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const r = imageData.data[i * 4];
    const g = imageData.data[i * 4 + 1];
    const b = imageData.data[i * 4 + 2];
    gray[i] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
  }
  return gray;
}

// --- STAGE 1: ROBUST STAR DETECTION ---

/**
 * Detects stars using a simple blob detection and center-of-mass calculation.
 * This is more robust than complex PSF fitting, which was failing.
 */
export function detectStars(
  imageData: ImageData,
  width: number,
  height: number,
  threshold: number
): Star[] {
    const gray = toGrayscale(imageData);
    const visited = new Uint8Array(gray.length);
    const stars: Star[] = [];
    const minSize = 3; // Minimum pixels for a blob to be a star
    const maxSize = 500; // Maximum pixels for a blob to be a star

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

    for (let i = 0; i < gray.length; i++) {
        if (visited[i] || gray[i] < threshold) continue;

        const queue = [i];
        visited[i] = 1;
        const blobPixels: number[] = [];
        
        while (queue.length > 0) {
            const p = queue.shift()!;
            blobPixels.push(p);

            for (const n of getNeighbors(p)) {
                if (!visited[n] && gray[n] >= threshold - 20) { // Lower threshold for neighbors
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
            const brightness = gray[p];
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

    return stars.sort((a, b) => b.brightness - a.brightness);
}

// --- STAGE 2: SIMPLE TRANSLATION-ONLY ALIGNMENT ---

/**
 * Warps an image using only a translation (dx, dy).
 * Rotation and scaling are ignored for stability.
 */
function warpImage(
    srcData: Uint8ClampedArray,
    srcWidth: number,
    srcHeight: number,
    dx: number,
    dy: number
): Uint8ClampedArray {
    const dstData = new Uint8ClampedArray(srcData.length);
    const roundDx = Math.round(dx);
    const roundDy = Math.round(dy);

    for (let y = 0; y < srcHeight; y++) {
        for (let x = 0; x < srcWidth; x++) {
            const srcX = x - roundDx;
            const srcY = y - roundDy;

            if (srcX >= 0 && srcX < srcWidth && srcY >= 0 && srcY < srcHeight) {
                const srcIdx = (srcY * srcWidth + srcX) * 4;
                const dstIdx = (y * srcWidth + x) * 4;
                dstData[dstIdx] = srcData[srcIdx];
                dstData[dstIdx + 1] = srcData[srcIdx + 1];
                dstData[dstIdx + 2] = srcData[srcIdx + 2];
                dstData[dstIdx + 3] = srcData[srcIdx + 3];
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
            // Check if pixel has data (not black from warping)
            if (img[i+3] > 0) {
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
    const pixelValues: number[] = [];

    for (let i = 0; i < length; i += 4) {
        for (let channel = 0; channel < 3; channel++) {
            pixelValues.length = 0;
            for (const img of validImages) {
                if (img[i + 3] > 0) {
                    pixelValues.push(img[i + channel]);
                }
            }
            if (pixelValues.length > 0) {
                pixelValues.sort((a, b) => a - b);
                const mid = Math.floor(pixelValues.length / 2);
                result[i + channel] = pixelValues.length % 2 !== 0
                    ? pixelValues[mid]
                    : (pixelValues[mid - 1] + pixelValues[mid]) / 2;
            }
        }
        
        result[i + 3] = pixelValues.length > 0 ? 255 : 0;
    }
    return result;
}

function stackImagesSigmaClip(images: (Uint8ClampedArray | null)[], sigma = 2.0): Uint8ClampedArray {
    const validImages = images.filter((img): img is Uint8ClampedArray => img !== null);
    if (validImages.length === 0) throw new Error("No valid images to stack");
    const length = validImages[0].length;
    const result = new Uint8ClampedArray(length);
    const pixelValues: number[] = [];

    for (let i = 0; i < length; i += 4) {
        for (let channel = 0; channel < 3; channel++) {
            pixelValues.length = 0;
            for (const img of validImages) {
                if (img[i + 3] > 0) {
                    pixelValues.push(img[i + channel]);
                }
            }

            if (pixelValues.length === 0) continue;
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
        result[i + 3] = pixelValues.length > 0 ? 255 : 0;
    }
    return result;
}


// --- MAIN ALIGNMENT & STACKING FUNCTION ---
export async function alignAndStack(
  imageEntries: ImageQueueEntry[],
  manualRefStars: Star[], // This is no longer used but kept for API compatibility
  mode: StackingMode,
  addLog: (message: string) => void,
  setProgress: (progress: number) => void
): Promise<Uint8ClampedArray> {
  if (imageEntries.length === 0 || !imageEntries[0].imageData) {
    throw new Error("No valid images provided for stacking.");
  }

  const refEntry = imageEntries[0];
  const { width, height } = refEntry.analysisDimensions;
  const alignedImageDatas: (Uint8ClampedArray | null)[] = [refEntry.imageData!.data];
  
  const refStars = refEntry.detectedStars;
  if (refStars.length === 0) {
    addLog(`Error: Reference image has no stars detected. Cannot align.`);
    throw new Error("Reference image has no stars detected. Cannot align.");
  }
  const refBrightestStar = refStars[0];
  addLog(`Reference star found at (${refBrightestStar.x.toFixed(2)}, ${refBrightestStar.y.toFixed(2)})`);

  for (let i = 1; i < imageEntries.length; i++) {
    const targetEntry = imageEntries[i];
    const progress = (i + 1) / imageEntries.length;
    addLog(`--- Aligning Image ${i+1}/${imageEntries.length} ---`);

    if (!targetEntry.imageData) {
      addLog(`Skipping image ${i+1}: missing image data.`);
      alignedImageDatas.push(null);
      setProgress(progress);
      continue;
    }

    const targetStars = targetEntry.detectedStars;
    if (targetStars.length === 0) {
        addLog(`Skipping image ${i+1}: no stars detected.`);
        alignedImageDatas.push(null);
        setProgress(progress);
        continue;
    }

    const targetBrightestStar = targetStars[0];
    addLog(`Target star found at (${targetBrightestStar.x.toFixed(2)}, ${targetBrightestStar.y.toFixed(2)})`);

    // Calculate simple translation
    const dx = refBrightestStar.x - targetBrightestStar.x;
    const dy = refBrightestStar.y - targetBrightestStar.y;
    addLog(`Image ${i+1}: Applying translation (dx: ${dx.toFixed(2)}, dy: ${dy.toFixed(2)})`);

    const warpedData = warpImage(targetEntry.imageData.data, width, height, dx, dy);
    alignedImageDatas.push(warpedData);
    
    setProgress(progress);
  }

  addLog("All images processed. Stacking...");
  setProgress(1);

  switch (mode) {
    case 'median':
        addLog("Using Median stacking mode.");
        return stackImagesMedian(alignedImageDatas);
    case 'sigma':
        addLog("Using Sigma Clipping stacking mode.");
        return stackImagesSigmaClip(alignedImageDatas);
    case 'average':
    default:
        addLog("Using Average stacking mode.");
        return stackImagesAverage(alignedImageDatas);
  }
}
