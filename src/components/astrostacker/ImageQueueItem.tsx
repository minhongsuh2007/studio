
"use client";

import Image from 'next/image';
import { X, Edit3, Loader2, CheckCircle, Orbit, Settings2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { StarSelectionMode } from '@/app/page'; 

interface ImageQueueItemProps {
  id: string;
  file: File;
  previewUrl: string;
  isAnalyzing: boolean;
  isReviewed: boolean; 
  starSelectionMode: StarSelectionMode;
  onRemove: () => void;
  onEditStars: () => void;
  onToggleStarSelectionMode: () => void;
  isProcessing: boolean; 
  isAnalyzed: boolean;
  analysisDimensions: { width: number; height: number };
}

export function ImageQueueItem({
  id,
  file,
  previewUrl,
  isAnalyzing,
  isReviewed,
  starSelectionMode,
  onRemove,
  onEditStars,
  onToggleStarSelectionMode,
  isProcessing,
  isAnalyzed,
  analysisDimensions
}: ImageQueueItemProps) {
  const isManualMode = starSelectionMode === 'manual';

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
        {isManualMode && isReviewed && (
            <div className="absolute top-1 left-1 bg-green-500/80 text-white p-1 rounded-full flex items-center justify-center h-5 w-5" title="Manual stars confirmed/applied">
                <CheckCircle className="h-3 w-3" />
            </div>
        )}
         {isAnalyzing && (
             <div className="absolute bottom-1 left-1 bg-background/80 text-foreground p-1 rounded-sm text-xs flex items-center">
                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Analyzing...
             </div>
         )}
         {!isAnalyzed && !isAnalyzing && (
            <div className="absolute bottom-1 right-1 bg-yellow-500/80 text-background p-1 rounded-sm text-xs flex items-center" title="Needs Analysis">
                <AlertTriangle className="mr-1 h-3 w-3" /> Needs Analysis
             </div>
         )}
      </CardContent>
      <div className="p-2 text-xs text-muted-foreground truncate bg-card-foreground/5 flex-grow">
        {file.name} ({analysisDimensions.width}x{analysisDimensions.height})
      </div>
      <CardFooter className="p-2 border-t flex flex-col space-y-2">
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center space-x-2">
            <Switch
              id={`star-mode-switch-${id}`}
              checked={isManualMode}
              onCheckedChange={onToggleStarSelectionMode}
              disabled={isProcessing || isAnalyzing}
              aria-label={isManualMode ? "Switch to Automatic Star Detection" : "Switch to Manual Star Editing"}
            />
            <Label htmlFor={`star-mode-switch-${id}`} className="text-xs cursor-pointer flex items-center">
              {isManualMode ? <Settings2 className="mr-1 h-3 w-3" /> : <Orbit className="mr-1 h-3 w-3" />}
              {isManualMode ? 'Manual Stars' : 'Auto Stars'}
            </Label>
          </div>
         
        </div>
         <Button
            variant="outline"
            size="sm"
            onClick={onEditStars}
            disabled={isProcessing || isAnalyzing || !analysisDimensions } // Disable if no dimensions yet
            className="w-full"
            title={isAnalyzing ? "Analyzing..." : (isManualMode ? (isReviewed ? "Re-edit Manual Stars" : "Edit Manual Stars") : "Review/Edit (Switches to Manual)")}
          >
            {isAnalyzing && starSelectionMode === 'manual' ? ( 
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
                <Edit3 className="mr-2 h-4 w-4" />
            )}
            {isAnalyzing && starSelectionMode === 'manual' ? "Analyzing..." : (isManualMode ? (isReviewed ? "Re-Edit" : "Edit Stars") : "Review/Edit")}
          </Button>
      </CardFooter>
    </Card>
  );
}
