// --- Types ---
import { matrix, inv, multiply, transpose, lusolve, median, mean, std } from 'mathjs';

export type Point = { x: number; y: number };
export type Star = Point & { brightness: number; size: number; fwhm: number, descriptor: number[] };
export type StackingMode = 'average' | 'median' | 'sigma';
export interface ImageQueueEntry {
  id: string;
  imageData: ImageData | null;
  detectedStars: Star[];
  analysisDimensions: { width: number; height: number; };
};


// --- 1) Grayscale conversion & Pre-processing ---
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

// --- 2) PSF Fitting ---
function fitGaussianPSF(
    patch: number[],
    patchSize: number,
    initialX: number,
    initialY: number
): { x: number; y: number; fwhm: number; peak: number } | null {
    if (patch.length === 0) return null;
    const patchDim = 2 * patchSize + 1;
    const centerOffset = patchSize;

    const coords: { x: number, y: number }[] = [];
    const values: number[] = [];

    let hasSignal = false;
    for (let i = 0; i < patch.length; i++) {
        if (patch[i] > 1) { 
            hasSignal = true;
            const x = (i % patchDim) - centerOffset;
            const y = Math.floor(i / patchDim) - centerOffset;
            coords.push({ x, y });
            values.push(Math.log(patch[i]));
        }
    }

    if (!hasSignal || coords.length < 6) return null;

    const X_data = coords.map(c => [c.x * c.x, c.y * c.y, c.x * c.y, c.x, c.y, 1]);
    try {
        const X = matrix(X_data);
        const y = matrix(values);

        const Xt = transpose(X);
        const XtX = multiply(Xt, X);
        const XtY = multiply(Xt, y);

        const regularizedXtX = lusolve(XtX, XtY);
        const c = regularizedXtX.valueOf().flat() as number[];

        const [c_xx, c_yy, c_xy, c_x, c_y, c_0] = c;

        if (c_xx >= 0 || c_yy >= 0) return null;
        
        const det = 4 * c_xx * c_yy - c_xy * c_xy;
        if (det === 0) return null;

        const x_center = (c_xy * c_y - 2 * c_yy * c_x) / det;
        const y_center = (c_xy * c_x - 2 * c_xx * c_y) / det;

        const sigma_x_sq = -2 / det * c_yy;
        const sigma_y_sq = -2 / det * c_xx;
        
        if (sigma_x_sq <= 0 || sigma_y_sq <= 0) return null;

        const fwhm = 2.3548 * Math.sqrt((Math.sqrt(sigma_x_sq) + Math.sqrt(sigma_y_sq)) / 2);
        const peak = Math.exp(c_0 + c_x*x_center + c_y*y_center + c_xx*x_center*x_center + c_yy*y_center*y_center + c_xy*x_center*y_center);
        
        if (isNaN(fwhm) || fwhm < 1 || fwhm > patchSize) {
          return null;
        }

        return {
            x: initialX + x_center,
            y: initialY + y_center,
            fwhm: fwhm,
            peak: peak
        };
    } catch (error) {
        return null; 
    }
}


