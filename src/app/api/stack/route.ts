
import { NextRequest, NextResponse } from 'next/server';
import { stackImages } from '@/app/actions';
import { AlignmentMethod, StackingMode, type ImageQueueEntry as ServerImageQueueEntry } from '@/lib/server-align';
import sharp from 'sharp';

// This is a server-side stand-in for the browser's ImageData object.
// It is not the same and does not have the same prototype chain.
interface ServerImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

async function decodeImageBuffer(
  buffer: Buffer,
  id: string,
  log: (msg: string) => void
): Promise<ServerImageQueueEntry | null> {
  try {
    log(`[DECODE] Processing image: ${id}`);
    
    // Use sharp to decode the image buffer
    const image = sharp(buffer, { failOn: 'none' }); // failOn: 'none' is important
    const metadata = await image.metadata();

    let width = metadata.width;
    let height = metadata.height;
    
    // Fallback for formats sharp might not get dimensions for (like FITS)
    if (!width || !height) {
        log(`[DECODE_WARN] Sharp could not determine dimensions for ${id}. Buffer length: ${buffer.length}. Attempting to proceed.`);
        // This is a heuristic. If we can't get dimensions, we can't reliably process it.
        // We'll set dummy dimensions and let downstream alignment fail, but at least we log it.
        width = 1;
        height = 1;
        // A more advanced solution would be to use a FITS-specific parser here as a fallback.
        // For now, we accept that some files may fail.
        return null;
    }

    // Ensure the image has an alpha channel and get raw pixel data
    const rawData = await image.ensureAlpha().raw().toBuffer();

    const imageData: ServerImageData = {
      data: new Uint8ClampedArray(rawData),
      width,
      height,
    };

    return {
      id,
      // @ts-ignore - We are creating a server-side stand-in for the browser's ImageData
      imageData: imageData,
      detectedStars: [], // Star detection will happen in the alignment function on the server
      analysisDimensions: { width, height },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`[ERROR] Failed to decode image ${id}: ${errorMessage}`);
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
    const response = await fetch(url, { 
      headers: { 
        // Some servers block requests without a user-agent
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' 
      }
    });
    if (!response.ok) throw new Error(`Fetch failed with status ${response.status} for URL ${url}`);
    
    const buffer = Buffer.from(await response.arrayBuffer());
    return await decodeImageBuffer(buffer, id, log);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`[ERROR] Failed to process URL ${url}: ${errorMessage}`);
    return null;
  }
}

export async function POST(req: NextRequest) {
  const logs: string[] = [];
  const addLog = (message: string) => {
      const logMsg = `[${new Date().toISOString()}] ${message}`;
      logs.push(logMsg);
      console.log(logMsg);
  };

  try {
    const contentType = req.headers.get('content-type') || '';
    let imageEntries: (ServerImageQueueEntry | null)[] = [];
    let alignmentMethod: AlignmentMethod = 'consensus';
    let stackingMode: StackingMode = 'median';

    if (contentType.includes('application/json')) {
        addLog('Processing JSON request...');
        const body = await req.json();
        const imageUrls = body.imageUrls as string[];
        alignmentMethod = (body.alignmentMethod as AlignmentMethod) || 'consensus';
        stackingMode = (body.stackingMode as StackingMode) || 'median';
        
        if (!imageUrls || imageUrls.length === 0) {
             return NextResponse.json({ error: 'No imageUrls found in JSON body.', logs }, { status: 400 });
        }
        
        addLog(`Received ${imageUrls.length} URLs from JSON body.`);
        const imagePromises = imageUrls.map((url, index) =>
            fetchAndDecodeImage(url, `url_${index}`, addLog)
        );
        imageEntries = await Promise.all(imagePromises);

    } else {
      return NextResponse.json({ error: `Unsupported Content-Type: ${contentType}. Only application/json is supported.`, logs }, { status: 415 });
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
    return NextResponse.json({ error: 'Failed to process the request.', details: errorMessage, logs }, { status: 500 });
  }
}
