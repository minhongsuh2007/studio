"use client";

import type React from 'react';
import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { fileToDataURL } from '@/lib/utils';
import { initialStackFromPrompt } from '@/ai/flows/initial-stack-from-prompt';
import { adjustStackingParameters } from '@/ai/flows/adjust-stacking-parameters';

import { AppHeader } from '@/components/astrostacker/AppHeader';
import { ImageUploadArea } from '@/components/astrostacker/ImageUploadArea';
import { ImageQueueItem } from '@/components/astrostacker/ImageQueueItem';
import { ParameterControls } from '@/components/astrostacker/ParameterControls';
import { ImagePreview } from '@/components/astrostacker/ImagePreview';
import { DownloadButton } from '@/components/astrostacker/DownloadButton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Layers, Wand2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';


interface UploadedFile {
  file: File;
  previewUrl: string;
}

export default function AstroStackerPage() {
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [stackedImage, setStackedImage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [alignmentMethod, setAlignmentMethod] = useState<'auto' | 'star_alignment' | 'manual'>('auto');
  const [stackingMode, setStackingMode] = useState<'average' | 'lighten' | 'darken'>('average');
  const { toast } = useToast();

  const handleFilesAdded = async (files: File[]) => {
    setIsProcessing(true);
    const newUploadedFiles: UploadedFile[] = [];
    for (const file of files) {
      try {
        const previewUrl = await fileToDataURL(file);
        newUploadedFiles.push({ file, previewUrl });
      } catch (error) {
        toast({
          title: "Error reading file",
          description: `Could not read ${file.name}.`,
          variant: "destructive",
        });
      }
    }
    setUploadedFiles(prev => [...prev, ...newUploadedFiles]);
    setIsProcessing(false);
  };

  const handleRemoveImage = (indexToRemove: number) => {
    setUploadedFiles(prev => prev.filter((_, index) => index !== indexToRemove));
  };

  const handleStackImages = async () => {
    if (uploadedFiles.length === 0) {
      toast({ title: "No images", description: "Please upload images to stack." });
      return;
    }
    setIsProcessing(true);
    setStackedImage(null); // Clear previous stacked image

    try {
      const imageUrls = await Promise.all(uploadedFiles.map(f => fileToDataURL(f.file)));
      const result = await initialStackFromPrompt({
        imageUrls,
        prompt: "Stack these astrophotography images to reduce noise and significantly enhance celestial details, colors, and clarity. Aim for a visually stunning and scientifically accurate representation of the deep sky object(s).",
      });
      setStackedImage(result.stackedImageUrl);
      toast({ title: "Stacking Complete", description: "Images stacked successfully." });
    } catch (error) {
      console.error("Stacking error:", error);
      toast({
        title: "Stacking Failed",
        description: "An error occurred while stacking images. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAdjustParameters = async () => {
    if (!stackedImage) {
      toast({ title: "No Base Image", description: "Please stack images first before adjusting parameters." });
      return;
    }
    setIsProcessing(true);
    try {
      const result = await adjustStackingParameters({
        baseImageDataUri: stackedImage,
        alignmentMethod,
        stackingMode,
      });
      setStackedImage(result.adjustedImageDataUri);
      toast({ title: "Adjustment Complete", description: "Parameters adjusted successfully." });
    } catch (error) {
      console.error("Adjustment error:", error);
      toast({
        title: "Adjustment Failed",
        description: "An error occurred while adjusting parameters. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };
  
  // Clean up preview URLs when component unmounts or files change
  useEffect(() => {
    return () => {
      uploadedFiles.forEach(uploadedFile => URL.revokeObjectURL(uploadedFile.previewUrl));
    };
  }, [uploadedFiles]);

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <AppHeader />
      <main className="flex-grow container mx-auto py-6 px-2 sm:px-4 md:px-6">
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Left Panel */}
          <div className="w-full lg:w-2/5 xl:w-1/3 space-y-6">
            <Card className="shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center text-xl font-headline">
                  <Layers className="mr-2 h-5 w-5 text-accent" />
                  Upload & Manage Images
                </CardTitle>
                <CardDescription>Add your astrophotography captures to begin stacking.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <ImageUploadArea onFilesAdded={handleFilesAdded} isProcessing={isProcessing} />
                {uploadedFiles.length > 0 && (
                  <>
                    <h3 className="text-lg font-semibold mt-4 text-foreground">Image Queue ({uploadedFiles.length})</h3>
                    <ScrollArea className="h-64 border rounded-md p-2 bg-background/30">
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {uploadedFiles.map((uploadedFile, index) => (
                          <ImageQueueItem
                            key={index}
                            file={uploadedFile.file}
                            previewUrl={uploadedFile.previewUrl}
                            onRemove={() => handleRemoveImage(index)}
                            isProcessing={isProcessing}
                          />
                        ))}
                      </div>
                    </ScrollArea>
                    <Button
                      onClick={handleStackImages}
                      disabled={isProcessing || uploadedFiles.length === 0}
                      className="w-full bg-accent hover:bg-accent/90 text-accent-foreground"
                    >
                      <Wand2 className="mr-2 h-5 w-5" />
                      {isProcessing ? 'Stacking...' : 'Stack Images'}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
            
            <ParameterControls
              alignmentMethod={alignmentMethod}
              setAlignmentMethod={setAlignmentMethod}
              stackingMode={stackingMode}
              setStackingMode={setStackingMode}
              onAdjust={handleAdjustParameters}
              isProcessing={isProcessing}
              hasBaseImage={!!stackedImage}
            />
          </div>

          {/* Right Panel */}
          <div className="w-full lg:w-3/5 xl:w-2/3 flex flex-col space-y-6">
            <ImagePreview imageUrl={stackedImage} isLoading={isProcessing && !stackedImage} /> {/* Show loading only if no image yet */}
            <DownloadButton imageUrl={stackedImage} isProcessing={isProcessing} />
          </div>
        </div>
      </main>
      <footer className="py-4 text-center text-sm text-muted-foreground border-t border-border">
        AstroStacker &copy; {new Date().getFullYear()} - Powered by Generative AI
      </footer>
    </div>
  );
}
