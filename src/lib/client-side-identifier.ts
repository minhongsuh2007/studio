
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
const CANDIDATE_STAR_COUNT = 70; // Increased candidates for better matching chance
const CATALOG_MAX_MAGNITUDE = 5.5; // Look at stars brighter than this magnitude
const TRIANGLE_MATCH_TOLERANCE = 0.02; // 2% tolerance for side ratios
const MIN_MATCH_COUNT = 5; // Minimum number of stars that must match to be considered a valid solution

// --- Pre-computation ---
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

function createTriangles(stars: (Star | {ra:number, dec:number})[], starLimit: number): Triangle[] {
    const triangles: Triangle[] = [];
    const n = Math.min(stars.length, starLimit); // Limit number of stars to avoid performance issues

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            for (let k = j + 1; k < n; k++) {
                const s1 = stars[i];
                const s2 = stars[j];
                const s3 = stars[k];

                const p1 = 'ra' in s1 ? { x: s1.ra, y: s1.dec } : s1;
                const p2 = 'ra' in s2 ? { x: s2.ra, y: s2.dec } : s2;
                const p3 = 'ra' in s3 ? { x: s3.ra, y: s3.dec } : s3;
                
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

    if (mirrored) {
        c1 = { ...c1, ra: -c1.ra };
        c2 = { ...c2, ra: -c2.ra };
    }

    const catDX = c2.ra - c1.ra;
    const catDY = c2.dec - c1.dec;
    const imgDX = i2.x - i1.x;
    const imgDY = i2.y - i1.y;

    const catDist = Math.hypot(catDX, catDY) || 1e-9;
    const imgDist = Math.hypot(imgDX, imgDY);

    const scale = imgDist / catDist; // pixels per degree
    const angle = Math.atan2(imgDY, imgDX) - Math.atan2(catDY, catDX); // radians

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

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
    
    const tolerance = Math.max(15, 0.02 * Math.max(imageWidth, imageHeight));
    
    let matchCount = 0;
    const matchedPairs: [Star, typeof catalogStars[0]][] = [];
    const usedImageStars = new Set<number>();


    for (const catStar of allCatalogStars) {
        let catRa = catStar.ra;
        if (mirrored) {
            catRa = -catRa; 
        }

        const expectedX = scale * (catRa * cos - catStar.dec * sin) + dx;
        const expectedY = scale * (catRa * sin + catStar.dec * cos) + dy;
        
        if (expectedX < -tolerance || expectedX > imageWidth + tolerance || expectedY < -tolerance || expectedY > imageHeight + tolerance) {
            continue;
        }

        let bestMatchIdx = -1;
        let min_dist_sq = tolerance * tolerance;

        for (let i = 0; i < candidateStars.length; i++) {
            if (usedImageStars.has(i)) continue;

            const imgStar = candidateStars[i];
            const dist_sq = (imgStar.x - expectedX)**2 + (imgStar.y - expectedY)**2;
            if (dist_sq < min_dist_sq) {
                min_dist_sq = dist_sq;
                bestMatchIdx = i;
            }
        }
        
        if (bestMatchIdx !== -1) {
            matchCount++;
            matchedPairs.push([candidateStars[bestMatchIdx], catStar]);
            usedImageStars.add(bestMatchIdx);
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
        const minThreshold = 140;

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
        const imgTriangles = createTriangles(candidateStars, 20); // Create triangles from top 20 stars to reduce complexity
        const catalogTriangles = createTriangles(catalogStars, 70); // And from a limited set of bright catalog stars

        let bestSolution = { score: 0, transform: null as Transform | null, matchedPairs: [] as [Star, typeof catalogStars[0]][] };

        for (const imgTriangle of imgTriangles) {
            for (const catTriangle of catalogTriangles) {
                const ratioError = Math.hypot(catTriangle.ratios[0] - imgTriangle.ratios[0], catTriangle.ratios[1] - imgTriangle.ratios[1]);
                
                if (ratioError < TRIANGLE_MATCH_TOLERANCE) {
                    const iStars = imgTriangle.indices.map(idx => candidateStars[idx]);
                    const cStars = catTriangle.indices.map(idx => catalogStars[idx]);
                    
                    // Test both mirrored and non-mirrored hypotheses
                    for(let mirrored of [false, true]) {
                        // Check all 6 permutations of matching catalog stars to image stars
                        const permutations = [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]];
                        for (const p of permutations) {
                             const transform = getTransform([iStars[0], iStars[1]], [cStars[p[0]], cStars[p[1]]], mirrored);
                             if(Math.abs(transform.scale) < 1e-6 || Math.abs(transform.scale) > 1e6) continue;

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
            if (bestSolution.score > candidateStars.length * 0.7) {
                break;
            }
        }
       
        if (bestSolution.score >= MIN_MATCH_COUNT) {
            const { transform, matchedPairs } = bestSolution;
            const centerPair = matchedPairs[0]; 
            const centerRA = centerPair[1].ra;
            const centerDEC = centerPair[1].dec;

            const constellationCounts: Record<string, number> = {};
            matchedPairs.forEach(p => {
                const con = p[1].con;
                if(con) {
                    constellationCounts[con] = (constellationCounts[con] || 0) + 1;
                }
            });

            const constellations = Object.entries(constellationCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3) 
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

    