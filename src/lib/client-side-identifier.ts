
'use client';
import { detectBrightBlobs, type Star } from './astro-align';
import { BSC5_STARS } from './star-catalog';

// --- Types and Interfaces ---
export interface CelestialIdentificationResult {
  summary: string;
  constellations: string[];
  objects_in_field: string[];
  targetFound: boolean;
  ra?: number;
  dec?: number;
  orientation?: number;
  scale?: number;
}

interface Triangle {
    indices: [number, number, number]; // Indices of stars in the source array
    sides: [number, number, number];    // Lengths of the sides, sorted
    ratios: [number, number];          // Ratios of sides (side2/side1, side3/side1)
    maxSide: number;                   // Length of the longest side
}

interface Transform {
    dx: number;
    dy: number;
    angle: number; // in radians
    scale: number; // pixels per degree
    mirrored: boolean;
}

// --- Constants ---
const CANDIDATE_STAR_COUNT = 50;
const CATALOG_MAX_MAGNITUDE = 5.0; // Look at stars brighter than this magnitude
const TRIANGLE_MATCH_TOLERANCE = 0.015; // 1.5% tolerance for side ratios
const MIN_MATCH_COUNT = 5; // Minimum number of stars that must match to be considered a valid solution

// --- Pre-computation ---

// Pre-calculating catalog triangles is too memory intensive for the client.
// We will generate them on-the-fly for stars in a plausible area.
const catalogStars = BSC5_STARS.filter(s => s.vmag < CATALOG_MAX_MAGNITUDE);

// --- Helper Functions ---

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

function createTriangles(stars: (Star | {ra:number, dec:number})[]): Triangle[] {
    const triangles: Triangle[] = [];
    const n = Math.min(stars.length, 100); // Limit number of stars to avoid performance issues

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            for (let k = j + 1; k < n; k++) {
                const s1 = stars[i];
                const s2 = stars[j];
                const s3 = stars[k];

                // Use RA/DEC for catalog, X/Y for image stars
                const p1 = 'ra' in s1 ? { x: s1.ra, y: s1.dec } : s1;
                const p2 = 'ra' in s2 ? { x: s2.ra, y: s2.dec } : s2;
                const p3 = 'ra' in s3 ? { x: s3.ra, y: s3.dec } : s3;

                // Simple Euclidean distance. For RA/DEC, this is an approximation that's okay for small fields of view.
                // A proper solution would use spherical trigonometry.
                const a = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                const b = Math.hypot(p3.x - p2.x, p3.y - p2.y);
                const c = Math.hypot(p1.x - p3.x, p1.y - p3.y);

                const sides = [a, b, c].sort((x, y) => x - y);

                if (sides[0] > 1e-6) { // Avoid degenerate triangles
                    triangles.push({
                        indices: [i, j, k],
                        sides: sides as [number, number, number],
                        ratios: [sides[1] / sides[0], sides[2] / sides[0]],
                        maxSide: sides[2],
                    });
                }
            }
        }
    }
    return triangles;
}


function getTransform(
    imgPair: [Star, Star],
    catPair: [{ra:number, dec:number}, {ra:number, dec:number}],
    mirrored: boolean
): Transform {
    const [i1, i2] = imgPair;
    let [c1, c2] = catPair;

    // Invert RA for mirrored transform
    if (mirrored) {
        c1 = { ...c1, ra: -c1.ra };
        c2 = { ...c2, ra: -c2.ra };
    }

    const catDX = c2.ra - c1.ra;
    const catDY = c2.dec - c1.dec;
    const imgDX = i2.x - i1.x;
    const imgDY = i2.y - i1.y;

    const catDist = Math.hypot(catDX, catDY);
    const imgDist = Math.hypot(imgDX, imgDY);

    const scale = imgDist / catDist; // pixels per degree
    const angle = Math.atan2(imgDY, imgDX) - Math.atan2(catDY, catDX); // radians

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Translation to map c1 to i1
    const dx = i1.x - scale * (c1.ra * cos - c1.dec * sin);
    const dy = i1.y - scale * (c1.ra * sin + c1.dec * cos);

    return { dx, dy, angle, scale, mirrored };
}

function verifyTransform(
    transform: Transform,
    candidateStars: Star[],
    allCatalogStars: typeof catalogStars,
    imageWidth: number,
    imageHeight: number
): { score: number, matchedPairs: [Star, typeof catalogStars[0]][] } {

    const { dx, dy, angle, scale, mirrored } = transform;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    
    // Tolerance for matching a catalog star to an image star
    const tolerance = Math.max(15, 0.02 * Math.max(imageWidth, imageHeight));
    
    let matchCount = 0;
    const matchedPairs: [Star, typeof catalogStars[0]][] = [];
    const usedImageStars = new Set<Star>();


    for (const catStar of allCatalogStars) {
        let catRa = catStar.ra;
        if (mirrored) {
            catRa = -catRa; // Use the same mirrored RA for transformation
        }

        // Apply transform to catalog star to get expected image coordinates
        const expectedX = scale * (catRa * cos - catStar.dec * sin) + dx;
        const expectedY = scale * (catRa * sin + catStar.dec * cos) + dy;
        
        // Skip stars that would project outside the image bounds
        if (expectedX < -tolerance || expectedX > imageWidth + tolerance || expectedY < -tolerance || expectedY > imageHeight + tolerance) {
            continue;
        }

        // Find the closest candidate star in the image within the tolerance
        let bestMatch: Star | null = null;
        let min_dist_sq = tolerance * tolerance;

        for (const imgStar of candidateStars) {
            if (usedImageStars.has(imgStar)) continue; // Don't re-use image stars

            const dist_sq = (imgStar.x - expectedX)**2 + (imgStar.y - expectedY)**2;
            if (dist_sq < min_dist_sq) {
                min_dist_sq = dist_sq;
                bestMatch = imgStar;
            }
        }
        
        if (bestMatch) {
            matchCount++;
            matchedPairs.push([bestMatch, catStar]);
            usedImageStars.add(bestMatch);
        }
    }
    return { score: matchCount, matchedPairs };
}


