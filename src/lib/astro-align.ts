
// --- Types ---
export type Point = { x: number; y: number };
export type Star = Point & { brightness: number; size: number; descriptor: number[] };

// --- 1) Grayscale conversion ---
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

// --- 2) Blob detection + star descriptor ---
function detectStars(
  gray: Uint8Array,
  width: number,
  height: number,
  threshold: number,
  minSize = 3
): Star[] {
  const visited = new Uint8Array(gray.length);
  const stars: Star[] = [];
  function neighbors(pos: number): number[] {
    const neighbors = [];
    const x = pos % width;
    const y = Math.floor(pos / width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) neighbors.push(ny * width + nx);
      }
    }
    return neighbors;
  }
  function computeDescriptor(cx: number, cy: number): number[] {
    const patch: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < width && y >= 0 && y < height) {
          patch.push(gray[y * width + x] / 255);
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
    let sumX = 0, sumY = 0, count = 0, brightnessSum = 0;
    while (queue.length > 0) {
      const p = queue.pop()!;
      const x = p % width;
      const y = Math.floor(p / width);
      sumX += x;
      sumY += y;
      brightnessSum += gray[p];
      count++;
      for (const n of neighbors(p)) {
        if (!visited[n] && gray[n] >= threshold) {
          visited[n] = 1;
          queue.push(n);
        }
      }
    }
    if (count >= minSize) {
      const cx = sumX / count;
      const cy = sumY / count;
      const brightness = brightnessSum / count;
      const desc = computeDescriptor(Math.round(cx), Math.round(cy));
      stars.push({ x: cx, y: cy, brightness, size: count, descriptor: desc });
    }
  }
  return stars;
}

// --- 3) Multi-scale detection (simple 2x downscale) ---
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
  return combined;
}