// --- 3) Star Detection (Blob + PSF) ---
function detectStars(
  gray: Uint8Array,
  width: number,
  height: number,
  threshold: number,
  minSize = 3,
  maxSize = 150
): Star[] {
  const visited = new Uint8Array(gray.length);
  const stars: Star[] = [];
  const psfPatchSize = 5; 

  function getNeighbors(pos: number): number[] {
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
  }

  function computeDescriptor(cx: number, cy: number): number[] {
    const patch: number[] = [];
    const patchRadius = 2; 
    for (let dy = -patchRadius; dy <= patchRadius; dy++) {
      for (let dx = -patchRadius; dx <= patchRadius; dx++) {
        const x = Math.round(cx + dx);
        const y = Math.round(cy + dy);
        if (x >= 0 && x < width && y >= 0 && y < height) {
          patch.push(gray[y * width + x] / 255.0); 
        } else {
          patch.push(0);
        }
      }
    }
    return patch;
  }


  for (let i = 0; i < gray.length; i++) {
    if (visited[i] || gray[i] < threshold) continue;

    const queue = [i];
    visited[i] = 1;
    const blobPixelsPos: number[] = [];
    let sumX = 0, sumY = 0, totalBrightness = 0;

    while (queue.length > 0) {
      const p = queue.shift()!;
      blobPixelsPos.push(p);

      const x = p % width;
      const y = Math.floor(p / width);
      const brightness = gray[p];
      sumX += x * brightness;
      sumY += y * brightness;
      totalBrightness += brightness;

      for (const n of getNeighbors(p)) {
        if (!visited[n] && gray[n] >= threshold) {
          visited[n] = 1;
          queue.push(n);
        }
      }
    }

    const count = blobPixelsPos.length;
    if (count >= minSize && count <= maxSize) {
        if (totalBrightness === 0) continue;
        const initialX = sumX / totalBrightness;
        const initialY = sumY / totalBrightness;

        const patch: number[] = [];
        for (let y = -psfPatchSize; y <= psfPatchSize; y++) {
            for (let x = -psfPatchSize; x <= psfPatchSize; x++) {
                const sampleX = Math.round(initialX + x);
                const sampleY = Math.round(initialY + y);
                if (sampleX >= 0 && sampleX < width && sampleY >= 0 && sampleY < height) {
                    patch.push(gray[sampleY * width + sampleX]);
                } else {
                    patch.push(0);
                }
            }
        }
        
        const psfResult = fitGaussianPSF(patch, psfPatchSize, initialX, initialY);
        
        if (psfResult && psfResult.peak > threshold) {
             stars.push({
              x: psfResult.x,
              y: psfResult.y,
              brightness: psfResult.peak,
              size: count,
              fwhm: psfResult.fwhm,
              descriptor: computeDescriptor(psfResult.x, psfResult.y),
            });
        }
    }
  }
  return stars;
}


// --- 4) Multi-scale detection (simple 2x downscale) ---
export function detectStarsMultiScale(
  imageData: ImageData,
  width: number,
  height: number,
  threshold: number
): Star[] {
  const gray = toGrayscale(imageData);
  const starsScale1 = detectStars(gray, width, height, threshold, 3);
  
  const width2 = Math.floor(width / 2);
  const height2 = Math.floor(height / 2);
  const gray2 = new Uint8Array(width2 * height2);
  for (let y = 0; y < height2; y++) {
    for (let x = 0; x < width2; x++) {
      const sum =
        gray[y * 2 * width + x * 2] +
        gray[y * 2 * width + x * 2 + 1] +
        gray[(y * 2 + 1) * width + x * 2] +
        gray[(y * 2 + 1) * width + x * 2 + 1];
      gray2[y * width2 + x] = Math.floor(sum / 4);
    }
  }
  const starsScale2Raw = detectStars(gray2, width2, height2, threshold, 3);
  const starsScale2 = starsScale2Raw.map(s => ({ ...s, x: s.x * 2, y: s.y * 2 }));
  
  const combined: Star[] = [...starsScale1];
  for (const s2 of starsScale2) {
    if (!combined.some(s1 => euclideanDist(s1, s2) < 5)) {
      combined.push(s2);
    }
  }
  return combined.sort((a, b) => b.brightness - a.brightness);
}

