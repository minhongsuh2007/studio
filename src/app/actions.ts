
'use server';

import {
  alignAndStack,
  consensusAlignAndStack,
  dumbAlignAndStack,
  planetaryAlignAndStack,
  type AlignmentMethod,
  type ImageQueueEntry,
  type StackingMode,
} from '@/lib/server-align';
import sharp from 'sharp';

// Helper to create an ImageData-like object that the alignment functions expect.
// This is a server-side interpretation.
interface ServerImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface ServerImagePayload {
  fileName: string;
  dataUrl: string;
}

async function decodeImage(
  dataUrl: string,
  id: string,
  log: (msg: string) => void
): Promise<ImageQueueEntry | null> {
  try {
    log(`[DECODE] Processing image: ${id}`);
    
    const base64Data = dataUrl.split(',')[1];
    if (!base64Data) {
      throw new Error("Invalid Data URL format.");
    }
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Use sharp to decode the image buffer
    const image = sharp(buffer, { failOn: 'none' });
    const metadata = await image.metadata();
    const { width, height, channels } = metadata;

    if (!width || !height) {
      throw new Error('Could not get image dimensions from sharp.');
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
      detectedStars: [], // Star detection will happen in the alignment function
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
): Promise<ImageQueueEntry | null> {
  try {
    log(`[FETCH] Downloading: ${url}`);
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch image. Status: ${response.status} ${response.statusText}`
      );
    }
    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const dataUrl = `data:${contentType};base64,${Buffer.from(buffer).toString('base64')}`;

    return await decodeImage(dataUrl, id, log);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`[ERROR] Failed to process URL ${url}: ${errorMessage}`);
    return null;
  }
}

export async function stackImages({
    images,
    alignmentMethod,
    stackingMode,
} : {
    images: (ImageQueueEntry | null)[],
    alignmentMethod: AlignmentMethod,
    stackingMode: StackingMode,
}) {
    const logs: string[] = [];
    const addLog = (message: string) => {
        logs.push(`[${new Date().toISOString()}] ${message}`);
        console.log(message);
    };

    try {
        const imageEntries = images.filter((entry): entry is ImageQueueEntry => entry !== null);

        if (imageEntries.length < 2) {
          return {
            success: false,
            message: 'Could not process enough images to perform stacking.',
            details: 'Fewer than two images were successfully decoded.',
            logs,
          };
        }
        addLog(`Successfully processed ${imageEntries.length} images.`);

        let stackedImageBuffer: Uint8ClampedArray;
        const setProgress = (p: number) => {
          addLog(`Stacking progress: ${Math.round(p * 100)}%`);
        };

        switch (alignmentMethod) {
          case 'consensus':
            stackedImageBuffer = await consensusAlignAndStack({
              imageEntries,
              stackingMode,
              addLog,
              setProgress,
            });
            break;
          case 'planetary':
            stackedImageBuffer = await planetaryAlignAndStack(
              imageEntries,
              stackingMode,
              addLog,
              setProgress,
              80 // Default quality for now
            );
            break;
          case 'dumb':
            stackedImageBuffer = await dumbAlignAndStack({
              imageEntries,
              stackingMode,
              addLog,
              setProgress,
            });
            break;
          case 'standard':
          default:
            stackedImageBuffer = await alignAndStack(
              imageEntries,
              [], // No manual stars from server
              stackingMode,
              setProgress,
              addLog
            );
            break;
        }
        addLog('Alignment and stacking complete.');

        const { width, height } = imageEntries[0].analysisDimensions;
        // Use sharp to encode the final raw pixel data back to a PNG buffer
        const finalImage = await sharp(Buffer.from(stackedImageBuffer), {
          raw: {
            width: width,
            height: height,
            channels: 4, // RGBA
          },
        })
          .png()
          .toBuffer();

        const stackedImageUrl = `data:image/png;base64,${finalImage.toString('base64')}`;

        addLog('Final image encoded successfully.');
        return {
          success: true,
          message: `Successfully stacked ${imageEntries.length} images.`,
          stackedImageUrl,
          width,
          height,
          logs,
        };

    } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'An unknown error occurred.';
        addLog(`[FATAL_ERROR] ${errorMessage}`);
        console.error(error);

        return {
          success: false,
          message: 'An unexpected error occurred during the stacking process.',
          details: errorMessage,
          logs,
        };
    }
}


export async function stackImagesWithUrls(prevState: any, formData: FormData) {
  const logs: string[] = [];
  const addLog = (message: string) => {
    logs.push(`[${new Date().toISOString()}] ${message}`);
    console.log(message);
  };
  addLog('Server Action `stackImagesWithUrls` invoked.');

  const rawUrls = formData.get('imageUrls') as string;
  const alignmentMethod = (formData.get('alignmentMethod') as AlignmentMethod) || 'standard';
  const stackingMode = (formData.get('stackingMode') as StackingMode) || 'median';

  if (!rawUrls || rawUrls.trim() === '') {
     return { success: false, message: 'No image URLs provided.', logs };
  }
  const imageUrls = rawUrls.split('\n').filter(url => url.trim() !== '');
  if (imageUrls.length < 2) {
    return { success: false, message: 'At least two image URLs are required.', logs };
  }
  
  addLog(`Received ${imageUrls.length} URLs. Alignment: ${alignmentMethod}, Mode: ${stackingMode}.`);
  addLog('Starting image download and decoding process...');
  
  // This server action now proxies the request to the API route
  // to avoid Server Action body size limits and leverage robust request handling.
  try {
    const apiResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/stack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        imageUrls,
        alignmentMethod,
        stackingMode
      })
    });

    if (!apiResponse.ok) {
      let errorBody;
      try {
        errorBody = await apiResponse.json();
      } catch (e) {
        errorBody = { error: "Failed to parse API error response.", details: await apiResponse.text() };
      }
      addLog(`[API_PROXY_ERROR] API responded with status ${apiResponse.status}`);
      return {
        success: false,
        message: errorBody.error || `API Error: ${apiResponse.statusText}`,
        details: errorBody.details,
        logs: [...logs, ...(errorBody.logs || [])]
      };
    }

    const result = await apiResponse.json();
    return {
      success: true,
      ...result,
      logs: [...logs, ...result.logs],
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "An unknown proxy error occurred.";
    addLog(`[PROXY_FATAL_ERROR] ${errorMessage}`);
    return {
      success: false,
      message: "Failed to communicate with the stacking API.",
      details: errorMessage,
      logs,
    };
  }
}
