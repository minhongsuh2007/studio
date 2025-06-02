"use client";

import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface DownloadButtonProps {
  imageUrl: string | null;
  isProcessing: boolean;
}

export function DownloadButton({ imageUrl, isProcessing }: DownloadButtonProps) {
  const handleDownload = () => {
    if (!imageUrl) return;

    const link = document.createElement('a');
    link.href = imageUrl;
    // Suggest a filename. User can change it.
    // Try to determine extension from data URI, default to png
    let extension = 'png';
    const mimeMatch = imageUrl.match(/^data:image\/([a-zA-Z+]+);/);
    if (mimeMatch && mimeMatch[1]) {
      if (mimeMatch[1] === 'jpeg') extension = 'jpg';
      else if (['png', 'tiff', 'webp', 'gif'].includes(mimeMatch[1])) extension = mimeMatch[1];
    }
    link.download = `astrostacker_output.${extension}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <Button
      onClick={handleDownload}
      disabled={!imageUrl || isProcessing}
      className="w-full bg-accent hover:bg-accent/90 text-accent-foreground"
      size="lg"
    >
      <Download className="mr-2 h-5 w-5" />
      Download Image
    </Button>
  );
}