// --- 5) Euclidean distance ---
function euclideanDist(p1: Point, p2: Point): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// --- 6) Descriptor distance ---
function descriptorDist(d1: number[], d2: number[]): number {
  let sum = 0;
  for (let i = 0; i < d1.length; i++) {
    const diff = d1[i] - d2[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}


// --- 8) Feature matching ---
function matchFeatures(
  stars1: Star[],
  stars2: Star[],
  maxDistance = 25,
  descriptorThreshold = 0.5
): [Star, Star][] {
    if (stars1.length === 0 || stars2.length === 0) return [];
    
    const matches: [Star, Star][] = [];

    for (const s1 of stars1) {
        let bestMatch: Star | null = null;
        let bestDist = Infinity;

        for (const s2 of stars2) {
            const d = descriptorDist(s1.descriptor, s2.descriptor);
            if (d < bestDist && d < descriptorThreshold && euclideanDist(s1, s2) < maxDistance) {
                bestDist = d;
                bestMatch = s2;
            }
        }
        
        if (bestMatch) {
            matches.push([s1, bestMatch]);
        }
    }
    return matches;
}


// --- 9) Estimate similarity transform ---
function estimateSimilarityTransform(
  points1: Point[],
  points2: Point[]
): { scale: number; rotation: number; translation: Point } | null {
  if (points1.length < 2 || points2.length < 2) return null;
  const n = Math.min(points1.length, points2.length);
  const centroid1 = points1.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  const centroid2 = points2.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  centroid1.x /= n; centroid1.y /= n;
  centroid2.x /= n; centroid2.y /= n;

  const centered1 = points1.map(p => ({ x: p.x - centroid1.x, y: p.y - centroid1.y }));
  const centered2 = points2.map(p => ({ x: p.x - centroid2.x, y: p.y - centroid2.y }));

  let var1 = 0, cov_xx = 0, cov_xy = 0, cov_yx = 0, cov_yy = 0;
  for (let i = 0; i < n; i++) {
    var1 += centered1[i].x * centered1[i].x + centered1[i].y * centered1[i].y;
    cov_xx += centered2[i].x * centered1[i].x;
    cov_xy += centered2[i].x * centered1[i].y;
    cov_yx += centered2[i].y * centered1[i].x;
    cov_yy += centered2[i].y * centered1[i].y;
  }
  if (var1 === 0) return null;

  const a = cov_xx + cov_yy;
  const b = cov_yx - cov_xy;
  const scale = Math.sqrt(a * a + b * b) / var1;
  const rotation = Math.atan2(b, a);
  const translation = {
    x: centroid2.x - scale * (Math.cos(rotation) * centroid1.x - Math.sin(rotation) * centroid1.y),
    y: centroid2.y - scale * (Math.sin(rotation) * centroid1.x + Math.cos(rotation) * centroid1.y),
  };
  return { scale, rotation, translation };
}

// --- 10) RANSAC to robustly estimate similarity transform ---
function estimateSimilarityTransformRANSAC(
  points1: Point[],
  points2: Point[],
  iterations = 100,
  threshold = 3
): { scale: number; rotation: number; translation: Point } | null {
  if (points1.length < 3 || points2.length < 3) return null;
  let bestInliers: number[] = [];
  let bestTransform: ReturnType<typeof estimateSimilarityTransform> | null = null;
  for (let iter = 0; iter < iterations; iter++) {
    const idx1 = Math.floor(Math.random() * points1.length);
    let idx2 = Math.floor(Math.random() * points1.length);
    while (idx2 === idx1) idx2 = Math.floor(Math.random() * points1.length);
    const samplePoints1 = [points1[idx1], points1[idx2]];
    const samplePoints2 = [points2[idx1], points2[idx2]];
    const candidate = estimateSimilarityTransform(samplePoints1, samplePoints2);
    if (!candidate) continue;
    const inliers: number[] = [];
    for (let i = 0; i < points1.length; i++) {
      const warped = warpPoint(points1[i], candidate);
      if (euclideanDist(warped, points2[i]) < threshold) {
        inliers.push(i);
      }
    }
    if (inliers.length > bestInliers.length) {
      bestInliers = inliers;
      bestTransform = candidate;
    }
  }
  if (bestInliers.length < 3 || !bestTransform) return null;
  const inlierPoints1 = bestInliers.map(i => points1[i]);
  const inlierPoints2 = bestInliers.map(i => points2[i]);
  return estimateSimilarityTransform(inlierPoints1, inlierPoints2);
}

// --- 11) Warp a single point ---
function warpPoint(p: Point, params: { scale: number; rotation: number; translation: Point }): Point {
  const { scale, rotation, translation } = params;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  return {
    x: scale * (cosR * p.x - sinR * p.y) + translation.x,
    y: scale * (sinR * p.x + cosR * p.y) + translation.y,
  };
}

// --- 12) Warp image with BILINEAR INTERPOLATION ---
function warpImage(
    srcData: Uint8ClampedArray,
    srcWidth: number,
    srcHeight: number,
    transform: { scale: number; rotation: number; translation: Point }
): Uint8ClampedArray {
    const dstData = new Uint8ClampedArray(srcData.length);
    const cosR = Math.cos(-transform.rotation);
    const sinR = Math.sin(-transform.rotation);
    if (transform.scale === 0) return dstData;
    const invScale = 1 / transform.scale;

    for (let y = 0; y < srcHeight; y++) {
        for (let x = 0; x < srcWidth; x++) {
            const dstIdx = (y * srcWidth + x) * 4;

            const dx = x - transform.translation.x;
            const dy = y - transform.translation.y;
            const srcX = invScale * (cosR * dx - sinR * dy);
            const srcY = invScale * (sinR * dx + cosR * dy);
            
            const x0 = Math.floor(srcX);
            const y0 = Math.floor(srcY);
            
            if (x0 < 0 || x0 >= srcWidth - 1 || y0 < 0 || y0 >= srcHeight - 1) {
                dstData[dstIdx + 3] = 0; // Mark as transparent if outside bounds
                continue;
            }

            const x1 = x0 + 1;
            const y1 = y0 + 1;
            const x_frac = srcX - x0;
            const y_frac = srcY - y0;
            
            const c00_idx = (y0 * srcWidth + x0) * 4;
            const c00_alpha = srcData[c00_idx + 3];

            if (c00_alpha === 0) { 
                dstData[dstIdx + 3] = 0;
                continue;
            }

            for (let channel = 0; channel < 3; channel++) { 
                const c00 = srcData[c00_idx + channel];
                const c10 = srcData[(y0 * srcWidth + x1) * 4 + channel];
                const c01 = srcData[(y1 * srcWidth + x0) * 4 + channel];
                const c11 = srcData[(y1 * srcWidth + x1) * 4 + channel];
                
                const top = c00 * (1 - x_frac) + c10 * x_frac;
                const bottom = c01 * (1 - x_frac) + c11 * x_frac;
                const val = top * (1 - y_frac) + bottom * y_frac;
                
                dstData[dstIdx + channel] = val;
            }
            dstData[dstIdx + 3] = 255;
        }
    }
    return dstData;
}


// --- 13) Stacking implementations ---

function stackImagesAverage(images: (Uint8ClampedArray | null)[]): Uint8ClampedArray {
    const validImages = images.filter((img): img is Uint8ClampedArray => img !== null);
    if (validImages.length === 0) throw new Error("No valid images to stack");
    const length = validImages[0].length;
    const accum = new Float32Array(length);
    const counts = new Uint8Array(length / 4);

    for (const img of validImages) {
        for (let i = 0; i < length; i += 4) {
            if (img[i + 3] > 128) {
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
                if (img[i + 3] > 128) {
                    pixelValues.push(img[i + channel]);
                }
            }
            if (pixelValues.length > 2) {
                result[i + channel] = median(pixelValues);
            } else if (pixelValues.length > 0) {
                 result[i + channel] = pixelValues.reduce((a, b) => a + b, 0) / pixelValues.length;
            }
        }
        
        const validCount = validImages.filter(img => img[i+3] > 128).length;
        result[i + 3] = validCount > 0 ? 255 : 0;
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
                if (img[i + 3] > 128) {
                    pixelValues.push(img[i + channel]);
                }
            }

            if (pixelValues.length < 3) {
                if (pixelValues.length > 0) {
                    result[i + channel] = pixelValues.reduce((a, b) => a + b, 0) / pixelValues.length;
                }
                continue;
            }
            
            const mu = mean(pixelValues);
            const stdev = std(pixelValues);
            if (stdev === 0) {
                 result[i + channel] = mu;
                 continue;
            }

            const threshold = sigma * stdev;
            const filtered = pixelValues.filter(v => Math.abs(v - mu) < threshold);
            
            if (filtered.length > 0) {
                result[i + channel] = filtered.reduce((a, b) => a + b, 0) / filtered.length;
            } else {
                 result[i + channel] = median(pixelValues);
            }
        }
        const validCount = validImages.filter(img => img[i+3] > 128).length;
        result[i + 3] = validCount > 0 ? 255 : 0;
    }
    return result;
}

