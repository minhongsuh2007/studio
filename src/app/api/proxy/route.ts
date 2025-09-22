
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const url = searchParams.get('url');

    if (!url) {
        return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    try {
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.startsWith('image/')) {
            // If the content type is not an image, we try to parse it as HTML and find an og:image tag
            const html = await response.text();
            const ogImageMatch = html.match(/<meta\s+(?:property="og:image"|name="og:image")\s+content="([^"]+)"/);
            
            if (ogImageMatch && ogImageMatch[1]) {
                const ogImageUrl = ogImageMatch[1];
                // Fetch the actual image from the og:image URL
                const imageResponse = await fetch(ogImageUrl);
                if (!imageResponse.ok) {
                    throw new Error(`Failed to fetch og:image: ${imageResponse.status}`);
                }
                const imageBody = await imageResponse.arrayBuffer();
                const imageContentType = imageResponse.headers.get('content-type') || 'image/jpeg';
                
                return new NextResponse(imageBody, {
                    headers: { 'Content-Type': imageContentType },
                });
            } else {
                 return NextResponse.json({ error: 'URL did not point to an image and no og:image found.' }, { status: 400 });
            }
        }

        const body = await response.arrayBuffer();
        
        return new NextResponse(body, {
            headers: { 'Content-Type': contentType },
        });

    } catch (error) {
        const message = error instanceof Error ? error.message : 'An unknown error occurred';
        console.error(`[PROXY ERROR] for url: ${url}`, error);
        return NextResponse.json({ error: 'Failed to proxy image', details: message }, { status: 500 });
    }
}
