
"use client";

import type React from 'react';
import { useState, useEffect, useRef, useCallback }from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { fileToDataURL } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';
import { alignAndStack, detectStars, type Star, type StackingMode } from '@/lib/astro-align';
import { aiAlignAndStack } from '@/lib/ai-align';
import { learnStarPattern, findMatchingStars, type LearnedPattern } from '@/lib/ai-star-matcher';
import { AppHeader } from '@/components/astrostacker/AppHeader';
import { ImageUploadArea } from '@/components/astrostacker/ImageUploadArea';
import { ImageQueueItem } from '@/components/astrostacker/ImageQueueItem';
import { ImagePreview } from '@/components/astrostacker/ImagePreview';
import { ImagePostProcessEditor } from '@/components/astrostacker/ImagePostProcessEditor';
import { TutorialDialog } from '@/components/astrostacker/TutorialDialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Star as StarIcon, ListChecks, CheckCircle, RefreshCcw, Edit3, Loader2, Orbit, Trash2, Wand2, ShieldOff, Layers, Baseline, X, AlertTriangle, BrainCircuit, TestTube2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { StarAnnotationCanvas } from '@/components/astrostacker/StarAnnotationCanvas';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import NextImage from 'next/image';

interface ImageQueueEntry {
  id: string;
  file: File;
  previewUrl: string;
  isAnalyzing: boolean;
  isAnalyzed: boolean;
  analysisDimensions: { width: number; height: number };
  imageData: ImageData | null;
  detectedStars: Star[];
}

type PreviewFitMode = 'contain' | 'cover';
type OutputFormat = 'png' | 'jpeg';
type AlignmentMethod = 'standard' | 'ai';

const MIN_VALID_DATA_URL_LENGTH = 100;
const IS_LARGE_IMAGE_THRESHOLD_MP = 12;
const MAX_DIMENSION_DOWNSCALED = 2048;

