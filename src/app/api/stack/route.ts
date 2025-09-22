
import { NextResponse, type NextRequest } from 'next/server';
import sharp from 'sharp';
import {
    alignAndStack,
    consensusAlignAndStack,
    planetaryAlignAndStack,
    dumbAlignAndStack,
    type AlignmentMethod,
    type StackingMode,
    type ImageQueueEntry
} from '@/lib/server-align';

// Helper to create an ImageData-like object that the alignment functions expect.
// This is needed because ImageData is a browser-only type.
interface ServerImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

async function fetchAndDecodeImage(url: string, id: string, log: (msg: string) => void): Promise<ImageQueueEntry | null> {
    try {
        log(`[FETCH] Downloading: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch image. Status: ${response.status} ${response.statusText}`);
        }
        const buffer = await response.arrayBuffer();

        log(`[DECODE] Processing image from ${url}`);
        const image = sharp(Buffer.from(buffer));
        const metadata = await image.metadata();
        const { width, height } = metadata;

        if (!width || !height) {
            throw new Error('Could not get image dimensions.');
        }

        // Ensure the image has an alpha channel and get raw pixel data
        const rawData = await image.ensureAlpha().raw().toBuffer();
        
        const imageData: ServerImageData = {
            data: new Uint8ClampedArray(rawData),
            width,
            height
        };

        return {
            id,
            // @ts-ignore - We are creating a server-side stand-in for the browser's ImageData
            imageData: imageData, 
            detectedStars: [], // Star detection will happen in the alignment function
            analysisDimensions: { width, height },
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`[ERROR] Failed to process URL ${url}: ${errorMessage}`);
        return null;
    }
}


export async function POST(req: NextRequest) {
    const logs: string[] = [];
    const addLog = (message: string) => {
        logs.push(`[${new Date().toISOString()}] ${message}`);
        console.log(message);
    };

    addLog('API endpoint /api/stack hit. Processing request...');

    try {
        const body = await req.json();

        const {
            imageUrls = [],
            alignmentMethod = 'standard',
            stackingMode = 'median'
        } = body as {
            imageUrls?: string[];
            alignmentMethod?: AlignmentMethod;
            stackingMode?: StackingMode;
        };

        // --- 1. Validate Inputs ---
        addLog(`Received ${imageUrls.length} URLs. Alignment: ${alignmentMethod}, Mode: ${stackingMode}.`);
        if (!imageUrls || imageUrls.length < 2) {
            return NextResponse.json({ error: 'At least two imageUrls are required.' }, { status: 400 });
        }

        // --- 2. Fetch and Decode Images ---
        addLog('Starting image download and decoding process...');
        const imagePromises = imageUrls.map((url, index) => fetchAndDecodeImage(url, `image_${index}`, addLog));
        const resolvedImages = await Promise.all(imagePromises);
        const imageEntries = resolvedImages.filter((entry): entry is ImageQueueEntry => entry !== null);
        
        if (imageEntries.length < 2) {
             return NextResponse.json({
                error: 'Could not process enough images to perform stacking.',
                details: 'Fewer than two images were successfully downloaded and decoded.',
                logs
            }, { status: 400 });
        }
        addLog(`Successfully processed ${imageEntries.length} out of ${imageUrls.length} images.`);
        

        // --- 3. Align and Stack ---
        let stackedImageBuffer: Uint8ClampedArray;
        const setProgress = (p: number) => { addLog(`Stacking progress: ${Math.round(p*100)}%`) };

        switch (alignmentMethod) {
            case 'consensus':
                stackedImageBuffer = await consensusAlignAndStack({ imageEntries, stackingMode, addLog, setProgress });
                break;
            case 'planetary':
                stackedImageBuffer = await planetaryAlignAndStack(imageEntries, stackingMode, addLog, setProgress, 80);
                break;
            case 'dumb':
                stackedImageBuffer = await dumbAlignAndStack({ imageEntries, stackingMode, addLog, setProgress });
                break;
            case 'standard':
            default:
                stackedImageBuffer = await alignAndStack(imageEntries, [], stackingMode, setProgress, addLog);
                break;
        }
        addLog('Alignment and stacking complete.');

        // --- 4. Encode Final Image ---
        const { width, height } = imageEntries[0].analysisDimensions;
        const finalImage = await sharp(Buffer.from(stackedImageBuffer), {
            raw: {
                width: width,
                height: height,
                channels: 4,
            },
        })
        .png() // Always output PNG from the server for quality
        .toBuffer();

        const stackedImageUrl = `data:image/png;base64,${finalImage.toString('base64')}`;

        addLog('Final image encoded successfully.');
        return NextResponse.json({
            message: `Successfully stacked ${imageEntries.length} images.`,
            stackedImageUrl,
            width,
            height,
            logs,
        });

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
        addLog(`[FATAL_ERROR] ${errorMessage}`);
        console.error(error);

        return NextResponse.json({
            error: 'An unexpected error occurred during the stacking process.',
            details: errorMessage,
            logs,
        }, { status: 500 });
    }
}