// --- NEW --- Find stars that are shared across all images
function findSharedStars(
  allEntries: ImageQueueEntry[],
  addLog: (message: string) => void
): Star[] {
  if (allEntries.length < 2) return allEntries[0]?.detectedStars || [];
  
  const refStars = allEntries[0].detectedStars;
  let sharedStars = refStars;

  for (let i = 1; i < allEntries.length; i++) {
    const targetStars = allEntries[i].detectedStars;
    const matches = matchFeatures(sharedStars, targetStars);
    
    // The new set of shared stars are the ones from the *original* reference list
    // that had a match in this target image.
    sharedStars = matches.map(([refStar, _]) => refStar);
    addLog(`Found ${sharedStars.length} shared stars between reference and image ${i}`);
  }
  
  addLog(`Found a final set of ${sharedStars.length} stars common to all images.`);
  return sharedStars;
}


// --- 14) Main alignment function ---
export async function alignAndStack(
  imageEntries: ImageQueueEntry[],
  manualRefStars: Star[],
  mode: StackingMode,
  addLog: (message: string) => void,
  setProgress: (progress: number) => void
): Promise<Uint8ClampedArray> {
  if (imageEntries.length === 0 || !imageEntries[0].imageData) {
    throw new Error("No valid images provided.");
  }

  const MIN_STARS_FOR_ALIGNMENT = 10;
  const refEntry = imageEntries[0];
  const { width, height } = refEntry.imageData;
  let alignedImageDatas: (Uint8ClampedArray | null)[] = [refEntry.imageData.data];
  
  // Use manually selected stars if present, otherwise find stars shared across all images.
  const allRefStars = manualRefStars.length > 0 
    ? manualRefStars 
    : findSharedStars(imageEntries, addLog);

  if (allRefStars.length < 3) {
    addLog(`Warning: Fewer than 3 reference stars (${allRefStars.length}) found across all images. Alignment quality may be poor or fail.`);
  }

  for (let i = 1; i < imageEntries.length; i++) {
    const targetEntry = imageEntries[i];
    const progress = (i + 1) / imageEntries.length;

    if (!targetEntry.imageData) {
      addLog(`Skipping image ${i} due to missing image data.`);
      alignedImageDatas.push(null);
      setProgress(progress);
      continue;
    }

    if (targetEntry.detectedStars.length < MIN_STARS_FOR_ALIGNMENT) {
      addLog(`Skipping image ${i}: Found only ${targetEntry.detectedStars.length} stars (min ${MIN_STARS_FOR_ALIGNMENT} required).`);
      alignedImageDatas.push(null);
      setProgress(progress);
      continue;
    }
    
    // Match the shared reference stars to the current target image's stars
    const matches = matchFeatures(allRefStars, targetEntry.detectedStars);
    
    if (matches.length < 3) {
      addLog(`Skipping image ${i}: Could not find enough matches (${matches.length}) to the shared star pattern.`);
      alignedImageDatas.push(null);
      setProgress(progress);
      continue;
    }

    addLog(`Image ${i}: Found ${matches.length} matches to the shared star pattern.`);
    
    const ransacPoints1 = matches.map(m => m[0]);
    const ransacPoints2 = matches.map(m => m[1]);
    const transform = estimateSimilarityTransformRANSAC(ransacPoints1, ransacPoints2);
      
    if (transform) {
      const warpedData = warpImage(targetEntry.imageData.data, width, height, transform);
      alignedImageDatas.push(warpedData);
      addLog(`Image ${i}: Aligned using RANSAC with shared stars.`);
    } else {
      addLog(`Skipping image ${i}: Could not determine transform with RANSAC.`);
      alignedImageDatas.push(null);
    }
    setProgress(progress);
  }

  addLog("All images processed. Stacking...");

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
