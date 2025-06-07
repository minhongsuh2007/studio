
"use client";

import type React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { ImagePreview } from './ImagePreview';
import { DownloadButton } from './DownloadButton';
import { Loader2, RotateCcw } from 'lucide-react';

interface ImagePostProcessEditorProps {
  isOpen: boolean;
  onClose: () => void;
  baseImageUrl: string | null;
  editedImageUrl: string | null;
  brightness: number;
  setBrightness: (value: number) => void;
  exposure: number;
  setExposure: (value: number) => void;
  saturation: number;
  setSaturation: (value: number) => void;
  onResetAdjustments: () => void;
  isAdjusting: boolean;
  outputFormat: 'png' | 'jpeg';
  jpegQuality: number;
}

export function ImagePostProcessEditor({
  isOpen,
  onClose,
  editedImageUrl,
  brightness,
  setBrightness,
  exposure,
  setExposure,
  saturation,
  setSaturation,
  onResetAdjustments,
  isAdjusting,
  outputFormat,
  jpegQuality
}: ImagePostProcessEditorProps) {
  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl w-[90vw] h-[90vh] flex flex-col p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Edit & Download Final Image</DialogTitle>
          <DialogDescription>
            Adjust brightness, exposure, and saturation. Download when ready. Output: {outputFormat.toUpperCase()} {outputFormat === 'jpeg' ? `(Q: ${jpegQuality}%)` : ''}
          </DialogDescription>
        </DialogHeader>
        
        <div className="flex-grow grid grid-cols-1 md:grid-cols-3 gap-4 overflow-hidden min-h-0">
          <div className="md:col-span-2 flex flex-col min-h-0">
            {isAdjusting && (
              <div className="absolute inset-0 bg-background/50 flex items-center justify-center z-10 rounded-md">
                <Loader2 className="h-12 w-12 animate-spin text-accent" />
              </div>
            )}
            <ImagePreview imageUrl={editedImageUrl} fitMode="contain" />
          </div>
          
          <div className="space-y-6 overflow-y-auto p-1 md:col-span-1 flex flex-col">
            <div className="space-y-3">
              <Label htmlFor="brightnessSlider" className="text-sm font-medium">Brightness: {brightness.toFixed(0)}%</Label>
              <Slider
                id="brightnessSlider"
                value={[brightness]}
                onValueChange={([v]) => setBrightness(v)}
                min={0}
                max={200}
                step={1}
                disabled={isAdjusting}
              />
            </div>
            <div className="space-y-3">
              <Label htmlFor="exposureSlider" className="text-sm font-medium">Exposure: {exposure.toFixed(0)}</Label>
              <Slider
                id="exposureSlider"
                value={[exposure]}
                onValueChange={([v]) => setExposure(v)}
                min={-100}
                max={100}
                step={1}
                disabled={isAdjusting}
              />
            </div>
            <div className="space-y-3">
              <Label htmlFor="saturationSlider" className="text-sm font-medium">Saturation: {saturation.toFixed(0)}%</Label>
              <Slider
                id="saturationSlider"
                value={[saturation]}
                onValueChange={([v]) => setSaturation(v)}
                min={0}
                max={200}
                step={1}
                disabled={isAdjusting}
              />
            </div>
            
            <div className="mt-auto space-y-3 pt-4">
                <Button onClick={onResetAdjustments} variant="outline" className="w-full" disabled={isAdjusting}>
                  <RotateCcw className="mr-2 h-4 w-4" /> Reset Adjustments
                </Button>
                <DownloadButton
                    imageUrl={editedImageUrl}
                    isProcessing={isAdjusting}
                    fileName={`astrostacker_edited_${outputFormat === 'jpeg' ? `q${jpegQuality}` : ''}.${outputFormat}`}
                />
            </div>
          </div>
        </div>

        <DialogFooter className="mt-4 pt-4 border-t">
          <Button variant="outline" onClick={onClose} disabled={isAdjusting}>Close Editor</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
