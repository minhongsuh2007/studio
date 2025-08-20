
'use client';
import { detectBrightBlobs, type Star } from './astro-align';

// --- DATA from star.byb.kr-v1 ---
// This database contains pre-calculated patterns for various constellations.
// Each star is represented by its relative position and magnitude.
const CONSTELLATION_DATA = [
    { name: "Orion", stars: [[-81, 148, 0.18], [-130, 140, 1.64], [-89, 58, 1.7], [-121, 55, 2.23], [-104, 52, 1.74], [-73, -53, 2.07], [-139, -60, 2.77], [2, 0, 0.45], [47, 105, 2.05], [80, 5, 1.5]] },
    { name: "Ursa Major", stars: [[-58, 222, 1.79], [-102, 168, 1.76], [-137, 127, 2.44], [-163, 163, 3.3], [-202, 133, 1.86], [-255, 117, 2.37], [-228, 74, 2.27]] },
    { name: "Canis Major", stars: [[0, 0, -1.46], [-127, -101, 1.98], [-45, -153, 1.5], [-92, -220, 1.84], [135, -125, 1.63]] },
    { name: "Cassiopeia", stars: [[-55, -1, 2.28], [0, 0, 2.15], [73, -40, 2.68], [108, 38, 2.25], [17, 72, 3.38]] },
    { name: "Cygnus", stars: [[0, 0, 1.25], [-12, -152, 2.23], [197, -125, 2.48], [-115, 158, 2.86], [90, 180, 2.97]] },
    { name: "Lyra", stars: [[0,0,0.03],[-16,-43,3.24],[-45,-27,3.86],[38,-103,3.52],[64,-92,4.35]]},
    { name: "Gemini", stars: [[0, 0, 1.14], [-158, -76, 1.58], [21, -126, 1.93], [-14, -200, 2.86], [103, -84, 2.97]] },
    { name: "Leo", stars: [[0,0,1.35],[23,89,2.97],[105,123,2.57],[149,68,2.14],[134,13,3.44],[208,0,2.01],[-158,-70,2.23]]},
    { name: "Scorpius", stars: [[0,0,0.96],[-21,-72,2.89],[-31,-112,2.29],[-40,-157,1.86],[-34,-214,2.7],[-13,-249,2.39],[33,-288,3], [85,-278,2.72],[135,-247,2.56],[158,-205,2.82],[174,-162,3.09],[200,-115,4.73],[150,-62,2.41],[198, -15, 2.7]]}
].map(pattern => {
    // Pre-calculate triangles for each constellation pattern
    const triangles = [];
    for (let i = 0; i < pattern.stars.length; i++) {
        for (let j = i + 1; j < pattern.stars.length; j++) {
            for (let k = j + 1; k < pattern.stars.length; k++) {
                const s1 = pattern.stars[i];
                const s2 = pattern.stars[j];
                const s3 = pattern.stars[k];

                const a = Math.hypot(s2[0] - s1[0], s2[1] - s1[1]);
                const b = Math.hypot(s3[0] - s2[0], s3[1] - s2[1]);
                const c = Math.hypot(s1[0] - s3[0], s1[1] - s3[1]);
                
                // Sort sides to make matching easier
                const sides = [a, b, c].sort((x, y) => x - y);

                // To avoid degenerate triangles and ensure scale invariance,
                // we use ratios of the sides.
                if (sides[0] > 1e-6) {
                     triangles.push({
                        // Ratios of sides
                        ratios: [sides[1] / sides[0], sides[2] / sides[0]],
                        // Indices of the stars forming this triangle
                        indices: [i, j, k]
                    });
                }
            }
        }
    }
    return { ...pattern, triangles };
});


export interface CelestialIdentificationResult {
  summary: string;
  constellations: string[];
  objects_in_field: string[];
  targetFound: boolean;
}

async function getImageDataFromUrl(url: string): Promise<ImageData> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
                return reject(new Error("Could not get canvas context"));
            }
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            ctx.drawImage(img, 0, 0);
            resolve(ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight));
        };
        img.onerror = (err) => reject(new Error(`Failed to load image for client-side analysis: ${err}`));
        img.src = url;
    });
}

