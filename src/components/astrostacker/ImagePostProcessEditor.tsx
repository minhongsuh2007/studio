
"use client";

import type React from 'react';
import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Download, Loader2, RotateCcw } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import { StarAnnotationCanvas } from './StarAnnotationCanvas';
import { applyPostProcessing, calculateHistogram } from '@/lib/post-process';
import { ScrollArea } from '../ui/scroll-area';
import type { PostProcessSettings, Point, Channel, ColorBalance } from '@/types';
import { CurveEditor } from './CurveEditor';
import { ColorBalanceEditor } from './ColorBalanceEditor';

interface ImagePostProcessEditorProps {
  isOpen: boolean;
  onClose: () => void;
  baseImageUrl: string | null;
  editedImageUrl: string | null;
  isAdjusting: boolean;
  outputFormat: 'png' | 'jpeg';
  jpegQuality: number;
  
  settings: PostProcessSettings;
  onSettingsChange: (settings: PostProcessSettings) => void;
  onResetAdjustments: () => void;
}

export function ImagePostProcessEditor({
  isOpen,
  onClose,
  baseImageUrl,
  editedImageUrl,
  isAdjusting,
  outputFormat,
  jpegQuality,
  settings,
  onSettingsChange,
  onResetAdjustments
}: ImagePostProcessEditorProps) {

  const [histogramData, setHistogramData] = useState<any[]>([]);
  
  useEffect(() => {
    if (!isOpen || !baseImageUrl) return;

    const generateHistogram = async () => {
      const data = await calculateHistogram(baseImageUrl);
      setHistogramData(data);
    };
    generateHistogram();
  }, [isOpen, baseImageUrl]);
  
  const handleDownloadFinal = async () => {
    if (!baseImageUrl) return;
    const finalUrl = await applyPostProcessing(
      baseImageUrl,
      settings,
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
  
  const handleBasicSettingsChange = (newBasics: PostProcessSettings['basic']) => {
    onSettingsChange({ ...settings, basic: newBasics });
  };
  
  const handleCurveChange = (channel: Channel, newPoints: Point[]) => {
    onSettingsChange({
      ...settings,
      curves: {
        ...settings.curves,
        [channel]: newPoints,
      }
    })
  };

  const handleColorBalanceChange = (newBalance: ColorBalance) => {
    onSettingsChange({ ...settings, colorBalance: newBalance });
  };


  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-7xl w-[95vw] h-[90vh] flex flex-col p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Edit & Download Final Image</DialogTitle>
          <DialogDescription>
            Adjust settings across tabs. The final image will be generated on download. Output: {outputFormat.toUpperCase()} {outputFormat === 'jpeg' ? `(Q: ${jpegQuality}%)` : ''}
          </DialogDescription>
        </DialogHeader>
        
        <div className="flex-grow flex flex-col md:flex-row gap-6 min-h-0">
            <div className="md:w-2/3 flex flex-col min-h-0">
                <div className="flex-grow min-h-0 relative aspect-video bg-black rounded-md">
                    {isAdjusting && (
                    <div className="absolute inset-0 bg-background/50 flex items-center justify-center z-20 rounded-md">
                        <Loader2 className="h-12 w-12 animate-spin text-accent" />
                    </div>
                    )}
                    <StarAnnotationCanvas
                        imageUrl={editedImageUrl!}
                        allStars={[]}
                        manualStars={[]}
                        onCanvasClick={() => {}}
                        analysisWidth={0}
                        analysisHeight={0}
                        categories={[]}
                        isReadOnly={true}
                    />
                </div>
                 <div className="w-full h-32 mt-4">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={histogramData} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                            <XAxis dataKey="level" fontSize={10} stroke="hsl(var(--muted-foreground))" />
                            <YAxis fontSize={10} stroke="hsl(var(--muted-foreground))"/>
                            <Tooltip wrapperClassName="!bg-popover !border-border text-xs" cursor={{ fill: 'hsla(var(--muted), 0.5)' }} />
                            <Bar dataKey="r" fill="rgba(255, 99, 132, 0.6)" barSize={4}/>
                            <Bar dataKey="g" fill="rgba(75, 192, 192, 0.6)" barSize={4}/>
                            <Bar dataKey="b" fill="rgba(54, 162, 235, 0.6)" barSize={4}/>
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </div>
            
            <div className="md:w-1/3 flex flex-col">
            <ScrollArea className="h-full pr-3">
                <Tabs defaultValue="basic" className="w-full">
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="basic">Basic</TabsTrigger>
                    <TabsTrigger value="curves">Curves</TabsTrigger>
                    <TabsTrigger value="color">Color</TabsTrigger>
                  </TabsList>
                  
                  <TabsContent value="basic" className="p-1 space-y-6 mt-4">
                      <div className="space-y-3">
                        <Label htmlFor="brightnessSlider">Brightness: {settings.basic.brightness.toFixed(0)}%</Label>
                        <Slider id="brightnessSlider" value={[settings.basic.brightness]} onValueChange={([v]) => handleBasicSettingsChange({...settings.basic, brightness: v})} min={0} max={200} step={1} disabled={isAdjusting} />
                      </div>
                      <div className="space-y-3">
                        <Label htmlFor="exposureSlider">Exposure: {settings.basic.exposure.toFixed(0)}</Label>
                        <Slider id="exposureSlider" value={[settings.basic.exposure]} onValueChange={([v]) => handleBasicSettingsChange({...settings.basic, exposure: v})} min={-100} max={100} step={1} disabled={isAdjusting} />
                      </div>
                      <div className="space-y-3">
                        <Label htmlFor="saturationSlider">Saturation: {settings.basic.saturation.toFixed(0)}%</Label>
                        <Slider id="saturationSlider" value={[settings.basic.saturation]} onValueChange={([v]) => handleBasicSettingsChange({...settings.basic, saturation: v})} min={0} max={200} step={1} disabled={isAdjusting} />
                      </div>
                  </TabsContent>

                  <TabsContent value="curves" className="p-1 mt-4">
                      <CurveEditor 
                        curves={settings.curves}
                        onCurveChange={handleCurveChange}
                        histogram={histogramData}
                      />
                  </TabsContent>

                  <TabsContent value="color" className="p-1 mt-4">
                      <ColorBalanceEditor
                          balance={settings.colorBalance}
                          onBalanceChange={handleColorBalanceChange}
                      />
                  </TabsContent>

                </Tabs>
            </ScrollArea>
            </div>
        </div>

        <DialogFooter className="mt-4 pt-4 border-t flex-shrink-0">
           <Button onClick={onResetAdjustments} variant="outline">
                <RotateCcw className="mr-2 h-4 w-4" /> Reset All
            </Button>
            <Button onClick={handleDownloadFinal} className="bg-accent hover:bg-accent/90 text-accent-foreground" disabled={isAdjusting}>
                <Download className="mr-2 h-4 w-4" />
                Download Final Image
            </Button>
            <Button variant="secondary" onClick={onClose}>Close Editor</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
