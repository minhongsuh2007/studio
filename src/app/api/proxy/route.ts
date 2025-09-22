
import { NextResponse, type NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const url = searchParams.get('url');

    if (!url) {
        return NextResponse.json({ error: 'URL parameter is required.' }, { status: 400 });
    }

    try {
        const response = await fetch(url, {
            headers: {
                // Some sites might block requests without a user-agent
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch image with status: ${response.status}`);
        }

        const blob = await response.blob();

        // Create a new response with the blob data and appropriate headers
        const headers = new Headers();
        headers.set('Content-Type', blob.type);
        headers.set('Content-Length', blob.size.toString());

        return new Response(blob, { status: 200, headers });

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[PROXY_ERROR] for ${url}:`, error);
        return NextResponse.json({ error: 'Failed to fetch the requested URL.', details: errorMessage }, { status: 500 });
    }
}
