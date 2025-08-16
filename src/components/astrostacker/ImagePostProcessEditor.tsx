
"use client";

import type React from 'react';
import { useState, useEffect, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Download, Loader2, RotateCcw } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import { StarAnnotationCanvas } from './StarAnnotationCanvas';
import { applyPostProcessing, calculateHistogram, detectStarsForRemoval } from '@/lib/post-process';
import type { Star } from '@/lib/astro-align';

interface BasicSettings {
  brightness: number;
  exposure: number;
  saturation: number;
}
interface HistogramSettings {
  blackPoint: number;
  midtones: number;
  whitePoint: number;
}
interface StarRemovalSettings {
  strength: number;
}

interface ImagePostProcessEditorProps {
  isOpen: boolean;
  onClose: () => void;
  baseImageUrl: string | null;
  editedImageUrl: string | null;
  isAdjusting: boolean;
  outputFormat: 'png' | 'jpeg';
  jpegQuality: number;
  onResetAdjustments: () => void;
  
  basicSettings: BasicSettings;
  onBasicSettingsChange: (settings: BasicSettings) => void;
  
  histogramSettings: HistogramSettings;
  onHistogramSettingsChange: (settings: HistogramSettings) => void;
  
  starRemovalSettings: StarRemovalSettings;
  onStarRemovalSettingsChange: (settings: StarRemovalSettings) => void;
}

