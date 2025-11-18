
import { NextRequest, NextResponse } from 'next/server';
import { stackImages } from '@/app/actions';
import { AlignmentMethod, StackingMode, type ImageQueueEntry as ServerImageQueueEntry } from '@/lib/server-align';
import sharp from 'sharp';

async function decodeImage(
  file: File,
  id: string,
  log: (msg: string) => void
): Promise<ServerImageQueueEntry | null> {
  try {
    log(`[DECODE] Processing image: ${id}`);
    
    const buffer = Buffer.from(await file.arrayBuffer());
    
    const image = sharp(buffer);
    const metadata = await image.metadata();
    const { width, height } = metadata;

    if (!width || !height) {
      throw new Error('Could not get image dimensions.');
    }

    const rawData = await image.ensureAlpha().raw().toBuffer();

    const imageData = {
      data: new Uint8ClampedArray(rawData),
      width,
      height,
    };

    return {
      id,
      // @ts-ignore We are creating a server-side stand-in
      imageData: imageData,
      detectedStars: [], // Star detection now happens in the alignment function on server
      analysisDimensions: { width, height },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`[ERROR] Failed to process image ${id}: ${errorMessage}`);
    return null;
  }
}


export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const imageFiles = formData.getAll('images') as File[];
    const alignmentMethod = (formData.get('alignmentMethod') as AlignmentMethod) || 'consensus';
    const stackingMode = (formData.get('stackingMode') as StackingMode) || 'median';
    const imageUrlsString = formData.get('imageUrls') as string | null;

    const logs: string[] = [];
    const addLog = (message: string) => {
        logs.push(`[${new Date().toISOString()}] ${message}`);
        console.log(message);
    };

    let resolvedImages: (ServerImageQueueEntry | null)[] = [];

    if (imageFiles && imageFiles.length > 0) {
        addLog(`Received ${imageFiles.length} files from FormData.`);
        const imagePromises = imageFiles.map((file, index) =>
            decodeImage(file, `file_${index}_${file.name}`, addLog)
        );
        resolvedImages = await Promise.all(imagePromises);

    } else if (imageUrlsString) {
        const imageUrls = imageUrlsString.split('\n').filter(url => url.trim() !== '');
        addLog(`Received ${imageUrls.length} URLs from FormData.`);
        
        const fetchAndDecodeImage = async (url: string, id: string): Promise<ServerImageQueueEntry | null> => {
            try {
                addLog(`[FETCH] Downloading: ${url}`);
                const response = await fetch(url, { headers: { 'User-Agent': 'AstroStacker/1.0' }});
                if (!response.ok) throw new Error(`Fetch failed with status ${response.status}`);
                const file = new File([await response.blob()], new URL(url).pathname.split('/').pop() || 'image.jpg');
                return await decodeImage(file, id, addLog);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                addLog(`[ERROR] Failed to process URL ${url}: ${errorMessage}`);
                return null;
            }
        };

        const imagePromises = imageUrls.map((url, index) =>
            fetchAndDecodeImage(url, `url_${index}`)
        );
        resolvedImages = await Promise.all(imagePromises);
    } else {
         return NextResponse.json({ error: 'No images or image URLs provided.', logs: [] }, { status: 400 });
    }

    const result = await stackImages({
        images: resolvedImages,
        alignmentMethod,
        stackingMode,
    });

    if (result.success) {
      return NextResponse.json({
        message: result.message,
        stackedImageUrl: result.stackedImageUrl,
        width: result.width,
        height: result.height,
        logs: result.logs,
      }, { status: 200 });
    } else {
      return NextResponse.json({
        error: result.message,
        details: result.details,
        logs: result.logs,
      }, { status: 500 });
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred on the server.';
    console.error('[API_ROUTE_ERROR]', error);
    return NextResponse.json({ error: 'Failed to process the request.', details: errorMessage, logs: [`[FATAL] ${errorMessage}`] }, { status: 500 });
  }
}
