
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
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch image from ${url}: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    
    const image = sharp(Buffer.from(arrayBuffer));
    
    // Ensure the image is in a format we can work with (RGBA)
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    return {
        data: new Uint8ClampedArray(data),
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
        return NextResponse.json({ error: 'API keys are not configured on the server.' }, { status: 500 });
    }

    if (!token || !validApiKeys.includes(token)) {
        return NextResponse.json({ error: 'Unauthorized: Invalid API Key' }, { status: 401 });
    }

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
        
        // --- URL 유효성 검사 추가 ---
        for (const url of imageUrls) {
            if (typeof url !== 'string' || (!url.match(/\.(jpg|jpeg|png|gif|tif|tiff|webp)$/i) && !url.startsWith('data:'))) {
                 // 구글 이미지 검색 결과 링크와 같은 잘못된 URL 형식 필터링
                 if (url.includes("google.com/imgres")) {
                    return NextResponse.json(
                        { error: 'Invalid image URL format. Please provide a direct link to the image file, not a Google Images result page.' },
                        { status: 400 }
                    );
                 }
                return NextResponse.json(
                    { error: `Invalid image URL format: ${url}. URL must be a direct link to a supported image file (e.g., .jpg, .png).` },
                    { status: 400 }
                );
            }
        }
        // --- 유효성 검사 끝 ---

        console.log(`[API] Received stack request for ${imageUrls.length} images. Method: ${alignmentMethod}, Mode: ${stackingMode}`);

        const imageEntries: ServerImageQueueEntry[] = [];
        for (const url of imageUrls) {
            console.log(`[API] Processing image: ${url}`);
            const imageData = await urlToImageData(url);
            
            // `detectBrightBlobs`는 브라우저의 ImageData 형식을 기대하므로, 필요한 속성을 가진 객체를 전달합니다.
            const browserCompatibleImageData = {
                data: imageData.data,
                width: imageData.width,
                height: imageData.height,
            } as ImageData; // 서버에서는 타입스크립트의 타입 단언으로 처리

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
        const mockSetProgress = () => {}; // 서버에서는 진행률 보고가 필요 없음
        const addLog = (msg: string) => console.log(`[API STACK LOG] ${msg}`);

        // ImageQueueEntry 타입을 서버용으로 변환 (File 객체 제거)
        const serverEntries = imageEntries.map(e => ({
            ...e,
            imageData: {
                ...e.imageData,
                colorSpace: 'srgb'
            } as ImageData, // align 함수들이 ImageData 타입을 기대하므로 캐스팅
            file: null // 서버에서는 file 객체 불필요
        }));

        // alignmentMethod에 따라 적절한 스태킹 함수 호출
        switch (alignmentMethod) {
            case 'planetary':
                stackedImageData = await planetaryAlignAndStack(serverEntries as any, stackingMode as StackingMode, addLog, mockSetProgress, 50);
                break;
            case 'dumb':
                 stackedImageData = await dumbAlignAndStack({imageEntries: serverEntries as any, stackingMode: stackingMode as StackingMode, addLog, setProgress: mockSetProgress });
                 break;
            case 'consensus':
                // 서버 환경에서는 AI 모델을 사용할 수 없으므로, standard로 대체
                addLog("[API] 'consensus' method on server falls back to 'standard' as AI model is client-side only.");
                 if (serverEntries.length > 0 && serverEntries[0].detectedStars.length < 2) throw new Error("Reference image for alignment has less than 2 stars.");
                stackedImageData = await alignAndStack(serverEntries as any, serverEntries[0].detectedStars, stackingMode as StackingMode, mockSetProgress);
                break;
            case 'standard':
            default:
                if (serverEntries.length > 0 && serverEntries[0].detectedStars.length < 2) throw new Error("Reference image for 'standard' alignment has less than 2 stars.");
                stackedImageData = await alignAndStack(serverEntries as any, serverEntries[0].detectedStars, stackingMode as StackingMode, mockSetProgress);
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

        return NextResponse.json(responsePayload);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
        console.error("[API STACK ERROR]", error);
        return NextResponse.json({ error: 'Internal Server Error', details: errorMessage }, { status: 500 });
    }
}
