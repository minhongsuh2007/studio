
"use client";

import Image from 'next/image';
import { X, Edit3, Loader2, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface ImageQueueItemProps {
  id: string;
  file: File;
  previewUrl: string;
  isAnalyzing: boolean;
  isReviewed: boolean;
  onRemove: () => void;
  onEditStars: () => void;
  isProcessing: boolean; // General UI disable flag
}

export function ImageQueueItem({
  id,
  file,
  previewUrl,
  isAnalyzing,
  isReviewed,
  onRemove,
  onEditStars,
  isProcessing
}: ImageQueueItemProps) {
  return (
    <Card className="relative group overflow-hidden shadow-md hover:shadow-lg transition-shadow flex flex-col">
      <CardContent className="p-0 relative">
        <Image
          src={previewUrl}
          alt={file.name}
          width={150}
          height={100}
          className="object-cover w-full h-32"
          data-ai-hint="sky night"
        />
        <div className="absolute top-1 right-1">
          <Button
            variant="destructive"
            size="icon"
            onClick={onRemove}
            disabled={isProcessing || isAnalyzing}
            aria-label="Remove image"
            className="h-7 w-7 opacity-80 hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {isReviewed && (
            <div className="absolute top-1 left-1 bg-green-500/80 text-white p-1 rounded-full">
                <CheckCircle className="h-4 w-4" />
            </div>
        )}
      </CardContent>
      <div className="p-2 text-xs text-muted-foreground truncate bg-card-foreground/5 flex-grow">
        {file.name}
      </div>
      <CardFooter className="p-2 border-t">
        <Button
            variant="outline"
            size="sm"
            onClick={onEditStars}
            disabled={isProcessing || isAnalyzing}
            className="w-full"
            title={isAnalyzing ? "Analyzing..." : (isReviewed ? "Re-edit Stars" : "Edit Stars")}
        >
            {isAnalyzing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
                <Edit3 className="mr-2 h-4 w-4" />
            )}
            {isAnalyzing ? "Analyzing..." : (isReviewed ? "Re-Edit" : "Edit Stars")}
        </Button>
      </CardFooter>
    </Card>
  );
}
