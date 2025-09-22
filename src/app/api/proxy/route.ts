
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
            throw new Error(`Initial fetch failed with status: ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type');
        
        // If it's a direct image link, proxy it
        if (contentType && contentType.startsWith('image/')) {
            const body = await response.arrayBuffer();
            return new NextResponse(body, {
                headers: { 'Content-Type': contentType },
            });
        }

        // If not, it might be an HTML page with an og:image tag
        const html = await response.text();
        const ogImageMatch = html.match(/<meta\s+(?:property="og:image"|name="og:image")\s+content="([^"]+)"/);
        
        if (ogImageMatch && ogImageMatch[1]) {
            const ogImageUrl = ogImageMatch[1];
            
            // Fetch the actual image from the og:image URL
            const imageResponse = await fetch(ogImageUrl);
            if (!imageResponse.ok) {
                throw new Error(`Failed to fetch og:image from ${ogImageUrl}: ${imageResponse.statusText}`);
            }
            
            const imageContentType = imageResponse.headers.get('content-type');
            if (!imageContentType || !imageContentType.startsWith('image/')) {
                 throw new Error(`The og:image URL did not point to a valid image. Found content-type: ${imageContentType}`);
            }

            const imageBody = await imageResponse.arrayBuffer();
            return new NextResponse(imageBody, {
                headers: { 'Content-Type': imageContentType },
            });
        }
        
        // If we're here, it's not a direct image and has no og:image tag.
        return NextResponse.json({ error: 'URL did not point to a direct image and no og:image meta tag was found.' }, { status: 400 });

    } catch (error) {
        const message = error instanceof Error ? error.message : 'An unknown error occurred';
        console.error(`[PROXY ERROR] for url: ${url}`, error);
        return NextResponse.json({ error: 'Failed to proxy and process the URL', details: message }, { status: 500 });
    }
}