function findBestMatch(
    detectedStars: Star[],
    pattern: typeof CONSTELLATION_DATA[0],
    imageWidth: number,
    imageHeight: number
): { score: number, transform: { scale: number, angle: number, dx: number, dy: number, mirrored: boolean } | null } {
    if (detectedStars.length < 3) return { score: 0, transform: null };

    const candidateStars = detectedStars.sort((a, b) => b.brightness - a.brightness).slice(0, 50);

    let bestMatch = { score: 0, transform: null, matches: 0 };
    const RATIO_TOLERANCE = 0.05; // 5% tolerance for side ratios

    // Create triangles from candidate stars
    const candidateTriangles = [];
    for(let i=0; i < candidateStars.length; i++) {
        for (let j = i + 1; j < candidateStars.length; j++) {
            for (let k = j + 1; k < candidateStars.length; k++) {
                const s1 = candidateStars[i];
                const s2 = candidateStars[j];
                const s3 = candidateStars[k];

                const a = Math.hypot(s2.x - s1.x, s2.y - s1.y);
                const b = Math.hypot(s3.x - s2.x, s3.y - s2.y);
                const c = Math.hypot(s1.x - s3.x, s1.y - s3.y);
                const sides = [a, b, c].sort((x, y) => x - y);

                if (sides[0] > 10) { // Ignore tiny triangles
                    candidateTriangles.push({
                        ratios: [sides[1] / sides[0], sides[2] / sides[0]],
                        indices: [i, j, k]
                    });
                }
            }
        }
    }

    // Try to find a matching triangle pair
    for (const pTriangle of pattern.triangles) {
        for (const cTriangle of candidateTriangles) {
            const ratioError1 = Math.abs(pTriangle.ratios[0] - cTriangle.ratios[0]) / pTriangle.ratios[0];
            const ratioError2 = Math.abs(pTriangle.ratios[1] - cTriangle.ratios[1]) / pTriangle.ratios[1];

            if (ratioError1 < RATIO_TOLERANCE && ratioError2 < RATIO_TOLERANCE) {
                // Found a potential match, now find the transformation
                const pStars = pTriangle.indices.map(i => ({x: pattern.stars[i][0], y: pattern.stars[i][1]}));
                const cStars = cTriangle.indices.map(i => candidateStars[i]);

                for (let mirrored of [false, true]) {
                    if (mirrored) {
                        pStars.forEach(s => s.x = -s.x); // Mirror pattern for matching
                    }

                    const pVec = { x: pStars[1].x - pStars[0].x, y: pStars[1].y - pStars[0].y };
                    const cVec = { x: cStars[1].x - cStars[0].x, y: cStars[1].y - cStars[0].y };
                    
                    const pDist = Math.hypot(pVec.x, pVec.y);
                    if (pDist < 1e-6) continue;

                    const scale = Math.hypot(cVec.x, cVec.y) / pDist;
                    const angle = Math.atan2(cVec.y, cVec.x) - Math.atan2(pVec.y, pVec.x);
                    const cos = Math.cos(angle);
                    const sin = Math.sin(angle);

                    // Transform pStar[0] to cStar[0]
                    const dx = cStars[0].x - (pStars[0].x * cos - pStars[0].y * sin) * scale;
                    const dy = cStars[0].y - (pStars[0].x * sin + pStars[0].y * cos) * scale;

                    // Verify this transform with all other stars in the constellation
                    let matchCount = 0;
                    const positionTolerance = 0.05 * Math.hypot(imageWidth, imageHeight);
                    
                    for (const pStarData of pattern.stars) {
                        let pStar = {x: pStarData[0], y: pStarData[1]};
                        if (mirrored) pStar.x = -pStar.x;

                        const tx = (pStar.x * cos - pStar.y * sin) * scale + dx;
                        const ty = (pStar.x * sin + pStar.y * cos) * scale + dy;

                        for (const cStar of candidateStars) {
                            if (Math.hypot(cStar.x - tx, cStar.y - ty) < positionTolerance) {
                                matchCount++;
                                break; // Count each constellation star only once
                            }
                        }
                    }

                    if (matchCount > bestMatch.matches) {
                        bestMatch = {
                            matches: matchCount,
                            score: matchCount / pattern.stars.length,
                            transform: { scale, angle, dx, dy, mirrored }
                        };
                    }
                     if (mirrored) {
                        pStars.forEach(s => s.x = -s.x); // Un-mirror for next iteration
                    }
                }
            }
        }
    }
    return bestMatch;
}


export async function identifyCelestialObjectsFromImage(imageDataUri: string): Promise<CelestialIdentificationResult> {
    try {
        const imageData = await getImageDataFromUrl(imageDataUri);
        
        let detectedStars: Star[] = [];
        let currentThreshold = 200;
        const minThreshold = 150;

        while (detectedStars.length < 10 && currentThreshold >= minThreshold) {
            detectedStars = detectBrightBlobs(imageData, imageData.width, imageData.height, currentThreshold);
            if (detectedStars.length < 10) {
                currentThreshold -= 10;
            }
        }

        if (detectedStars.length < 3) {
            return {
                summary: `Analysis complete, but not enough stars were detected (${detectedStars.length}) for pattern matching.`,
                constellations: [],
                objects_in_field: [],
                targetFound: false,
            };
        }

        let bestResult = {
            pattern: null as typeof CONSTELLATION_DATA[0] | null,
            score: 0,
            transform: null
        };

        for (const pattern of CONSTELLATION_DATA) {
            const match = findBestMatch(detectedStars, pattern, imageData.width, imageData.height);
            if (match.score > bestResult.score) {
                bestResult = { pattern, score: match.score, transform: match.transform };
            }
        }
        
        const MATCH_THRESHOLD = 0.4; // Require at least 40% of stars to match
        if (bestResult.pattern && bestResult.score > MATCH_THRESHOLD) {
            const identifiedPattern = bestResult.pattern;
            const objects = (identifiedPattern as any).objects?.map((o: any) => o.name) || [];

            return {
                summary: `Analysis complete. Found ${detectedStars.length} stars. Best match: ${identifiedPattern.name} (Confidence: ${(bestResult.score * 100).toFixed(0)}%).`,
                constellations: [identifiedPattern.name],
                objects_in_field: objects,
                targetFound: true,
            };
        }

        return {
            summary: `Analysis complete. Found ${detectedStars.length} stars, but no known constellations could be matched with high confidence.`,
            constellations: [],
            objects_in_field: [],
            targetFound: false,
        };

    } catch (error) {
        console.error("Client-side identification error:", error);
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
        throw new Error(`Failed during client-side analysis: ${errorMessage}`);
    }
}
