
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import sharp from 'sharp';
import type { StackingMode } from '@/lib/astro-align';
import { alignAndStack, detectBrightBlobs, type ImageQueueEntry, type Star } from '@/lib/astro-align';
import { consensusAlignAndStack } from '@/lib/consensus-align';
import { planetaryAlignAndStack } from '@/lib/planetary-align';
import { dumbAlignAndStack } from '@/lib/dumb-align';

// `ImageData`는 브라우저 API이므로, 서버 사이드에서 호환되는 타입을 정의합니다.
interface ServerImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
}

// URL로부터 이미지를 다운로드하고 sharp를 사용해 픽셀 데이터로 변환하는 함수
async function urlToImageData(url: string): Promise<ServerImageData> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch image from ${url}: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const image = sharp(Buffer.from(arrayBuffer));
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    
    // sharp는 RGB 순서의 raw buffer를 반환하므로, RGBA로 변환해줍니다.
    const rgbaData = new Uint8ClampedArray(info.width * info.height * 4);
    for (let i = 0; i < info.width * info.height; i++) {
        rgbaData[i * 4] = data[i * info.channels];
        rgbaData[i * 4 + 1] = data[i * info.channels + 1];
        rgbaData[i * 4 + 2] = data[i * info.channels + 2];
        rgbaData[i * 4 + 3] = info.channels === 4 ? data[i * info.channels + 3] : 255;
    }

    return {
        data: rgbaData,
        width: info.width,
        height: info.height,
    };
}


export async function POST(request: NextRequest) {
    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.split(' ')[1];
    
    // .env 파일에 정의된 API 키 목록
    const validApiKeys = (process.env.ASTROSTACKER_API_KEYS || '').split(',').filter(k => k.trim());

    if (validApiKeys.length === 0) {
        return new NextResponse(JSON.stringify({ error: 'API keys are not configured on the server.' }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
        });
    }

    if (!token || !validApiKeys.includes(token)) {
        return new NextResponse(JSON.stringify({ error: 'Unauthorized: Invalid API Key' }), {
            status: 401, headers: { 'Content-Type': 'application/json' },
        });
    }

    try {
        const body = await request.json();
        const {
            imageUrls,
            alignmentMethod = 'consensus',
            stackingMode = 'median',
        } = body;

        if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length < 2) {
            return new NextResponse(JSON.stringify({ error: 'At least two imageUrls are required.' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }
        
        console.log(`[API] Received stack request for ${imageUrls.length} images. Method: ${alignmentMethod}, Mode: ${stackingMode}`);

        const imageEntries: ImageQueueEntry[] = [];
        for (const url of imageUrls) {
            console.log(`[API] Processing image: ${url}`);
            const imageData = await urlToImageData(url);
            // ImageData 타입이 호환되지 않으므로, 서버용 타입으로 캐스팅합니다.
            const browserImageData = {
                data: imageData.data,
                width: imageData.width,
                height: imageData.height,
                colorSpace: 'srgb'
            } as ImageData;
            const detectedStars = detectBrightBlobs(browserImageData, browserImageData.width, browserImageData.height);
            
            imageEntries.push({
                id: url,
                file: new File([], 'server-file.png'), // Mock file, 서버에서는 사용되지 않음
                imageData: browserImageData,
                detectedStars: detectedStars,
                analysisDimensions: { width: imageData.width, height: imageData.height },
            });
        }
        console.log(`[API] All images processed. Found stars in ${imageEntries.filter(e => e.detectedStars.length > 0).length} images.`);
        
        let stackedImageData: Uint8ClampedArray;
        const mockSetProgress = () => {}; // 서버에서는 진행률 보고가 필요 없음
        const addLog = (msg: string) => console.log(`[API STACK LOG] ${msg}`);

        // alignmentMethod에 따라 적절한 스태킹 함수 호출
        // 주의: AI 관련 로직은 클라이언트 측 모델에 의존하므로 여기서는 standard, dumb, planetary만 지원합니다.
        switch (alignmentMethod) {
            case 'planetary':
                stackedImageData = await planetaryAlignAndStack(imageEntries, stackingMode as StackingMode, addLog, mockSetProgress, 50);
                break;
            case 'dumb':
                 stackedImageData = await dumbAlignAndStack({imageEntries, stackingMode: stackingMode as StackingMode, addLog, setProgress: mockSetProgress });
                 break;
            case 'consensus':
                stackedImageData = await consensusAlignAndStack({imageEntries, stackingMode: stackingMode as StackingMode, addLog, setProgress: mockSetProgress });
                break;
            case 'standard':
            default:
                if (imageEntries[0].detectedStars.length < 2) throw new Error("Reference image for 'standard' alignment has less than 2 stars.");
                stackedImageData = await alignAndStack(imageEntries, imageEntries[0].detectedStars, stackingMode as StackingMode, mockSetProgress);
                break;
        }

        const { width, height } = imageEntries[0].analysisDimensions;
        
        // 최종 스태킹된 데이터를 sharp를 사용해 PNG 버퍼로 변환
        const outputBuffer = await sharp(Buffer.from(stackedImageData), {
            raw: { width, height, channels: 4 }
        }).png().toBuffer();

        const responsePayload = {
            message: `Successfully stacked ${imageEntries.length} images.`,
            stackedImageUrl: `data:image/png;base64,${outputBuffer.toString('base64')}`,
            width,
            height,
        };

        return new NextResponse(JSON.stringify(responsePayload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
        console.error("[API STACK ERROR]", error);
        return new NextResponse(JSON.stringify({ error: 'Internal Server Error', details: errorMessage }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}