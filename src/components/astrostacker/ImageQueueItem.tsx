
"use client";

import type React from 'react';
import Image from 'next/image';
import { X, Edit3, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';

interface ImageQueueItemProps {
  id: string;
  index: number;
  file: File;
  previewUrl: string;
  isAnalyzing: boolean;
  onRemove: () => void;
  onManualSelectToggle: () => void;
  isProcessing: boolean;
  isAnalyzed: boolean;
  isManualSelectMode: boolean;
}

export function ImageQueueItem({
  id,
  index,
  file,
  previewUrl,
  isAnalyzing,
  onRemove,
  onManualSelectToggle,
  isProcessing,
  isAnalyzed,
  isManualSelectMode,
}: ImageQueueItemProps) {
  
  const isReferenceImage = index === 0;

  return (
    <Card className="relative group overflow-hidden shadow-md hover:shadow-lg transition-shadow flex flex-col">
      <CardContent className="p-0 relative">
        <Image
          src={previewUrl}
          alt={file.name}
          width={200} 
          height={120}
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
         {isAnalyzing && (
             <div className="absolute bottom-1 left-1 bg-background/80 text-foreground p-1 rounded-sm text-xs flex items-center">
                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Analyzing...
             </div>
         )}
         {!isAnalyzed && !isAnalyzing && (
            <div className="absolute bottom-1 right-1 bg-yellow-500/80 text-background p-1 rounded-sm text-xs flex items-center" title="Needs Analysis">
                 Needs Analysis
             </div>
         )}
         {isReferenceImage && (
            <div className="absolute top-1 left-1 bg-accent/90 text-accent-foreground px-2 py-0.5 rounded-full text-xs font-bold">
                REF
            </div>
         )}
      </CardContent>
      <div className="p-2 text-xs text-muted-foreground truncate bg-card-foreground/5 flex-grow">
        {file.name}
      </div>
      <CardFooter className="p-2 border-t">
        {isReferenceImage && (
           <Button
            variant={isManualSelectMode ? "secondary" : "outline"}
            size="sm"
            onClick={onManualSelectToggle}
            disabled={isProcessing || isAnalyzing || !isAnalyzed}
            className="w-full"
            title={!isAnalyzed ? "Waiting for analysis to complete..." : "Select stars manually on this reference image"}
          >
            <Edit3 className="mr-2 h-4 w-4" />
            {isManualSelectMode ? "Exit Selection Mode" : "Select Stars"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

    