// --- Main Analysis Function ---
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

        if (detectedStars.length < MIN_MATCH_COUNT) {
            return {
                summary: `Analysis complete, but only ${detectedStars.length} stars were detected. Need at least ${MIN_MATCH_COUNT} for pattern matching.`,
                constellations: [], objects_in_field: [], targetFound: false,
            };
        }

        const candidateStars = detectedStars.sort((a, b) => b.brightness - a.brightness).slice(0, CANDIDATE_STAR_COUNT);
        const imgTriangles = createTriangles(candidateStars);

        let bestSolution = { score: 0, transform: null as Transform | null, matchedPairs: [] as [Star, typeof catalogStars[0]][] };

        // Main matching loop - This is computationally intensive
        for (const imgTriangle of imgTriangles) {
            for (let i = 0; i < catalogStars.length; i++) {
                for (let j = i + 1; j < catalogStars.length; j++) {
                    
                    const catSideA = Math.hypot(catalogStars[j].ra - catalogStars[i].ra, catalogStars[j].dec - catalogStars[i].dec);
                    if (catSideA <= 0) continue;
                    
                    // Ratio of the longest side helps prune the search space
                    const scaleRatio = imgTriangle.maxSide / catSideA;
                    
                    // Estimate search radius for the third catalog star
                    const searchRadius = (imgTriangle.sides[0] * scaleRatio) + (imgTriangle.sides[1] * scaleRatio);
                    
                    for (let k = j + 1; k < catalogStars.length; k++) {
                        const catSideB = Math.hypot(catalogStars[k].ra - catalogStars[i].ra, catalogStars[k].dec - catalogStars[i].dec);
                        const catSideC = Math.hypot(catalogStars[k].ra - catalogStars[j].ra, catalogStars[k].dec - catalogStars[j].dec);

                        const catSides = [catSideA, catSideB, catSideC].sort((a,b) => a-b);
                        if (catSides[0] <= 0) continue;

                        const catRatios : [number, number] = [catSides[1] / catSides[0], catSides[2] / catSides[0]];

                        const ratioError = Math.hypot(catRatios[0] - imgTriangle.ratios[0], catRatios[1] - imgTriangle.ratios[1]);

                        if (ratioError < TRIANGLE_MATCH_TOLERANCE) {
                             // Potential match found, try to derive and verify transform
                            const cStars = [catalogStars[i], catalogStars[j], catalogStars[k]];
                            // Get the original image stars that formed the triangle
                            const iStars = imgTriangle.indices.map(idx => candidateStars[idx]);

                            for(let mirrored of [false, true]) {
                                const transform = getTransform([iStars[0], iStars[1]], [cStars[0], cStars[1]], mirrored);
                                const verification = verifyTransform(transform, candidateStars, catalogStars, imageData.width, imageData.height);

                                if (verification.score > bestSolution.score) {
                                    bestSolution = {
                                        score: verification.score,
                                        transform: transform,
                                        matchedPairs: verification.matchedPairs,
                                    };
                                }
                            }
                        }
                    }
                }
            }
             // Early exit if a very good solution is found
            if (bestSolution.score > candidateStars.length * 0.8) {
                break;
            }
        }
       
        if (bestSolution.score > MIN_MATCH_COUNT) {
            const { transform, matchedPairs } = bestSolution;
            const centerPair = matchedPairs[0]; // Use the first matched pair to estimate center
            const centerRA = centerPair[1].ra;
            const centerDEC = centerPair[1].dec;

            // Find unique constellation names from matched stars
            const constellationCounts: Record<string, number> = {};
            matchedPairs.forEach(p => {
                const con = p[1].con;
                if(con) {
                    constellationCounts[con] = (constellationCounts[con] || 0) + 1;
                }
            });

            const constellations = Object.entries(constellationCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3) // Show top 3 constellations at most
                .map(entry => entry[0]);


            return {
                summary: `Analysis successful! Found ${bestSolution.score} matching stars. Image center is likely near RA ${centerRA.toFixed(2)}°, Dec ${centerDEC.toFixed(2)}°.`,
                constellations: constellations,
                objects_in_field: [], // Could be expanded later
                targetFound: true,
                ra: centerRA,
                dec: centerDEC,
                orientation: transform!.angle * 180 / Math.PI,
                scale: transform!.scale,
            };
        }

        return {
            summary: `Analysis complete. Found ${candidateStars.length} stars, but could not match them to the star catalog.`,
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
