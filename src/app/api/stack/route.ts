
import { NextResponse, type NextRequest } from 'next/server';
import sharp from 'sharp';
import { alignAndStack, consensusAlignAndStack, dumbAlignAndStack, planetaryAlignAndStack } from '@/lib/server-align';
import type { AlignmentMethod, StackingMode, ImageQueueEntry } from '@/lib/server-align';

// --- Helper Functions ---

async function urlToImageData(url: string, log: (msg: string) => void): Promise<ImageData | null> {
    try {
        log(`[IMG-FETCH] Fetching: ${url}`);
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch with status: ${response.status}`);
        }

        const buffer = await response.arrayBuffer();
        const image = sharp(Buffer.from(buffer));
        const metadata = await image.metadata();

        if (!metadata.width || !metadata.height) {
            throw new Error("Could not read image metadata.");
        }

        // Ensure the image has an alpha channel for consistency
        const rawData = await image.ensureAlpha().raw().toBuffer();

        log(`[IMG-FETCH] Success: ${url} (${metadata.width}x${metadata.height})`);
        
        // The sharp buffer is raw pixel data. We need to wrap it in an ImageData-like object.
        // Note: The global ImageData constructor is not available in Node.js runtime.
        // We create a compatible object.
        return {
            data: new Uint8ClampedArray(rawData),
            width: metadata.width,
            height: metadata.height,
        } as ImageData;

    } catch (error) {
        log(`[IMG-FETCH-ERROR] Failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}


// --- Main API Route ---

export async function POST(req: NextRequest) {
    const logs: string[] = [];
    const addLog = (msg: string) => logs.push(`[${new Date().toISOString()}] ${msg}`);

    try {
        addLog("API call received.");
        const body = await req.json();

        const {
            imageUrls,
            alignmentMethod = 'consensus',
            stackingMode = 'median'
        } = body as {
            imageUrls: string[],
            alignmentMethod?: AlignmentMethod,
            stackingMode?: StackingMode,
        };

        if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length < 2) {
            return NextResponse.json({ error: 'Please provide an array of at least two image URLs.' }, { status: 400 });
        }

        addLog(`Processing ${imageUrls.length} images. Alignment: ${alignmentMethod}, Stacking: ${stackingMode}.`);

        const imageQueue: ImageQueueEntry[] = [];

        // Download and prepare all images
        for (const url of imageUrls) {
            const imageData = await urlToImageData(url, addLog);
            if (imageData) {
                imageQueue.push({
                    id: url,
                    imageData: imageData,
                    analysisDimensions: { width: imageData.width, height: imageData.height },
                    // Star detection will happen inside the alignment functions
                    detectedStars: [], 
                });
            } else {
                addLog(`[WARN] Skipping invalid or inaccessible URL: ${url}`);
            }
        }

        if (imageQueue.length < 2) {
            return NextResponse.json({ error: 'Fewer than two valid images could be processed from the provided URLs.', logs }, { status: 400 });
        }

        addLog(`Successfully loaded ${imageQueue.length} images. Starting alignment and stacking...`);
        
        let stackedImageData: Uint8ClampedArray | null = null;
        const refImage = imageQueue[0];
        const { width, height } = refImage.analysisDimensions;

        const setProgress = (p: number) => {
            // Progress reporting can be added here if needed, e.g., via logs
        };

        switch (alignmentMethod) {
            case 'planetary':
                stackedImageData = await planetaryAlignAndStack(imageQueue, stackingMode, addLog, setProgress, 80);
                break;
            case 'dumb':
                stackedImageData = await dumbAlignAndStack({ imageEntries: imageQueue, stackingMode, addLog, setProgress });
                break;
            case 'standard':
                stackedImageData = await alignAndStack(imageQueue, [], stackingMode, setProgress, addLog);
                break;
            case 'consensus':
            default:
                stackedImageData = await consensusAlignAndStack({ imageEntries: imageQueue, stackingMode, addLog, setProgress });
                break;
        }

        if (!stackedImageData) {
            throw new Error("Stacking process failed to produce an image.");
        }

        addLog("Stacking complete. Generating final output image.");
        
        // Convert final buffer to PNG
        const finalImageBuffer = await sharp(Buffer.from(stackedImageData), {
            raw: {
                width: width,
                height: height,
                channels: 4,
            },
        }).png().toBuffer();

        const base64Image = finalImageBuffer.toString('base64');
        const dataUrl = `data:image/png;base64,${base64Image}`;

        const responsePayload = {
            message: `Successfully stacked ${imageQueue.length} images.`,
            stackedImageUrl: dataUrl,
            width,
            height,
            logs,
        };

        return NextResponse.json(responsePayload);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        addLog(`[FATAL_ERROR] ${errorMessage}`);
        console.error("Error in /api/stack:", error);
        return NextResponse.json({ error: 'An internal server error occurred.', details: errorMessage, logs }, { status: 500 });
    }
}
