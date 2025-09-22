
import 'dotenv/config';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import sharp from 'sharp';
import type { StackingMode } from '@/lib/astro-align';
import { alignAndStack, detectBrightBlobs, type Star } from '@/lib/astro-align';
import { consensusAlignAndStack } from '@/lib/consensus-align';
import { planetaryAlignAndStack } from '@/lib/planetary-align';
import { dumbAlignAndStack } from '@/lib/dumb-align';

// `ImageData`는 브라우저 API이므로, 서버 사이드에서 호환되는 타입을 정의합니다.
interface ServerImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
}

// 서버 환경에서 사용할 ImageQueueEntry 타입. browser `File` 객체 제외.
interface ServerImageQueueEntry {
  id: string;
  imageData: ServerImageData;
  detectedStars: Star[];
  analysisDimensions: { width: number; height: number };
}

// URL로부터 이미지를 다운로드하고 sharp를 사용해 픽셀 데이터로 변환하는 함수
async function urlToImageData(url: string): Promise<ServerImageData> {
    const initialResponse = await fetch(url);
    if (!initialResponse.ok) {
        throw new Error(`Failed to fetch from ${url}: ${initialResponse.statusText}`);
    }

    const contentType = initialResponse.headers.get('content-type');
    let imageBuffer: ArrayBuffer;

    if (contentType && contentType.startsWith('image/')) {
        // It's a direct image link
        imageBuffer = await initialResponse.arrayBuffer();
    } else {
        // It's likely an HTML page, try to find an og:image
        const html = await initialResponse.text();
        const ogImageMatch = html.match(/<meta\s+(?:property="og:image"|name="og:image")\s+content="([^"]+)"/);
        
        if (ogImageMatch && ogImageMatch[1]) {
            const ogImageUrl = ogImageMatch[1];
            const imageResponse = await fetch(ogImageUrl);
            if (!imageResponse.ok) {
                throw new Error(`Failed to fetch og:image from ${ogImageUrl}: ${imageResponse.statusText}`);
            }
            const imageContentType = imageResponse.headers.get('content-type');
            if (!imageContentType || !imageContentType.startsWith('image/')) {
                throw new Error(`The og:image URL (${ogImageUrl}) did not point to a valid image.`);
            }
            imageBuffer = await imageResponse.arrayBuffer();
        } else {
            // This was the source of the unhandled error. By throwing an error here,
            // it will be caught by the main `catch` block in the POST handler.
            throw new Error(`URL did not point to a direct image and no og:image meta tag was found.`);
        }
    }
    
    const image = sharp(Buffer.from(imageBuffer));
    
    // Ensure the image is in a format we can work with (RGBA)
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    return {
        data: new Uint8ClampedArray(data),
        width: info.width,
        height: info.height,
    };
}


export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const {
            imageUrls,
            alignmentMethod = 'consensus',
            stackingMode = 'median',
        } = body;

        if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length < 2) {
            return NextResponse.json({ error: 'At least two imageUrls are required.' }, { status: 400 });
        }

        console.log(`[API] Received stack request for ${imageUrls.length} images. Method: ${alignmentMethod}, Mode: ${stackingMode}`);

        const imageEntries: ServerImageQueueEntry[] = [];
        for (const url of imageUrls) {
            console.log(`[API] Processing image: ${url}`);
            const imageData = await urlToImageData(url);
            
            const browserCompatibleImageData = {
                data: imageData.data,
                width: imageData.width,
                height: imageData.height,
            } as ImageData;

            const detectedStars = detectBrightBlobs(browserCompatibleImageData, browserCompatibleImageData.width, browserCompatibleImageData.height);
            
            imageEntries.push({
                id: url,
                imageData: imageData,
                detectedStars: detectedStars,
                analysisDimensions: { width: imageData.width, height: imageData.height },
            });
        }
        console.log(`[API] All images processed. Found stars in ${imageEntries.filter(e => e.detectedStars.length > 0).length} images.`);
        
        let stackedImageData: Uint8ClampedArray;
        const mockSetProgress = () => {};
        const addLog = (msg: string) => console.log(`[API STACK LOG] ${msg}`);

        const serverEntries = imageEntries.map(e => ({
            ...e,
            imageData: {
                ...e.imageData,
                colorSpace: 'srgb'
            } as ImageData,
            file: null
        }));
        
        const refImage = serverEntries[0];
        const refStars = refImage?.detectedStars;

        switch (alignmentMethod) {
            case 'planetary':
                stackedImageData = await planetaryAlignAndStack(serverEntries as any, stackingMode as StackingMode, addLog, mockSetProgress, 50);
                break;
            case 'dumb':
                 stackedImageData = await dumbAlignAndStack({imageEntries: serverEntries as any, stackingMode: stackingMode as StackingMode, addLog, setProgress: mockSetProgress });
                 break;
            case 'consensus':
                addLog("[API] 'consensus' method on server falls back to 'standard' as AI model is client-side only.");
                 if (!refImage || !refStars || refStars.length < 2) {
                    throw new Error("Reference image for alignment has less than 2 stars.");
                 }
                stackedImageData = await alignAndStack(serverEntries as any, refStars, stackingMode as StackingMode, mockSetProgress);
                break;
            case 'standard':
            default:
                if (!refImage || !refStars || refStars.length < 2) {
                    throw new Error("Reference image for 'standard' alignment has less than 2 stars.");
                }
                stackedImageData = await alignAndStack(serverEntries as any, refStars, stackingMode as StackingMode, mockSetProgress);
                break;
        }

        const { width, height } = imageEntries[0].analysisDimensions;
        
        try {
            const outputBuffer = await sharp(Buffer.from(stackedImageData), {
                raw: { width, height, channels: 4 }
            }).png().toBuffer();

            const responsePayload = {
                message: `Successfully stacked ${imageEntries.length} images.`,
                stackedImageUrl: `data:image/png;base64,${outputBuffer.toString('base64')}`,
                width,
                height,
            };

            return NextResponse.json(responsePayload);
        } catch (bufferError) {
             const bufferErrorMessage = bufferError instanceof Error ? bufferError.message : "Unknown buffer/sharp error";
             console.error("[API SHARP ERROR]", bufferError);
             throw new Error(`Failed to create output image buffer: ${bufferErrorMessage}`);
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
        console.error("[API STACK ERROR]", error);
        return NextResponse.json({ error: 'Internal Server Error', details: errorMessage }, { status: 500 });
    }
}
