
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


// --- 3) Star Detection (Blob + Center of Mass) ---
function detectStars(
  imageData: ImageData,
  width: number,
  height: number,
  threshold: number,
  minSize = 3,
  maxSize = 250
): Star[] {
  const gray = toGrayscale(imageData);
  const visited = new Uint8Array(gray.length);
  const stars: Star[] = [];

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
    const blobPixelsPos: number[] = [];
    let sumX = 0, sumY = 0, totalBrightness = 0, peakBrightness = 0;

    while (queue.length > 0) {
      const p = queue.shift()!;
      blobPixelsPos.push(p);

      const x = p % width;
      const y = Math.floor(p / width);
      const brightness = gray[p];

      sumX += x * brightness;
      sumY += y * brightness;
      totalBrightness += brightness;
      if (brightness > peakBrightness) peakBrightness = brightness;

      for (const n of getNeighbors(p)) {
        if (!visited[n] && gray[n] >= threshold) {
          visited[n] = 1;
          queue.push(n);
        }
      }
    }

    const count = blobPixelsPos.length;
    if (count >= minSize && count <= maxSize && totalBrightness > 0) {
      const cx = sumX / totalBrightness;
      const cy = sumY / totalBrightness;

      let sumDistSq = 0;
      for (const p of blobPixelsPos) {
        const x = p % width;
        const y = Math.floor(p / width);
        sumDistSq += (x - cx) ** 2 + (y - cy) ** 2;
      }
      
      const avgDist = Math.sqrt(sumDistSq / count);
      const fwhm = 2.0 * avgDist; // Simplified FWHM estimation

      if (fwhm > 0) {
        stars.push({
          x: cx,
          y: cy,
          brightness: peakBrightness,
          size: count,
          fwhm: fwhm,
          descriptor: [] // Descriptor will be built later if needed
        });
      }
    }
  }

  // Return top 50 brightest stars, which are most likely to be reliable
  return stars.sort((a, b) => b.brightness - a.brightness).slice(0, 50);
}


// --- 4) Multi-scale detection ---
export function detectStarsMultiScale(
  imageData: ImageData,
  width: number,
  height: number,
  threshold: number
): Star[] {
  // For now, focusing on single-scale robustness.
  // The multi-scale logic can sometimes introduce noise.
  return detectStars(imageData, width, height, threshold, 3, 250);
}


// --- 5) Euclidean distance ---
function euclideanDist(p1: Point, p2: Point): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}


// --- 8) Triangle-based Feature Matching ---
function getTriangleHash(p1: Star, p2: Star, p3: Star) {
  const sides = [euclideanDist(p2, p3), euclideanDist(p1, p3), euclideanDist(p1, p2)].sort((a, b) => a - b);
  if (sides[0] < 1e-6) return null;
  return `${(sides[1] / sides[0]).toFixed(2)}:${(sides[2] / sides[0]).toFixed(2)}`;
}

function findTriangleMatches(stars1: Star[], stars2: Star[], addLog: (message: string) => void): [Star, Star][] {
  if (stars1.length < 3 || stars2.length < 3) return [];

  const map1 = new Map<string, [Star, Star, Star]>();
  for (let i = 0; i < stars1.length; i++) {
    for (let j = i + 1; j < stars1.length; j++) {
      for (let k = j + 1; k < stars1.length; k++) {
        const hash = getTriangleHash(stars1[i], stars1[j], stars1[k]);
        if (hash) map1.set(hash, [stars1[i], stars1[j], stars1[k]]);
      }
    }
  }

  if (map1.size === 0) {
    addLog("Could not form any unique triangles from reference image.");
    return [];
  }
  
  const correspondences: [Star, Star][] = [];
  const usedStars2 = new Set<Star>();

  for (let i = 0; i < stars2.length; i++) {
    for (let j = i + 1; j < stars2.length; j++) {
      for (let k = j + 1; k < stars2.length; k++) {
        const t2 = [stars2[i], stars2[j], stars2[k]];
        const hash = getTriangleHash(t2[0], t2[1], t2[2]);
        
        if (hash && map1.has(hash)) {
          const t1 = map1.get(hash)!;
          
          // Check if any of these stars have been used
          if (t2.some(s => usedStars2.has(s))) continue;

          // Add correspondences and mark stars as used
          for(let m = 0; m < 3; m++) {
            correspondences.push([t1[m], t2[m]]);
            usedStars2.add(t2[m]);
          }
        }
      }
    }
  }

  addLog(`Found ${correspondences.length} corresponding points via triangle matching.`);
  return correspondences;
}


