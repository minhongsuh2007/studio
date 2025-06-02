"use client";

import Image from 'next/image';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

interface ImageQueueItemProps {
  file: File;
  previewUrl: string;
  onRemove: () => void;
  isProcessing: boolean;
}

export function ImageQueueItem({ file, previewUrl, onRemove, isProcessing }: ImageQueueItemProps) {
  return (
    <Card className="relative group overflow-hidden shadow-md hover:shadow-lg transition-shadow">
      <CardContent className="p-0">
        <Image
          src={previewUrl}
          alt={file.name}
          width={150}
          height={100}
          className="object-cover w-full h-32"
          data-ai-hint="astronomy space"
        />
        <div className="absolute inset-0 bg-black/30 group-hover:bg-black/50 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
          <Button
            variant="destructive"
            size="icon"
            onClick={onRemove}
            disabled={isProcessing}
            aria-label="Remove image"
            className="h-8 w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
      <div className="p-2 text-xs text-muted-foreground truncate bg-card-foreground/5">
        {file.name}
      </div>
    </Card>
  );
}