export function ImagePostProcessEditor({
  isOpen,
  onClose,
  baseImageUrl,
  editedImageUrl,
  isAdjusting,
  outputFormat,
  jpegQuality,
  onResetAdjustments,
  basicSettings,
  onBasicSettingsChange,
  histogramSettings,
  onHistogramSettingsChange,
  starRemovalSettings,
  onStarRemovalSettingsChange
}: ImagePostProcessEditorProps) {
  const [histogramData, setHistogramData] = useState<any[]>([]);
  const [starsForRemoval, setStarsForRemoval] = useState<Star[]>([]);
  
  useEffect(() => {
    if (!isOpen || !baseImageUrl) return;

    const generateHistogram = async () => {
      const data = await calculateHistogram(baseImageUrl);
      setHistogramData(data);
    };
    generateHistogram();
  }, [isOpen, baseImageUrl]);
  
  useEffect(() => {
    if (!isOpen || !baseImageUrl || starRemovalSettings.strength === 0) {
      setStarsForRemoval([]);
      return;
    };

    const detectStars = async () => {
      const stars = await detectStarsForRemoval(baseImageUrl, starRemovalSettings.strength);
      setStarsForRemoval(stars);
    };

    const debounce = setTimeout(detectStars, 100);
    return () => clearTimeout(debounce);
  }, [isOpen, baseImageUrl, starRemovalSettings.strength]);

  const handleDownloadFinal = async () => {
    if (!baseImageUrl) return;
    const finalUrl = await applyPostProcessing(
      baseImageUrl,
      basicSettings,
      histogramSettings,
      { strength: starRemovalSettings.strength, apply: starRemovalSettings.strength > 0 },
      outputFormat,
      jpegQuality / 100
    );

    const link = document.createElement('a');
    link.href = finalUrl;
    link.download = `astrostacker_edited_${outputFormat === 'jpeg' ? `q${jpegQuality}` : ''}.${outputFormat}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-6xl w-[95vw] h-[90vh] flex flex-col p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Edit & Download Final Image</DialogTitle>
          <DialogDescription>
            Adjust settings across tabs. The final image will be generated on download. Output: {outputFormat.toUpperCase()} {outputFormat === 'jpeg' ? `(Q: ${jpegQuality}%)` : ''}
          </DialogDescription>
        </DialogHeader>
        
        <div className="flex-grow grid grid-cols-1 md:grid-cols-3 gap-6 overflow-hidden min-h-0">
          <div className="md:col-span-2 min-h-0 relative overflow-auto border rounded-md">
            {isAdjusting && (
              <div className="absolute inset-0 bg-background/50 flex items-center justify-center z-20 rounded-md">
                <Loader2 className="h-12 w-12 animate-spin text-accent" />
              </div>
            )}
            <StarAnnotationCanvas
                imageUrl={editedImageUrl!}
                allStars={starsForRemoval}
                manualStars={[]} // Not used for selection here, just display
                onCanvasClick={() => {}} // Read-only
                analysisWidth={0} // Will be determined by image
                analysisHeight={0}
            />
          </div>
          
          <div className="md:col-span-1 flex flex-col">
            <Tabs defaultValue="basic" className="w-full flex-grow flex flex-col">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="basic">Basic</TabsTrigger>
                <TabsTrigger value="histogram">Histogram</TabsTrigger>
                <TabsTrigger value="stars">Stars</TabsTrigger>
              </TabsList>
              
              <TabsContent value="basic" className="flex-grow overflow-y-auto p-1 space-y-6 mt-4">
                  <div className="space-y-3">
                    <Label htmlFor="brightnessSlider">Brightness: {basicSettings.brightness.toFixed(0)}%</Label>
                    <Slider id="brightnessSlider" value={[basicSettings.brightness]} onValueChange={([v]) => onBasicSettingsChange({...basicSettings, brightness: v})} min={0} max={200} step={1} disabled={isAdjusting} />
                  </div>
                  <div className="space-y-3">
                    <Label htmlFor="exposureSlider">Exposure: {basicSettings.exposure.toFixed(0)}</Label>
                    <Slider id="exposureSlider" value={[basicSettings.exposure]} onValueChange={([v]) => onBasicSettingsChange({...basicSettings, exposure: v})} min={-100} max={100} step={1} disabled={isAdjusting} />
                  </div>
                  <div className="space-y-3">
                    <Label htmlFor="saturationSlider">Saturation: {basicSettings.saturation.toFixed(0)}%</Label>
                    <Slider id="saturationSlider" value={[basicSettings.saturation]} onValueChange={([v]) => onBasicSettingsChange({...basicSettings, saturation: v})} min={0} max={200} step={1} disabled={isAdjusting} />
                  </div>
              </TabsContent>
              
              <TabsContent value="histogram" className="flex-grow overflow-y-auto p-1 space-y-4 mt-4">
                  <div className="w-full h-40">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={histogramData} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
                            <XAxis dataKey="level" fontSize={10} />
                            <YAxis fontSize={10} />
                            <Tooltip wrapperClassName="!bg-popover !border-border text-xs" cursor={{ fill: 'hsla(var(--muted), 0.5)' }} />
                            <Bar dataKey="r" fill="rgba(255, 50, 50, 0.6)" barSize={4}/>
                            <Bar dataKey="g" fill="rgba(50, 255, 50, 0.6)" barSize={4}/>
                            <Bar dataKey="b" fill="rgba(50, 50, 255, 0.6)" barSize={4}/>
                        </BarChart>
                      </ResponsiveContainer>
                  </div>
                  <div className="space-y-3">
                    <Label>Black Point: {histogramSettings.blackPoint}</Label>
                    <Slider value={[histogramSettings.blackPoint]} onValueChange={([v]) => onHistogramSettingsChange({...histogramSettings, blackPoint: v})} min={0} max={127} step={1} />
                  </div>
                  <div className="space-y-3">
                     <Label>Midtones: {histogramSettings.midtones.toFixed(2)}</Label>
                     <Slider value={[histogramSettings.midtones]} onValueChange={([v]) => onHistogramSettingsChange({...histogramSettings, midtones: v})} min={0} max={1} step={0.01} />
                  </div>
                  <div className="space-y-3">
                    <Label>White Point: {histogramSettings.whitePoint}</Label>
                    <Slider value={[histogramSettings.whitePoint]} onValueChange={([v]) => onHistogramSettingsChange({...histogramSettings, whitePoint: v})} min={128} max={255} step={1} />
                  </div>
              </TabsContent>

              <TabsContent value="stars" className="flex-grow overflow-y-auto p-1 space-y-4 mt-4">
                <div className="space-y-3">
                    <Label>Star Removal Strength: {starRemovalSettings.strength}</Label>
                    <p className="text-xs text-muted-foreground">Adjust to select stars for removal. Detected: {starsForRemoval.length}. Final removal happens on download.</p>
                    <Slider value={[starRemovalSettings.strength]} onValueChange={([v]) => onStarRemovalSettingsChange({strength: v})} min={0} max={255} step={1} />
                  </div>
              </TabsContent>
            </Tabs>
             <div className="mt-auto space-y-3 pt-4">
                <Button onClick={onResetAdjustments} variant="outline" className="w-full">
                  <RotateCcw className="mr-2 h-4 w-4" /> Reset All Adjustments
                </Button>
                 <Button onClick={handleDownloadFinal} className="w-full bg-accent hover:bg-accent/90 text-accent-foreground" disabled={isAdjusting}>
                   <Download className="mr-2 h-4 w-4" />
                   Download Final Image
                 </Button>
            </div>
          </div>
        </div>

        <DialogFooter className="mt-4 pt-4 border-t">
          <Button variant="outline" onClick={onClose}>Close Editor</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