// --- 9) Estimate similarity transform ---
function estimateSimilarityTransform(
  points1: Point[],
  points2: Point[]
): { scale: number; rotation: number; translation: Point } | null {
  if (points1.length < 2 || points2.length < 2) return null;
  const n = points1.length; // Use points1 length
  let centroid1 = { x: 0, y: 0 }, centroid2 = { x: 0, y: 0 };
  points1.forEach(p => { centroid1.x += p.x; centroid1.y += p.y; });
  points2.forEach(p => { centroid2.x += p.x; centroid2.y += p.y; });
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
  if (Math.abs(var1) < 1e-9) return null;

  const a = cov_xx + cov_yy;
  const b = cov_yx - cov_xy;
  const scale = Math.sqrt(a * a + b * b) / var1;
  const rotation = Math.atan2(b, a);

  if (isNaN(scale) || isNaN(rotation)) return null;
  
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
  iterations = 200, // More iterations for robustness
  threshold = 2.0   // Tighter threshold for accuracy
): { scale: number; rotation: number; translation: Point } | null {
  if (points1.length < 3) return null;
  let bestInliers: number[] = [];
  let bestTransform: ReturnType<typeof estimateSimilarityTransform> | null = null;

  for (let iter = 0; iter < iterations; iter++) {
    // Select 3 random points for a more stable estimate
    const indices: number[] = [];
    while (indices.length < 3) {
      const idx = Math.floor(Math.random() * points1.length);
      if (!indices.includes(idx)) {
        indices.push(idx);
      }
    }
    const samplePoints1 = indices.map(i => points1[i]);
    const samplePoints2 = indices.map(i => points2[i]);
    
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
    }
  }

  if (bestInliers.length < 3) return null;

  const inlierPoints1 = bestInliers.map(i => points1[i]);
  const inlierPoints2 = bestInliers.map(i => points2[i]);
  
  // Final transform based on the best set of inliers
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
    if (Math.abs(transform.scale) < 1e-9) return dstData;

    // Create inverse transform
    const cosR = Math.cos(-transform.rotation);
    const sinR = Math.sin(-transform.rotation);
    const invScale = 1 / transform.scale;
    const transX = -transform.translation.x;
    const transY = -transform.translation.y;

    for (let y = 0; y < srcHeight; y++) {
        for (let x = 0; x < srcWidth; x++) {
            const dstIdx = (y * srcWidth + x) * 4;

            // Apply inverse transform to find where destination pixel (x,y) comes from in the source
            const srcX_untranslated = x + transX;
            const srcY_untranslated = y + transY;

            const srcX_rotated = srcX_untranslated * cosR - srcY_untranslated * sinR;
            const srcY_rotated = srcX_untranslated * sinR + srcY_untranslated * cosR;

            const srcX = srcX_rotated * invScale;
            const srcY = srcY_rotated * invScale;
            
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
            
            for (let channel = 0; channel < 3; channel++) { 
                const c00 = srcData[(y0 * srcWidth + x0) * 4 + channel];
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

  const refEntry = imageEntries[0];
  const { width, height } = refEntry.imageData;
  const alignedImageDatas: (Uint8ClampedArray | null)[] = [refEntry.imageData.data];
  
  const refStars = manualRefStars.length > 0 
    ? manualRefStars 
    : refEntry.detectedStars;

  if (refStars.length < 3) {
      addLog(`Warning: Reference image has fewer than 3 stars (${refStars.length}). Alignment will likely fail.`);
  }


  for (let i = 1; i < imageEntries.length; i++) {
    const targetEntry = imageEntries[i];
    const progress = (i + 1) / imageEntries.length;

    addLog(`--- Aligning Image ${i+1}/${imageEntries.length} ---`);

    if (!targetEntry.imageData) {
      addLog(`Skipping image ${i}: missing image data.`);
      alignedImageDatas.push(null);
      setProgress(progress);
      continue;
    }
    if (targetEntry.detectedStars.length < 3) {
      addLog(`Skipping image ${i}: not enough stars detected (${targetEntry.detectedStars.length}).`);
      alignedImageDatas.push(null);
      setProgress(progress);
      continue;
    }

    // Match the shared reference stars to the current target image's stars
    const matches = findTriangleMatches(refStars, targetEntry.detectedStars, addLog);
    
    if (matches.length < 3) {
      addLog(`Skipping image ${i}: Could not find enough triangle matches (${matches.length}).`);
      alignedImageDatas.push(null);
      setProgress(progress);
      continue;
    }
    
    const ransacPoints1 = matches.map(m => m[0]);
    const ransacPoints2 = matches.map(m => m[1]);
    const transform = estimateSimilarityTransformRANSAC(ransacPoints1, ransacPoints2);
      
    if (transform) {
      addLog(`Image ${i}: Found transform: S: ${transform.scale.toFixed(3)}, R: ${(transform.rotation * 180 / Math.PI).toFixed(3)}°, T:(${transform.translation.x.toFixed(2)}, ${transform.translation.y.toFixed(2)})`);
      const warpedData = warpImage(targetEntry.imageData.data, width, height, transform);
      alignedImageDatas.push(warpedData);
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
