
'use client';

import type { Star } from '@/types';
import { detectBrightBlobs } from './astro-align';

interface StarCandidate extends Star {
  pixels: { x: number; y: number; brightness: number }[];
  fwhm: number;
  roundness: number;
  peak: number;
}

/**
 * A more advanced star detection algorithm inspired by professional astrophotography software like Siril.
 * It identifies star candidates and then analyzes their profiles to filter out non-stellar objects.
 */
export function detectStarsAdvanced(
  imageData: ImageData,
  addLog: (message: string) => void
): Star[] {
  const { width, height, data } = imageData;
  addLog(`[ADVANCED DETECT] Starting advanced detection on ${width}x${height} image.`);

  // --- Step 1: Background and Noise Estimation ---
  // Create a grayscale image for analysis
  const grayData = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    grayData[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  // Use histogram to find the mode of the background pixels (most common value)
  const histogram = new Uint32Array(256);
  for (let i = 0; i < grayData.length; i++) {
    histogram[grayData[i]]++;
  }
  
  let backgroundLevel = 0;
  let maxCount = 0;
  for (let i = 0; i < 256; i++) {
    if (histogram[i] > maxCount) {
      maxCount = histogram[i];
      backgroundLevel = i;
    }
  }

  // Estimate noise (standard deviation of background)
  let sumOfSquares = 0;
  let count = 0;
  const noiseEstimationRange = 10;
  for (let i = 0; i < grayData.length; i++) {
    if (Math.abs(grayData[i] - backgroundLevel) < noiseEstimationRange) {
      sumOfSquares += (grayData[i] - backgroundLevel) ** 2;
      count++;
    }
  }
  const noiseStdDev = Math.sqrt(sumOfSquares / count) || 1;
  const detectionThreshold = backgroundLevel + 3.0 * noiseStdDev;

  addLog(`[ADVANCED DETECT] Background: ${backgroundLevel.toFixed(2)}, Noise (σ): ${noiseStdDev.toFixed(2)}, Threshold: ${detectionThreshold.toFixed(2)}`);

  // --- Step 2: Find Star Candidates (Blobs) ---
  const candidates = findBlobs(grayData, width, height, detectionThreshold);
  addLog(`[ADVANCED DETECT] Found ${candidates.length} initial candidates (blobs).`);

  // --- Step 3: Analyze Profile of Each Candidate ---
  const characterizedStars: StarCandidate[] = [];
  for (const cand of candidates) {
    const analysis = analyzeStarProfile(cand, grayData, width);
    if (analysis) {
      characterizedStars.push({ ...cand, ...analysis });
    }
  }
  addLog(`[ADVANCED DETECT] Successfully analyzed profiles of ${characterizedStars.length} candidates.`);

  // --- Step 4: Filter based on Profile Characteristics ---
  const finalStars = characterizedStars.filter(star => {
    const isRound = star.roundness < 1.8; // Allow for some oblong stars
    const isNotTooSmall = star.fwhm > 1.2; // Filter out hot pixels
    const isNotTooLarge = star.fwhm < 25.0; // Filter out large nebulous objects
    return isRound && isNotTooSmall && isNotTooLarge;
  });

  addLog(`[ADVANCED DETECT] Filtering complete. Final star count: ${finalStars.length}.`);

  return finalStars.sort((a, b) => b.brightness - a.brightness);
}


/**
 * Finds connected components of pixels above a threshold.
 */
function findBlobs(
  grayData: Uint8Array,
  width: number,
  height: number,
  threshold: number
): StarCandidate[] {
  const visited = new Uint8Array(width * height);
  const candidates: StarCandidate[] = [];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (visited[i] || grayData[i] < threshold) continue;

      const blob: { x: number; y: number; brightness: number }[] = [];
      const queue: { x: number; y: number }[] = [{ x, y }];
      visited[i] = 1;
      let peak = 0;

      while (queue.length > 0) {
        const { x: cx, y: cy } = queue.shift()!;
        const c_idx = cy * width + cx;
        const brightness = grayData[c_idx];
        
        if (brightness > peak) peak = brightness;

        blob.push({ x: cx, y: cy, brightness });

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            const n_idx = ny * width + nx;
            if (nx > 0 && nx < width - 1 && ny > 0 && ny < height - 1 && !visited[n_idx] && grayData[n_idx] > threshold) {
              visited[n_idx] = 1;
              queue.push({ x: nx, y: ny });
            }
          }
        }
      }
      
      if (blob.length > 2 && blob.length < 500) {
          let totalBrightness = 0, weightedX = 0, weightedY = 0;
          for (const p of blob) {
              totalBrightness += p.brightness;
              weightedX += p.x * p.brightness;
              weightedY += p.y * p.brightness;
          }

          candidates.push({
            x: weightedX / totalBrightness,
            y: weightedY / totalBrightness,
            brightness: totalBrightness,
            size: blob.length,
            pixels: blob,
            peak,
            // These are placeholders to be filled by analysis
            fwhm: 0,
            roundness: 0,
          });
      }
    }
  }
  return candidates;
}


/**
 * Analyzes a star candidate's pixels to determine FWHM and roundness.
 */
function analyzeStarProfile(candidate: StarCandidate, grayData: Uint8Array, width: number) {
    const { pixels, peak } = candidate;
    if (pixels.length < 3) return null;

    const halfMax = peak / 2;
    const fwhmPixels = pixels.filter(p => p.brightness > halfMax);
    const fwhm = fwhmPixels.length > 0 ? 2 * Math.sqrt(fwhmPixels.length / Math.PI) : 0;
    
    // Calculate moments to find orientation and roundness
    let m00 = 0, m10 = 0, m01 = 0, m11 = 0, m20 = 0, m02 = 0;
    const cx = candidate.x;
    const cy = candidate.y;

    for(const p of pixels) {
      const b = p.brightness;
      const dx = p.x - cx;
      const dy = p.y - cy;
      m00 += b;
      m10 += dx * b;
      m01 += dy * b;
      m11 += dx * dy * b;
      m20 += dx * dx * b;
      m02 += dy * dy * b;
    }

    if (m00 === 0) return null;

    // Normalize moments
    m11 /= m00; m20 /= m00; m02 /= m00;
    
    const d = Math.sqrt(Math.pow(m20 - m02, 2) + 4 * m11 * m11);
    const majorAxis = Math.sqrt(2 * (m20 + m02 + d));
    const minorAxis = Math.sqrt(2 * (m20 + m02 - d));

    if (minorAxis === 0) return null;

    const roundness = majorAxis / minorAxis;
    
    return { fwhm, roundness };
}
