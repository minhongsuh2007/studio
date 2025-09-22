
import { NextRequest, NextResponse } from 'next/server';
import { stackImagesWithUrls } from '@/app/actions';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { imageUrls, alignmentMethod, stackingMode } = body;

    if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length < 2) {
      return NextResponse.json({ error: 'At least two image URLs are required.' }, { status: 400 });
    }

    // Convert the JSON body to FormData to be compatible with the server action
    const formData = new FormData();
    formData.append('imageUrls', imageUrls.join('\n'));
    formData.append('alignmentMethod', alignmentMethod || 'standard');
    formData.append('stackingMode', stackingMode || 'median');

    // The server action's first argument `prevState` is not used in this context, so we can pass null.
    const result = await stackImagesWithUrls(null, formData);

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
    return NextResponse.json({ error: 'Failed to process the request.', details: errorMessage }, { status: 500 });
  }
}