// --- 4) Euclidean distance ---
function euclideanDist(p1: Point, p2: Point): number {
  const dx = p1.x - p2.x, dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// --- 5) Descriptor distance ---
function descriptorDist(d1: number[], d2: number[]): number {
  let sum = 0;
  for (let i = 0; i < d1.length; i++) {
    const diff = d1[i] - d2[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// --- 6) KD-tree for stars ---
class KDNode {
    point: Star;
    left: KDNode | null = null;
    right: KDNode | null = null;
    axis: 0 | 1;
    constructor(points: Star[], depth = 0) {
      this.axis = (depth % 2) as 0 | 1;
      points.sort((a, b) => (this.axis === 0 ? a.x - b.x : a.y - b.y));
      const median = Math.floor(points.length / 2);
      this.point = points[median];
      if (median > 0) this.left = points.slice(0, median).length > 0 ? new KDNode(points.slice(0, median), depth + 1) : null;
      if (median + 1 < points.length) this.right = points.slice(median + 1).length > 0 ? new KDNode(points.slice(median + 1), depth + 1) : null;
    }
    nearest(point: Point, best: { star: Star | null; dist: number }, maxDist: number): { star: Star | null; dist: number } {
      if (!this.point) return best;
      const d = euclideanDist(this.point, point);
      if (d < best.dist && d < maxDist) {
        best.star = this.point;
        best.dist = d;
      }
      const diff = this.axis === 0 ? point.x - this.point.x : point.y - this.point.y;
      const first = diff < 0 ? this.left : this.right;
      const second = diff < 0 ? this.right : this.left;
      if (first) best = first.nearest(point, best, maxDist);
      if (second && Math.abs(diff) < best.dist) best = second.nearest(point, best, maxDist);
      return best;
    }
  }

// --- 7) Feature matching with kd-tree + ratio test ---
function matchFeatures(
  stars1: Star[],
  stars2: Star[],
  maxDistance = 15,
  descriptorThreshold = 0.4
): [Star, Star][] {
  if (stars2.length === 0) return [];
  const tree = new KDNode(stars2);
  const matches: [Star, Star][] = [];
  for (const s1 of stars1) {
    const bestNeighbor = tree.nearest(s1, { star: null, dist: maxDistance }, maxDistance);
    if (!bestNeighbor.star) continue;
    const dDist = descriptorDist(s1.descriptor, bestNeighbor.star.descriptor);
    if (dDist > descriptorThreshold) continue;
    
    let secondDist = Infinity;
    for (const s2 of stars2) {
      if (s2 === bestNeighbor.star) continue;
      if (euclideanDist(s1, s2) > maxDistance) continue;
      const descD = descriptorDist(s1.descriptor, s2.descriptor);
      if (descD < secondDist) secondDist = descD;
    }
    if (secondDist > 0 && dDist / secondDist < 0.75) {
      matches.push([s1, bestNeighbor.star]);
    }
  }
  return matches;
}

// --- 8) Estimate similarity transform ---
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

// --- 9) RANSAC to robustly estimate similarity transform ---
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

// --- 10) Warp a single point ---
function warpPoint(p: Point, params: { scale: number; rotation: number; translation: Point }): Point {
  const { scale, rotation, translation } = params;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  return {
    x: scale * (cosR * p.x - sinR * p.y) + translation.x,
    y: scale * (sinR * p.x + cosR * p.y) + translation.y,
  };
}

// --- 11) Warp image with BILINEAR INTERPOLATION ---
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
            const x1 = x0 + 1;
            const y1 = y0 + 1;

            if (x0 >= 0 && x1 < srcWidth && y0 >= 0 && y1 < srcHeight) {
                const x_frac = srcX - x0;
                const y_frac = srcY - y0;

                for (let channel = 0; channel < 4; channel++) {
                    const c00 = srcData[(y0 * srcWidth + x0) * 4 + channel];
                    const c10 = srcData[(y0 * srcWidth + x1) * 4 + channel];
                    const c01 = srcData[(y1 * srcWidth + x0) * 4 + channel];
                    const c11 = srcData[(y1 * srcWidth + x1) * 4 + channel];
                    
                    if (channel === 3) {
                         dstData[dstIdx + 3] = c00; // Use nearest for alpha
                         continue;
                    }

                    const top = c00 * (1 - x_frac) + c10 * x_frac;
                    const bottom = c01 * (1 - x_frac) + c11 * x_frac;
                    const val = top * (1 - y_frac) + bottom * y_frac;
                    
                    dstData[dstIdx + channel] = val;
                }
            } else {
                 dstData[dstIdx] = 0;
                 dstData[dstIdx + 1] = 0;
                 dstData[dstIdx + 2] = 0;
                 dstData[dstIdx + 3] = 0;
            }
        }
    }
    return dstData;
}


// --- 12) Stack images by averaging ---
function stackImages(images: (Uint8ClampedArray | null)[]): Uint8ClampedArray {
    const validImages = images.filter((img): img is Uint8ClampedArray => img !== null);
    if (validImages.length === 0) throw new Error("No valid images to stack");
    const length = validImages[0].length;
    const accum = new Float32Array(length);
    for (const img of validImages) {
        for (let i = 0; i < length; i++) {
        accum[i] += img[i];
        }
    }
    const count = validImages.length;
    const result = new Uint8ClampedArray(length);
    for (let i = 0; i < length; i++) {
        result[i] = Math.min(255, accum[i] / count);
    }
    return result;
}

// --- 13) Main alignment function ---
export async function alignAndStack(
  imageEntries: { imageData: ImageData | null; detectedStars: Star[] }[],
  manualRefStars: Star[],
  addLog: (message: string) => void,
  setProgress: (progress: number) => void
): Promise<Uint8ClampedArray> {
  if (imageEntries.length === 0 || !imageEntries[0].imageData) {
    throw new Error("No valid images provided.");
  }

  const refEntry = imageEntries[0];
  const { width, height } = refEntry.imageData;
  let alignedImageDatas: (Uint8ClampedArray | null)[] = [refEntry.imageData.data];
  
  const allRefStars = manualRefStars.length > 0 ? manualRefStars : refEntry.detectedStars;
  if (allRefStars.length < 3) {
    addLog("Warning: Fewer than 3 reference stars. Alignment quality may be poor. Falling back to simple feature matching.");
  }
  
  const anchors_ref: Star[] = [];
  const tempRefStars = [...allRefStars];
  while (anchors_ref.length < 3 && tempRefStars.length > 0) {
    const candidate = tempRefStars.shift()!;
    if (anchors_ref.every(anchor => euclideanDist(anchor, candidate) > 50)) {
        anchors_ref.push(candidate);
    }
  }
  if (anchors_ref.length < 2) {
    addLog("Warning: Could not select at least 2 unique anchor stars for rotation calculation. Falling back to simple matching.");
  }

  const patterns_ref = anchors_ref.map(anchor => 
      allRefStars.filter(s => s !== anchor).map(s => ({ x: s.x - anchor.x, y: s.y - anchor.y }))
  );
  addLog(`Created ${patterns_ref.length} star patterns for propagation.`);
  
  let last_known_anchors: Point[] = [...anchors_ref];

  for (let i = 1; i < imageEntries.length; i++) {
    const targetEntry = imageEntries[i];
    if (!targetEntry.imageData) {
      addLog(`Skipping image ${i} due to missing image data.`);
      alignedImageDatas.push(null);
      setProgress(i / imageEntries.length);
      continue;
    }
    
    let transform: { scale: number; rotation: number; translation: Point } | null = null;
    let propagationSuccess = false;
    
    if (anchors_ref.length >= 2) {
        const p1: Point[] = [];
        const p2: Point[] = [];
        let new_last_knowns: Point[] = [];

        for (let j = 0; j < anchors_ref.length; j++) {
            const lastKnownPos = last_known_anchors[j];
            if (!lastKnownPos) continue; 
            const pattern = patterns_ref[j];
            const targetStars = targetEntry.detectedStars;
            
            const SEARCH_RADIUS = 30;
            const candidates = targetStars
                .filter(s => euclideanDist(s, lastKnownPos) < SEARCH_RADIUS)
                .sort((a,b) => euclideanDist(a, lastKnownPos) - euclideanDist(b, lastKnownPos))
                .slice(0, 5);

            let bestMatch = { score: -1, star: null as Star | null };

            for (const candidate of candidates) {
                let score = 0;
                for (const patternVector of pattern) {
                    const expectedPos = { x: candidate.x + patternVector.x, y: candidate.y + patternVector.y };
                    if (targetStars.some(s => euclideanDist(s, expectedPos) < 5)) {
                        score++;
                    }
                }
                if (score > bestMatch.score) {
                    bestMatch = { score, star: candidate };
                }
            }

            if (bestMatch.star) {
                p1.push(anchors_ref[j]);
                p2.push(bestMatch.star);
                new_last_knowns.push(bestMatch.star);
            } else {
                new_last_knowns.push(lastKnownPos); // Carry over the old position if not found
            }
        }
        
        last_known_anchors = new_last_knowns;
        
        if (p1.length >= 2) {
            transform = estimateSimilarityTransform(p1, p2);
            if (transform) {
                addLog(`Image ${i}: Aligned using ${p1.length}-point propagated pattern.`);
                propagationSuccess = true;
            }
        }
    }

    if (!propagationSuccess) {
      addLog(`Image ${i}: Pattern propagation failed. Resetting anchors and falling back to feature matching.`);
      last_known_anchors = [...anchors_ref]; // Reset for next image
      const matches = matchFeatures(allRefStars, targetEntry.detectedStars);
      if (matches.length >= 3) {
        const points1 = matches.map(m => m[0]);
        const points2 = matches.map(m => m[1]);
        transform = estimateSimilarityTransformRANSAC(points1, points2);
        if (transform) {
          addLog(`Image ${i}: Aligned using RANSAC fallback (${matches.length} initial matches).`);
        }
      }
    }
      
    if (transform) {
      const warpedData = warpImage(targetEntry.imageData.data, width, height, transform);
      alignedImageDatas.push(warpedData);
    } else {
      addLog(`Image ${i}: Could not determine transform. Stacking unaligned.`);
      alignedImageDatas.push(targetEntry.imageData.data);
    }
    setProgress(i / imageEntries.length);
  }

  setProgress(1);
  addLog("All images aligned. Stacking...");
  return stackImages(alignedImageDatas);
}