export default function AstroStackerPage() {
  const { t } = useLanguage();
  const [allImageStarData, setAllImageStarData] = useState<ImageQueueEntry[]>([]);
  const [stackedImage, setStackedImage] = useState<string | null>(null);
  const [isProcessingStack, setIsProcessingStack] = useState(false);
  const [stackingMode, setStackingMode] = useState<StackingMode>('average');
  const [alignmentMethod, setAlignmentMethod] = useState<AlignmentMethod>('standard');
  const [previewFitMode, setPreviewFitMode] = useState<PreviewFitMode>('contain');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('png');
  const [jpegQuality, setJpegQuality] = useState<number>(92);
  const [progressPercent, setProgressPercent] = useState(0);
  const { toast } = useToast();
  const [logs, setLogs] = useState<{ id: number; timestamp: string; message: string; }[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const logIdCounter = useRef(0);
  const [isManualSelectMode, setIsManualSelectMode] = useState(false);
  const [manualSelectedStars, setManualSelectedStars] = useState<Star[]>([]);
  const [showPostProcessEditor, setShowPostProcessEditor] = useState(false);
  const [imageForPostProcessing, setImageForPostProcessing] = useState<string | null>(null);
  const [editedPreviewUrl, setEditedPreviewUrl] = useState<string | null>(null);
  const [brightness, setBrightness] = useState(100);
  const [exposure, setExposure] = useState(0);
  const [saturation, setSaturation] = useState(100);
  const [isApplyingAdjustments, setIsApplyingAdjustments] = useState(false);
  const [isTutorialOpen, setIsTutorialOpen] = useState(false);
  
  // --- AI Learning State ---
  const [learnedPatterns, setLearnedPatterns] = useState<LearnedPattern[]>([]);
  const [selectedPatternIDs, setSelectedPatternIDs] = useState<Set<string>>(new Set());
  const [testImage, setTestImage] = useState<ImageQueueEntry | null>(null);
  const [isAnalyzingTestImage, setIsAnalyzingTestImage] = useState(false);
  const [testImageMatchedStars, setTestImageMatchedStars] = useState<Star[]>([]);

  useEffect(() => {
    try {
      const storedPatterns = localStorage.getItem('astrostacker-learned-patterns');
      if (storedPatterns) {
        setLearnedPatterns(JSON.parse(storedPatterns));
      }
    } catch (e) {
      console.error("Failed to load learned patterns from localStorage", e);
      addLog("[ERROR] Failed to load learned patterns from localStorage.");
    }
  }, []);

  const saveLearnedPatterns = (patterns: LearnedPattern[]) => {
    try {
      localStorage.setItem('astrostacker-learned-patterns', JSON.stringify(patterns));
    } catch (e) {
      console.error("Failed to save learned patterns to localStorage", e);
      addLog("[ERROR] Failed to save learned patterns to localStorage.");
    }
  };


  const addLog = useCallback((message: string) => {
    setLogs(prevLogs => {
      const newLog = {
        id: logIdCounter.current++,
        timestamp: new Date().toLocaleTimeString(),
        message
      };
      return [newLog, ...prevLogs].slice(0, 150);
    });
  }, []);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = 0;
    }
  }, [logs]);

  const applyImageAdjustmentsToDataURL = async (
    baseDataUrl: string,
    brightness: number,
    exposure: number,
    saturation: number,
    outputFormat: 'png' | 'jpeg' = 'png',
    jpegQuality = 0.92
  ): Promise<string> => {
    if (!baseDataUrl) return baseDataUrl;
  
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error("Could not get canvas context for image adjustments."));
          return;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        const bFactor = brightness / 100;
        const eFactor = Math.pow(2, exposure / 100);
        for (let i = 0; i < data.length; i += 4) {
          let r = data[i], g = data[i+1], b = data[i+2];
          r = Math.min(255, Math.max(0, r * eFactor * bFactor));
          g = Math.min(255, Math.max(0, g * eFactor * bFactor));
          b = Math.min(255, Math.max(0, b * eFactor * bFactor));
  
          if (saturation !== 100) {
            const sFactor = saturation / 100;
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;
            r = Math.min(255, Math.max(0, gray + sFactor * (r - gray)));
            g = Math.min(255, Math.max(0, gray + sFactor * (g - gray)));
            b = Math.min(255, Math.max(0, gray + sFactor * (b - gray)));
          }
  
          data[i] = r; data[i + 1] = g; data[i + 2] = b;
        }
        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL(outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png', outputFormat === 'jpeg' ? jpegQuality : undefined));
      };
      img.onerror = (err) => reject(new Error("Failed to load image for adjustments."));
      img.src = baseDataUrl;
    });
  };

  useEffect(() => {
    if (!imageForPostProcessing || !showPostProcessEditor) return;
    const applyAdjustments = async () => {
      setIsApplyingAdjustments(true);
      try {
        const adjustedUrl = await applyImageAdjustmentsToDataURL(
          imageForPostProcessing, brightness, exposure, saturation, outputFormat, jpegQuality / 100
        );
        setEditedPreviewUrl(adjustedUrl);
      } catch (error) {
        toast({ title: "Adjustment Error", description: "Could not apply image adjustments.", variant: "destructive" });
        setEditedPreviewUrl(imageForPostProcessing);
      } finally {
        setIsApplyingAdjustments(false);
      }
    };
    const debounceTimeout = setTimeout(applyAdjustments, 300);
    return () => clearTimeout(debounceTimeout);
  }, [imageForPostProcessing, brightness, exposure, saturation, showPostProcessEditor, outputFormat, jpegQuality, toast]);

  const analyzeImageForStars = async (entryToAnalyze: ImageQueueEntry): Promise<ImageQueueEntry> => {
    setAllImageStarData(prevData =>
      prevData.map(e => e.id === entryToAnalyze.id ? { ...e, isAnalyzing: true, isAnalyzed: false } : e)
    );
  
    let finalUpdatedEntry: ImageQueueEntry = { ...entryToAnalyze, isAnalyzing: true, isAnalyzed: false };
  
    try {
      addLog(`[ANALYZE START] For: ${entryToAnalyze.file.name}`);
      const imgEl = new Image();
      imgEl.src = entryToAnalyze.previewUrl;
      await new Promise<void>((resolve, reject) => {
        imgEl.onload = () => resolve();
        imgEl.onerror = () => reject(new Error(`Failed to load image ${entryToAnalyze.file.name} for analysis.`));
      });
  
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error("Could not get canvas context for analysis.");
  
      canvas.width = entryToAnalyze.analysisDimensions.width;
      canvas.height = entryToAnalyze.analysisDimensions.height;
      ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
      
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // Use the standard star detection for all initial analyses
      const detectedStars = detectStars(imageData, canvas.width, canvas.height, 60);
      
      finalUpdatedEntry = { ...finalUpdatedEntry, imageData, detectedStars, isAnalyzed: true };
      addLog(`[ANALYZE SUCCESS] Found ${detectedStars.length} stars in ${entryToAnalyze.file.name}.`);
  
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLog(`[ANALYSIS ERROR] For ${entryToAnalyze.file.name}: ${errorMessage}`);
      toast({ title: `Analysis Failed for ${entryToAnalyze.file.name}`, description: errorMessage, variant: "destructive" });
      finalUpdatedEntry.isAnalyzed = false;
    } finally {
      finalUpdatedEntry.isAnalyzing = false;
      setAllImageStarData(prevData => prevData.map(e => (e.id === finalUpdatedEntry.id ? { ...finalUpdatedEntry } : e)));
    }
    return finalUpdatedEntry;
  };

  const handleFilesAdded = async (files: File[]) => {
    addLog(`Attempting to add ${files.length} file(s).`);
  
    const newEntriesPromises = files.map(async (file): Promise<ImageQueueEntry | null> => {
      try {
        const previewUrl = await fileToDataURL(file);
        const img = new Image();
        const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
          img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => reject(new Error("Could not load image to get dimensions."));
          img.src = previewUrl;
        });

        let analysisDimensions = { ...dimensions };
        let finalPreviewUrl = previewUrl;

        if ((dimensions.width * dimensions.height) / 1_000_000 > IS_LARGE_IMAGE_THRESHOLD_MP) {
          if (window.confirm(t('downscalePrompt', { fileName: file.name, width: dimensions.width, height: dimensions.height, maxSize: MAX_DIMENSION_DOWNSCALED }))) {
              const canvas = document.createElement('canvas');
              const ctx = canvas.getContext('2d');
              if (ctx) {
                  let targetWidth = dimensions.width, targetHeight = dimensions.height;
                  if (dimensions.width > MAX_DIMENSION_DOWNSCALED || dimensions.height > MAX_DIMENSION_DOWNSCALED) {
                      if (dimensions.width > dimensions.height) {
                          targetWidth = MAX_DIMENSION_DOWNSCALED;
                          targetHeight = Math.round((dimensions.height / dimensions.width) * MAX_DIMENSION_DOWNSCALED);
                      } else {
                          targetHeight = MAX_DIMENSION_DOWNSCALED;
                          targetWidth = Math.round((dimensions.width / dimensions.height) * MAX_DIMENSION_DOWNSCALED);
                      }
                  }
                  canvas.width = targetWidth;
                  canvas.height = targetHeight;
                  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
                  finalPreviewUrl = canvas.toDataURL('image/png');
                  analysisDimensions = { width: targetWidth, height: targetHeight };
                  addLog(`Downscaled ${file.name} to ${targetWidth}x${targetHeight}.`);
              }
          }
        }
  
        return {
          id: `${file.name}-${Date.now()}`, file, previewUrl: finalPreviewUrl, isAnalyzing: false, isAnalyzed: false,
          analysisDimensions, imageData: null, detectedStars: [],
        };
      } catch (error) {
        addLog(`[ERROR] Could not process ${file.name}: ${error instanceof Error ? error.message : "Unknown error"}`);
        return null;
      }
    });
  
    const newEntriesResults = await Promise.all(newEntriesPromises);
    const validNewEntries = newEntriesResults.filter((entry): entry is ImageQueueEntry => entry !== null);
    
    if (validNewEntries.length > 0) {
      setAllImageStarData(prev => [...prev, ...validNewEntries]);
      addLog(`Added ${validNewEntries.length} new files to queue. Starting analysis...`);
      for (const entry of validNewEntries) {
        analyzeImageForStars(entry);
      }
    }
  };
  
  const handleRemoveImage = (idToRemove: string) => {
    setAllImageStarData(prev => prev.filter(item => item.id !== idToRemove));
  };
  
  const handleManualSelectToggle = (imageIndex: number) => {
    if (imageIndex !== 0) {
      toast({ title: "Selection Not Allowed", description: "Manual star selection is only available for the first image, which acts as the reference.", variant: "default"});
      return;
    }
    const refImage = allImageStarData[0];
    if (!refImage || !refImage.isAnalyzed) {
      toast({ title: "Not Ready", description: "Reference image has not been analyzed yet. Please wait.", variant: "default" });
      return;
    }
    setManualSelectedStars([]);
    setIsManualSelectMode(!isManualSelectMode);
  };
  
  const handleStarAnnotationClick = (x: number, y: number) => {
    if (!isManualSelectMode) return;
    const refImage = allImageStarData[0];
    if (!refImage || !refImage.isAnalyzed) return;
    const manualSelectRadius = 10;
    const existingStarIndex = manualSelectedStars.findIndex(star => Math.sqrt(Math.pow(star.x - x, 2) + Math.pow(star.y - y, 2)) < manualSelectRadius);
  
    if (existingStarIndex !== -1) {
      setManualSelectedStars(prev => prev.filter((_, index) => index !== existingStarIndex));
      return;
    }
  
    let closestStar: Star | null = null;
    let closestDist = manualSelectRadius;
  
    for (const star of refImage.detectedStars) {
      const dist = Math.sqrt(Math.pow(star.x - x, 2) + Math.pow(star.y - y, 2));
      if (dist < closestDist) {
        closestStar = star;
        closestDist = dist;
      }
    }
  
    if (closestStar && !manualSelectedStars.some(s => s.x === closestStar!.x && s.y === closestStar!.y)) {
      setManualSelectedStars(prev => [...prev, closestStar!]);
    }
  };

  const handleConfirmManualSelection = async () => {
    const refImage = allImageStarData[0];
    if (!refImage || !refImage.imageData || manualSelectedStars.length < 2) {
      toast({ title: "Not Enough Stars", description: "Please select at least 2 stars to define a pattern.", variant: "destructive" });
      return;
    }
    
    const newPattern = await learnStarPattern(refImage.id, manualSelectedStars, refImage.imageData);
    setLearnedPatterns(prev => {
      const existingIndex = prev.findIndex(p => p.id === newPattern.id);
      let updatedPatterns;
      if (existingIndex !== -1) {
        updatedPatterns = [...prev];
        updatedPatterns[existingIndex] = newPattern;
        toast({ title: t('starPatternOverwrittenToastTitle'), description: t('starPatternOverwrittenToastDesc', {fileName: refImage.file.name, starCount: newPattern.characteristics.length}) });
      } else {
        updatedPatterns = [...prev, newPattern];
        toast({ title: t('starPatternFirstLearnedToastTitle'), description: t('starPatternFirstLearnedToastDesc', {fileName: refImage.file.name, starCount: newPattern.characteristics.length})});
      }
      saveLearnedPatterns(updatedPatterns);
      return updatedPatterns;
    });

    setIsManualSelectMode(false);
  };

  const handleStackAllImages = async () => {
    if (allImageStarData.length < 2) {
      toast({ title: "Not Enough Images", description: "Please upload at least two images." });
      return;
    }
    if (allImageStarData.some(img => img.isAnalyzing)) {
      toast({ title: "Analysis in Progress", description: "Please wait for all images to be analyzed before stacking." });
      return;
    }
  
    setIsProcessingStack(true);
    setProgressPercent(0);
    setStackedImage(null);
    setShowPostProcessEditor(false);
    addLog(`[STACK START] Method: ${alignmentMethod}. Stacking ${allImageStarData.length} images. Mode: ${stackingMode}.`);
  
    try {
      const imageDatas = allImageStarData.map(entry => entry.imageData).filter((d): d is ImageData => d !== null);
      if (imageDatas.length !== allImageStarData.length) throw new Error("Some images have not been analyzed or loaded correctly.");
      
      const { width, height } = allImageStarData[0].analysisDimensions;
      
      let stackedImageData;

      if (alignmentMethod === 'ai') {
        const activePatterns = learnedPatterns.filter(p => selectedPatternIDs.has(p.id));
        if (activePatterns.length === 0) {
          throw new Error("AI Alignment method selected, but no learned patterns are checked for use. Please select patterns from the Learning Mode section.");
        }
        addLog(`Using ${activePatterns.length} learned patterns for AI alignment.`);
        stackedImageData = await aiAlignAndStack(allImageStarData, activePatterns, stackingMode, (m) => addLog(`[AI ALIGN] ${m}`), (p) => setProgressPercent(p * 100));
      } else {
        // Standard Alignment
        const refStarsForStandard = (manualSelectedStars.length > 1 ? manualSelectedStars : allImageStarData[0].detectedStars);
        if (refStarsForStandard.length < 2) {
          throw new Error("Standard alignment requires at least 2 stars in the reference image. Please use Manual Select or ensure auto-detection finds stars.");
        }
        stackedImageData = await alignAndStack(allImageStarData, refStarsForStandard, stackingMode, (m) => addLog(`[ALIGN] ${m}`), (p) => setProgressPercent(p * 100));
      }
  
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error("Could not create canvas context to display result.");
      ctx.putImageData(new ImageData(stackedImageData, width, height), 0, 0);
  
      const resultDataUrl = canvas.toDataURL(outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png', jpegQuality / 100);
      if (!resultDataUrl || resultDataUrl.length < MIN_VALID_DATA_URL_LENGTH) throw new Error("Failed to generate a valid preview URL for the stacked image.");
  
      setStackedImage(resultDataUrl);
      setImageForPostProcessing(resultDataUrl);
      setEditedPreviewUrl(resultDataUrl);
      setBrightness(100); setExposure(0); setSaturation(100);
      setShowPostProcessEditor(true);
      toast({ title: "Stacking Complete", description: `Successfully stacked ${allImageStarData.length} images.`, duration: 8000 });
  
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLog(`[STACK FATAL ERROR] ${errorMessage}`);
      toast({ title: "Stacking Failed", description: errorMessage, variant: "destructive" });
    } finally {
      setIsProcessingStack(false);
      setProgressPercent(0);
      addLog("[STACK END] Stacking process finished.");
    }
  };

  const handleOpenPostProcessEditor = () => {
    if (stackedImage) {
      setImageForPostProcessing(stackedImage); setEditedPreviewUrl(stackedImage); 
      setBrightness(100); setExposure(0); setSaturation(100); setShowPostProcessEditor(true);
    }
  };

  const handleResetAdjustments = () => {
    setBrightness(100); setExposure(0); setSaturation(100);
    if (imageForPostProcessing) setEditedPreviewUrl(imageForPostProcessing);
  };
  
  const handleTestFileAdded = async (files: File[]) => {
    if (files.length === 0) return;
    const file = files[0];
    addLog(`Loading test image: ${file.name}`);
    setTestImage(null);
    setTestImageMatchedStars([]);
    const entry = await (async (): Promise<ImageQueueEntry | null> => {
        try {
            const previewUrl = await fileToDataURL(file);
            const img = new Image();
            const dimensions = await new Promise<{width: number; height: number}>(r => {img.onload = () => r({width: img.naturalWidth, height: img.naturalHeight}); img.src = previewUrl;});
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d', {willReadFrequently: true});
            if (!ctx) return null;
            canvas.width = dimensions.width;
            canvas.height = dimensions.height;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const detectedStars = detectStars(imageData, canvas.width, canvas.height, 60);
            return { id: `test-${file.name}-${Date.now()}`, file, previewUrl, isAnalyzing: false, isAnalyzed: true, analysisDimensions: dimensions, imageData, detectedStars };
        } catch (e) {
            return null;
        }
    })();
    if(entry) {
        setTestImage(entry);
        addLog(`Test image ${file.name} loaded and analyzed, found ${entry.detectedStars.length} potential stars.`);
    } else {
        addLog(`[ERROR] Failed to load test image ${file.name}.`);
    }
  };

  const runPatternTest = async () => {
    if (!testImage || !testImage.imageData) {
        toast({title: t('noTestImageToastTitle'), description: t('noTestImageToastDesc'), variant: 'destructive'});
        return;
    }
    const activePatterns = learnedPatterns.filter(p => selectedPatternIDs.has(p.id));
    if (activePatterns.length !== 1) {
        toast({title: t('noActivePatternForTestToastTitle'), description: t('noActivePatternForTestToastDesc'), variant: 'destructive'});
        return;
    }
    setIsAnalyzingTestImage(true);
    addLog(`Running pattern test on ${testImage.file.name} with pattern from ${activePatterns[0].id}`);
    
    // Use a timeout to avoid freezing the UI thread for a moment
    setTimeout(async () => {
        const matched = await findMatchingStars(testImage.detectedStars, testImage.imageData!, activePatterns);
        setTestImageMatchedStars(matched);
        setIsAnalyzingTestImage(false);
        addLog(`Test complete. Found ${matched.length} matching stars.`);
        toast({title: t('testAnalysisCompleteToastTitle'), description: t('testAnalysisCompleteToastDesc', {count: matched.length, fileName: testImage.file.name})});
    }, 100);
  };
  
  const handlePatternSelectionChange = (patternId: string, isSelected: boolean) => {
    setSelectedPatternIDs(prev => {
        const newSet = new Set(prev);
        if (isSelected) newSet.add(patternId);
        else newSet.delete(patternId);
        return newSet;
    });
  };

  const deletePattern = (patternId: string) => {
    if (window.confirm(`Are you sure you want to delete the pattern learned from "${patternId}"? This cannot be undone.`)) {
      setLearnedPatterns(prev => {
        const updated = prev.filter(p => p.id !== patternId);
        saveLearnedPatterns(updated);
        return updated;
      });
      setSelectedPatternIDs(prev => {
        const newSet = new Set(prev);
        newSet.delete(patternId);
        return newSet;
      });
      toast({title: t('patternDeletedToastTitle'), description: t('patternDeletedToastDesc', {fileName: patternId})});
    }
  };


  const canStartStacking = allImageStarData.length >= 2 && allImageStarData.every(img => img.isAnalyzed);
  const refImage = allImageStarData.length > 0 ? allImageStarData[0] : null;
  const isUiDisabled = isProcessingStack || allImageStarData.some(img => img.isAnalyzing);
  const currentYear = new Date().getFullYear();

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <AppHeader onTutorialClick={() => setIsTutorialOpen(true)} />
      <main className="flex-grow container mx-auto py-6 px-2 sm:px-4 md:px-6">
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="w-full lg:w-2/5 xl:w-1/3 space-y-6">
            <Card className="shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center text-xl font-headline"><StarIcon className="mr-2 h-5 w-5 text-accent" />{t('uploadAndConfigure')}</CardTitle>
                <CardDescription className="text-sm max-h-32 overflow-y-auto">{t('cardDescription')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <ImageUploadArea onFilesAdded={handleFilesAdded} isProcessing={isUiDisabled} multiple={true} />
                {isProcessingStack && progressPercent > 0 && (
                  <div className="space-y-2 my-4">
                    <Progress value={progressPercent} className="w-full h-3" />
                    <p className="text-sm text-center text-muted-foreground">{t('stackingProgress', {progressPercent: Math.round(progressPercent)})}</p>
                  </div>
                )}
                {allImageStarData.length > 0 && (
                  <>
                    <h3 className="text-lg font-semibold mt-4 text-foreground">{t('imageQueueCount', {count: allImageStarData.length})}</h3>
                    <ScrollArea className="h-60 border rounded-md p-2 bg-background/30">
                      <div className="grid grid-cols-1 gap-3">
                        {allImageStarData.map((entry, index) => (
                          <ImageQueueItem
                            key={entry.id} id={entry.id} index={index} file={entry.file} previewUrl={entry.previewUrl}
                            isAnalyzing={entry.isAnalyzing} onRemove={() => handleRemoveImage(entry.id)}
                            onManualSelectToggle={() => handleManualSelectToggle(index)} isProcessing={isUiDisabled}
                            isAnalyzed={entry.isAnalyzed} isManualSelectMode={isManualSelectMode}
                          />
                        ))}
                      </div>
                    </ScrollArea>
                  </>
                )}
                {isManualSelectMode && refImage && (
                  <Card className="mt-2 bg-muted/20">
                    <CardHeader className="p-3"><CardTitle className="text-base">Manual Star Selection</CardTitle>
                      <CardDescription className="text-xs">Now editing reference: {refImage.file.name}. Selected {manualSelectedStars.length} stars.</CardDescription>
                    </CardHeader>
                    <CardFooter className="p-3 flex flex-col gap-2">
                      <Button onClick={handleConfirmManualSelection} className="w-full" variant="secondary"><CheckCircle className="mr-2 h-4 w-4" />Confirm & Learn Pattern</Button>
                      <Button onClick={() => setIsManualSelectMode(false)} className="w-full"><X className="mr-2 h-4 w-4" />Cancel</Button>
                    </CardFooter>
                  </Card>
                )}
                {logs.length > 0 && (
                  <Card className="mt-4">
                    <CardHeader className="p-3 border-b"><CardTitle className="text-base flex items-center"><ListChecks className="mr-2 h-4 w-4" />{t('processingLogs')}</CardTitle></CardHeader>
                    <CardContent className="p-0">
                      <ScrollArea ref={logContainerRef} className="h-48 p-3 text-xs bg-muted/20 rounded-b-md">
                        {logs.map((log) => (
                          <div key={log.id} className="mb-1 font-mono">
                            <span className="text-muted-foreground mr-2">{log.timestamp}</span>
                            <span className={ log.message.toLowerCase().includes('error') || log.message.toLowerCase().includes('failed') ? 'text-destructive' : log.message.toLowerCase().includes('warn') ? 'text-yellow-500' : log.message.startsWith('[ALIGN]') ? 'text-sky-400' : 'text-foreground/80'}>{log.message}</span>
                          </div>
                        ))}
                      </ScrollArea>
                    </CardContent>
                  </Card>
                )}
                 <div className="space-y-4 pt-4">
                    <div className="space-y-2"><Label className="text-base font-semibold text-foreground">Alignment Method</Label>
                      <RadioGroup value={alignmentMethod} onValueChange={(v) => setAlignmentMethod(v as AlignmentMethod)} className="flex space-x-2" disabled={isUiDisabled}>
                        <div className="flex items-center space-x-1"><RadioGroupItem value="standard" id="align-standard" /><Label htmlFor="align-standard">Standard (2-Star)</Label></div>
                        <div className="flex items-center space-x-1"><RadioGroupItem value="ai" id="align-ai" /><Label htmlFor="align-ai">AI Pattern</Label></div>
                      </RadioGroup>
                    </div>
                    <div className="space-y-2"><Label className="text-base font-semibold text-foreground">{t('stackingMode')}</Label>
                      <RadioGroup value={stackingMode} onValueChange={(v) => setStackingMode(v as StackingMode)} className="flex space-x-2" disabled={isUiDisabled}>
                        <div className="flex items-center space-x-1"><RadioGroupItem value="average" id="mode-average" /><Label htmlFor="mode-average">Average</Label></div>
                        <div className="flex items-center space-x-1"><RadioGroupItem value="median" id="mode-median" /><Label htmlFor="mode-median">Median</Label></div>
                        <div className="flex items-center space-x-1"><RadioGroupItem value="sigma" id="mode-sigma" /><Label htmlFor="mode-sigma">Sigma Clip</Label></div>
                      </RadioGroup>
                    </div>
                    <div className="space-y-2"><Label className="text-base font-semibold text-foreground">{t('previewFit')}</Label>
                      <RadioGroup value={previewFitMode} onValueChange={(v) => setPreviewFitMode(v as PreviewFitMode)} className="flex space-x-4" disabled={isUiDisabled}>
                        <div className="flex items-center space-x-2"><RadioGroupItem value="contain" id="fit-contain" /><Label htmlFor="fit-contain">Contain</Label></div>
                        <div className="flex items-center space-x-2"><RadioGroupItem value="cover" id="fit-cover" /><Label htmlFor="fit-cover">Cover</Label></div>
                      </RadioGroup>
                    </div>
                    <div className="space-y-2"><Label className="text-base font-semibold text-foreground">{t('outputFormat')}</Label>
                      <RadioGroup value={outputFormat} onValueChange={(v) => setOutputFormat(v as OutputFormat)} className="flex space-x-4" disabled={isUiDisabled}>
                        <div className="flex items-center space-x-2"><RadioGroupItem value="png" id="format-png" /><Label htmlFor="format-png">PNG</Label></div>
                        <div className="flex items-center space-x-2"><RadioGroupItem value="jpeg" id="format-jpeg" /><Label htmlFor="format-jpeg">JPG</Label></div>
                      </RadioGroup>
                    </div>
                    {outputFormat === 'jpeg' && (<div className="space-y-2"><Label htmlFor="jpegQualitySlider">{t('jpgQuality', {jpegQuality})}</Label><Slider id="jpegQualitySlider" min={10} max={100} step={1} value={[jpegQuality]} onValueChange={(v) => setJpegQuality(v[0])} disabled={isUiDisabled} /></div>)}
                    <Button onClick={handleStackAllImages} disabled={!canStartStacking || isUiDisabled} className="w-full bg-accent hover:bg-accent/90 text-accent-foreground mt-4">
                      {isProcessingStack ? <><Loader2 className="mr-2 h-5 w-5 animate-spin" />{t('stackingButtonInProgress')}</> : <><CheckCircle className="mr-2 h-5 w-5" />{t('stackImagesButton', { count: allImageStarData.length })}</>}
                    </Button>
                  </div>
              </CardContent>
            </Card>
          </div>
          <div className="w-full lg:w-3/5 xl:w-2/3 flex flex-col space-y-6">
            <div className="flex-grow">
              {isManualSelectMode && refImage ? (
                  <StarAnnotationCanvas imageUrl={refImage.previewUrl} allStars={refImage.detectedStars} manualStars={manualSelectedStars} onCanvasClick={handleStarAnnotationClick} analysisWidth={refImage.analysisDimensions.width} analysisHeight={refImage.analysisDimensions.height} />
              ) : testImage ? (
                  <StarAnnotationCanvas imageUrl={testImage.previewUrl} allStars={testImage.detectedStars} manualStars={testImageMatchedStars} onCanvasClick={()=>{}} analysisWidth={testImage.analysisDimensions.width} analysisHeight={testImage.analysisDimensions.height} />
              ) : (
                  <ImagePreview imageUrl={showPostProcessEditor ? editedPreviewUrl : stackedImage} fitMode={previewFitMode} />
              )}
            </div>
            {stackedImage && !showPostProcessEditor && (<Button onClick={handleOpenPostProcessEditor} className="w-full bg-purple-600 hover:bg-purple-700 text-white" size="lg" disabled={isProcessingStack}><Wand2 className="mr-2 h-5 w-5" />{t('finalizeAndDownload')}</Button>)}
            
            <Card>
                <CardHeader><CardTitle className="flex items-center"><BrainCircuit className="mr-2 h-5 w-5" />{t('learningModeCardTitle')}</CardTitle><CardDescription>{t('learningModeCardDescription')}</CardDescription></CardHeader>
                <CardContent>
                    <h4 className="font-semibold mb-2">{t('allLearnedPatternsListTitle')}</h4>
                    {learnedPatterns.length === 0 ? (<p className="text-sm text-muted-foreground">{t('noPatternLearnedYetInfo')}</p>) : (
                        <ScrollArea className="h-40 border rounded-md p-2">
                            {learnedPatterns.map(p => (
                                <div key={p.id} className="flex items-center justify-between p-2 rounded-md hover:bg-muted/50">
                                    <div className="flex items-center gap-2">
                                        <Checkbox id={`pattern-${p.id}`} checked={selectedPatternIDs.has(p.id)} onCheckedChange={(checked) => handlePatternSelectionChange(p.id, !!checked)} />
                                        <div>
                                            <label htmlFor={`pattern-${p.id}`} className="font-medium text-sm cursor-pointer">{p.id}</label>
                                            <p className="text-xs text-muted-foreground"> {p.characteristics.length} stars learned on {new Date(p.timestamp).toLocaleDateString()}</p>
                                        </div>
                                    </div>
                                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deletePattern(p.id)}><Trash2 className="h-4 w-4 text-destructive"/></Button>
                                </div>
                            ))}
                        </ScrollArea>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader><CardTitle className="flex items-center"><TestTube2 className="mr-2 h-5 w-5" />{t('learnTestCardTitle')}</CardTitle><CardDescription>{t('learnTestCardDescription')}</CardDescription></CardHeader>
                <CardContent className="space-y-4">
                    <ImageUploadArea onFilesAdded={handleTestFileAdded} isProcessing={isAnalyzingTestImage} multiple={false} />
                    <Button onClick={runPatternTest} disabled={isAnalyzingTestImage || !testImage} className="w-full">
                        {isAnalyzingTestImage ? <><Loader2 className="mr-2 h-4 w-4 animate-spin"/>{t('analyzingTestImageProgress')}</> : <>{t('runPatternTestButton')}</>}
                    </Button>
                    {testImage && <p className="text-sm text-center text-muted-foreground">{t('recognizedStarsCount', {count: testImageMatchedStars.length})}</p>}
                </CardContent>
            </Card>

          </div>
        </div>
      </main>
      <footer className="py-6 text-center text-sm text-muted-foreground border-t border-border">
        <div>{t('creditsLine1', {year: currentYear})}</div>
        <div className="mt-2 px-4">{t('creditsLine2Part1')}</div>
      </footer>
      <TutorialDialog isOpen={isTutorialOpen} onClose={() => setIsTutorialOpen(false)} />
      {showPostProcessEditor && imageForPostProcessing && (
        <ImagePostProcessEditor isOpen={showPostProcessEditor} onClose={() => setShowPostProcessEditor(false)} baseImageUrl={imageForPostProcessing} editedImageUrl={editedPreviewUrl}
          brightness={brightness} setBrightness={setBrightness} exposure={exposure} setExposure={setExposure}
          saturation={saturation} setSaturation={setSaturation} onResetAdjustments={handleResetAdjustments}
          isAdjusting={isApplyingAdjustments} outputFormat={outputFormat} jpegQuality={jpegQuality}
        />
      )}
    </div>
  );
}
