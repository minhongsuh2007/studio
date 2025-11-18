
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

async function fetchAndDecodeImage(
  url: string,
  id: string,
  log: (msg: string) => void
): Promise<ServerImageQueueEntry | null> {
  try {
    log(`[FETCH] Downloading: ${url}`);
    const response = await fetch(url, { headers: { 'User-Agent': 'AstroStacker/1.0' }});
    if (!response.ok) throw new Error(`Fetch failed with status ${response.status}`);
    
    const file = new File([await response.blob()], new URL(url).pathname.split('/').pop() || 'image.jpg');
    return await decodeImage(file, id, log);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    addLog(`[ERROR] Failed to process URL ${url}: ${errorMessage}`);
    return null;
  }
}

export async function POST(req: NextRequest) {
  const logs: string[] = [];
  const addLog = (message: string) => {
      logs.push(`[${new Date().toISOString()}] ${message}`);
      console.log(message);
  };

  try {
    const contentType = req.headers.get('content-type') || '';
    let imageEntries: (ServerImageQueueEntry | null)[] = [];
    let alignmentMethod: AlignmentMethod = 'consensus';
    let stackingMode: StackingMode = 'median';

    if (contentType.includes('multipart/form-data')) {
        addLog('Processing FormData request...');
        const formData = await req.formData();
        const imageFiles = formData.getAll('images') as File[];
        alignmentMethod = (formData.get('alignmentMethod') as AlignmentMethod) || 'consensus';
        stackingMode = (formData.get('stackingMode') as StackingMode) || 'median';
        
        if (imageFiles.length > 0) {
            addLog(`Received ${imageFiles.length} files from FormData.`);
            const imagePromises = imageFiles.map((file, index) =>
                decodeImage(file, `file_${index}_${file.name}`, addLog)
            );
            imageEntries = await Promise.all(imagePromises);
        } else {
            return NextResponse.json({ error: 'No image files found in FormData.', logs: logs }, { status: 400 });
        }

    } else if (contentType.includes('application/json')) {
        addLog('Processing JSON request...');
        const body = await req.json();
        const imageUrls = body.imageUrls as string[];
        alignmentMethod = (body.alignmentMethod as AlignmentMethod) || 'consensus';
        stackingMode = (body.stackingMode as StackingMode) || 'median';
        
        if (imageUrls && imageUrls.length > 0) {
            addLog(`Received ${imageUrls.length} URLs from JSON body.`);
            const imagePromises = imageUrls.map((url, index) =>
                fetchAndDecodeImage(url, `url_${index}`, addLog)
            );
            imageEntries = await Promise.all(imagePromises);
        } else {
             return NextResponse.json({ error: 'No imageUrls found in JSON body.', logs: logs }, { status: 400 });
        }

    } else {
      return NextResponse.json({ error: `Unsupported Content-Type: ${contentType}`, logs: logs }, { status: 415 });
    }

    const result = await stackImages({
        images: imageEntries,
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
    addLog(`[FATAL] ${errorMessage}`);
    return NextResponse.json({ error: 'Failed to process the request.', details: errorMessage, logs: logs }, { status: 500 });
  }
}
