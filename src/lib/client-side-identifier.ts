
'use client';
import { detectBrightBlobs, type Star } from './astro-align';

// --- DATA ---
// Data structure for our star patterns
interface StarPattern {
    name: string;
    // Store pairs of stars and the vector between them
    // [star1_index, star2_index, dx, dy, distance]
    pairs: [number, number, number, number, number][];
    stars: { name: string, x: number, y: number, mag: number }[]; // Basic star info
    objects?: { name: string, x: number, y: number, type: string }[];
}

// Simplified constellation data. A real implementation would need a much larger, more precise dataset.
// Coordinates are arbitrary, what matters are the relative positions (vectors).
// Using Orion as a test case.
const CONSTELLATION_DATA: StarPattern[] = [
    {
        name: "Orion",
        stars: [
            { name: "Betelgeuse", x: 80, y: 50, mag: 0.45 },
            { name: "Rigel", x: 20, y: 250, mag: 0.18 },
            { name: "Bellatrix", x: 30, y: 60, mag: 1.64 },
            { name: "Mintaka", x: 35, y: 150, mag: 2.23 },
            { name: "Alnilam", x: 55, y: 155, mag: 1.70 },
            { name: "Alnitak", x: 70, y: 160, mag: 1.74 },
            { name: "Saiph", x: 85, y: 260, mag: 2.07 },
        ],
        pairs: [], // Will be populated dynamically
        objects: [
            { name: "Orion Nebula (M42)", x: 60, y: 180, type: "Nebula" },
            { name: "Horsehead Nebula", x: 72, y: 165, type: "Nebula" }
        ]
    }
];

// Pre-calculate vectors for our constellation data
CONSTELLATION_DATA.forEach(pattern => {
    const p_stars = pattern.stars;
    for (let i = 0; i < p_stars.length; i++) {
        for (let j = i + 1; j < p_stars.length; j++) {
            const dx = p_stars[j].x - p_stars[i].x;
            const dy = p_stars[j].y - p_stars[i].y;
            const dist = Math.hypot(dx, dy);
            pattern.pairs.push([i, j, dx, dy, dist]);
        }
    }
    // Sort by distance for faster matching later
    pattern.pairs.sort((a, b) => a[4] - b[4]);
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

function findBestMatch(detectedStars: Star[], pattern: StarPattern, imageWidth: number, imageHeight: number): { score: number, transform: { scale: number, angle: number, dx: number, dy: number } | null } {
    if (detectedStars.length < 3) return { score: 0, transform: null };

    // Use the ~30 brightest stars for matching
    const candidateStars = detectedStars.sort((a, b) => b.brightness - a.brightness).slice(0, 30);
    const candidatePairs: [number, number, number, number, number][] = [];
    for (let i = 0; i < candidateStars.length; i++) {
        for (let j = i + 1; j < candidateStars.length; j++) {
            const dx = candidateStars[j].x - candidateStars[i].x;
            const dy = candidateStars[j].y - candidateStars[i].y;
            const dist = Math.hypot(dx, dy);
            candidatePairs.push([i, j, dx, dy, dist]);
        }
    }
    candidatePairs.sort((a, b) => a[4] - b[4]);

    let bestMatch = { score: 0, transform: null, matches: 0 };
    const imageDiagonal = Math.hypot(imageWidth, imageHeight);

    // Iterate through all pairs in the candidate image as potential matches for a pattern pair
    for (const cPair of candidatePairs) {
        if(cPair[4] < 10) continue; // Ignore pairs that are too close
        for (const pPair of pattern.pairs) {
            if(pPair[4] === 0) continue;

            // Find scale and rotation to match these two pairs
            const scale = cPair[4] / pPair[4];
            const angle = Math.atan2(cPair[3], cPair[2]) - Math.atan2(pPair[3], pPair[2]);

            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            
            // Transform pattern's first star based on this hypothesis
            const pStar1 = pattern.stars[pPair[0]];
            const transformedX = pStar1.x * cos - pStar1.y * sin;
            const transformedY = pStar1.x * sin + pStar1.y * cos;

            // Find translation
            const cStar1 = candidateStars[cPair[0]];
            const dx = cStar1.x - transformedX * scale;
            const dy = cStar1.y - transformedY * scale;

            // Now, verify this transform with all other stars
            let matchCount = 0;
            // Tolerance should be a small fraction of the image size
            const positionTolerance = 0.02 * imageDiagonal;

            for (const pStar of pattern.stars) {
                 // Correct rotation formula application for each star
                const tx = (pStar.x * cos - pStar.y * sin) * scale + dx;
                const ty = (pStar.x * sin + pStar.y * cos) * scale + dy;

                // Find the closest candidate star
                let closestDist = Infinity;
                for (const cStar of candidateStars) {
                    const dist = Math.hypot(cStar.x - tx, cStar.y - ty);
                    if (dist < closestDist) {
                        closestDist = dist;
                    }
                }
                if (closestDist < positionTolerance) {
                    matchCount++;
                }
            }
            
            if (matchCount > bestMatch.matches) {
                bestMatch = {
                    score: matchCount / pattern.stars.length,
                    transform: { scale, angle, dx, dy },
                    matches: matchCount
                };
            }
        }
    }

    return { score: bestMatch.score, transform: bestMatch.transform };
}


export async function identifyCelestialObjectsFromImage(imageDataUri: string): Promise<CelestialIdentificationResult> {
    try {
        const imageData = await getImageDataFromUrl(imageDataUri);
        
        let detectedStars: Star[] = [];
        let currentThreshold = 200;
        const minThreshold = 150;

        // Try to detect stars, lowering threshold if not enough are found
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
            pattern: null as StarPattern | null,
            score: 0,
            transform: null
        };

        for (const pattern of CONSTELLATION_DATA) {
            const match = findBestMatch(detectedStars, pattern, imageData.width, imageData.height);
            if (match.score > bestResult.score) {
                bestResult = { pattern, score: match.score, transform: match.transform };
            }
        }

        const MATCH_THRESHOLD = 0.5; // Require at least 50% of stars to match
        if (bestResult.pattern && bestResult.score > MATCH_THRESHOLD) {
            const identifiedPattern = bestResult.pattern;
            return {
                summary: `Analysis complete. Found ${detectedStars.length} stars. Best match: ${identifiedPattern.name} (Confidence: ${(bestResult.score * 100).toFixed(0)}%).`,
                constellations: [identifiedPattern.name],
                objects_in_field: identifiedPattern.objects?.map(o => o.name) || [],
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
