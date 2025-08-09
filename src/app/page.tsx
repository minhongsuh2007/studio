
"use client";

import type React from 'react';
import { useState, useEffect, useRef, useCallback }from 'react';
import * as tf from '@tensorflow/tfjs';
import { Button } from '@/components/ui/button';
import { fileToDataURL } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';
import { alignAndStack, detectStars, type Star, type StackingMode } from '@/lib/astro-align';
import { aiClientAlignAndStack } from '@/lib/ai-client-stack';
import { extractCharacteristicsFromImage, findMatchingStars, type LearnedPattern, type SimpleImageData, type StarCharacteristics, predictSingle, buildModel } from '@/lib/ai-star-matcher';
import type { ModelWeightData } from '@/lib/genkit-types';
import { AppHeader } from '@/components/astrostacker/AppHeader';
import { ImageUploadArea } from '@/components/astrostacker/ImageUploadArea';
import { ImageQueueItem } from '@/components/astrostacker/ImageQueueItem';
import { ImagePreview } from '@/components/astrostacker/ImagePreview';
import { ImagePostProcessEditor } from '@/components/astrostacker/ImagePostProcessEditor';
import { TutorialDialog } from '@/components/astrostacker/TutorialDialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Star as StarIcon, ListChecks, CheckCircle, RefreshCcw, Edit3, Loader2, Orbit, Trash2, Wand2, ShieldOff, Layers, Baseline, X, AlertTriangle, BrainCircuit, TestTube2, Eraser, Download, Upload, Cpu, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { StarAnnotationCanvas } from '@/components/astrostacker/StarAnnotationCanvas';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
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
  const [isTrainingModel, setIsTrainingModel] = useState(false);
  const [stackingMode, setStackingMode] = useState<StackingMode>('average');
  const [alignmentMethod, setAlignmentMethod] = useState<AlignmentMethod>('standard');
  const [previewFitMode, setPreviewFitMode] = useState<PreviewFitMode>('contain');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('png');
  const [jpegQuality, setJpegQuality] = useState<number>(92);
  const [progressPercent, setProgressPercent] = useState(0);
  const [logs, setLogs] = useState<{ id: number; timestamp: string; message: string; }[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const logIdCounter = useRef(0);
  
  const [manualSelectImageId, setManualSelectImageId] = useState<string | null>(null);
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
  const [canvasStars, setCanvasStars] = useState<Star[]>([]);

  // --- TFJS Model State ---
  const [trainedModel, setTrainedModel] = useState<tf.LayersModel | null>(null);
  const [modelNormalization, setModelNormalization] = useState<{ means: number[], stds: number[] } | null>(null);


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
        console.error("Adjustment Error", "Could not apply image adjustments.");
        setEditedPreviewUrl(imageForPostProcessing);
      } finally {
        setIsApplyingAdjustments(false);
      }
    };
    const debounceTimeout = setTimeout(applyAdjustments, 300);
    return () => clearTimeout(debounceTimeout);
  }, [imageForPostProcessing, brightness, exposure, saturation, showPostProcessEditor, outputFormat, jpegQuality]);

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
      const detectedStars = detectStars(imageData, canvas.width, canvas.height, 60);
      
      finalUpdatedEntry = { ...finalUpdatedEntry, imageData, detectedStars, isAnalyzed: true };
      addLog(`[ANALYZE SUCCESS] Found ${detectedStars.length} stars in ${entryToAnalyze.file.name}.`);
  
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLog(`[ANALYSIS ERROR] For ${entryToAnalyze.file.name}: ${errorMessage}`);
      window.alert(`Analysis Failed for ${entryToAnalyze.file.name}: ${errorMessage}`);
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
    if (manualSelectImageId === idToRemove) {
      setManualSelectImageId(null);
    }
  };
  
  const handleManualSelectToggle = (imageId: string) => {
    const imageToSelect = allImageStarData.find(img => img.id === imageId);
    if (!imageToSelect) return;

    if (!imageToSelect.isAnalyzed) {
        window.alert("Image has not been analyzed yet. Please wait.");
        return;
    }

    if (manualSelectImageId === imageId) {
      setManualSelectImageId(null);
      setManualSelectedStars([]);
      setCanvasStars([]);
      return;
    }
    
    setManualSelectImageId(imageId);
    // Initialize manual selection with auto-detected stars for this image.
    setManualSelectedStars(imageToSelect.detectedStars);
    setCanvasStars(imageToSelect.detectedStars);
  };

  const findNearbyStarCenter = (
    imageData: ImageData,
    clickX: number,
    clickY: number,
    searchRadius: number = 20
  ): Star | null => {
      const { data, width, height } = imageData;
      const getBrightness = (idx: number) => 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  
      // 1. Find the brightest point within the search radius
      const startX = Math.max(0, Math.round(clickX - searchRadius));
      const endX = Math.min(width, Math.round(clickX + searchRadius));
      const startY = Math.max(0, Math.round(clickY - searchRadius));
      const endY = Math.min(height, Math.round(clickY + searchRadius));
  
      let maxBrightness = -1;
      let peakX = -1, peakY = -1;
  
      for (let y = startY; y < endY; y++) {
          for (let x = startX; x < endX; x++) {
              const distSq = (x - clickX)**2 + (y - clickY)**2;
              if (distSq <= searchRadius**2) {
                  const idx = (y * width + x) * 4;
                  const brightness = getBrightness(idx);
                  if (brightness > maxBrightness) {
                      maxBrightness = brightness;
                      peakX = x;
                      peakY = y;
                  }
              }
          }
      }
  
      if (peakX === -1) return null; // No point found
  
      // 2. Perform a flood fill (BFS) from the peak to find the whole star blob
      const threshold = maxBrightness * 0.5; // Pixels must be at least 50% of peak brightness
      const queue: [number, number][] = [[peakX, peakY]];
      const visited = new Set<string>();
      const blobPixels: {x: number, y: number, brightness: number}[] = [];
      visited.add(`${peakX},${peakY}`);
  
      while(queue.length > 0) {
          const [cx, cy] = queue.shift()!;
          const cIdx = (cy * width + cx) * 4;
          const cBrightness = getBrightness(cIdx);
  
          if (cBrightness < threshold) continue;
  
          blobPixels.push({ x: cx, y: cy, brightness: cBrightness });
  
          // Check neighbors
          for(let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                  if (dx === 0 && dy === 0) continue;
                  const nx = cx + dx;
                  const ny = cy + dy;
                  const nKey = `${nx},${ny}`;
                  if (nx >= 0 && nx < width && ny >= 0 && ny < height && !visited.has(nKey)) {
                      visited.add(nKey);
                      // Add to queue if brightness is above a slightly more lenient threshold, to ensure we get the whole blob
                      const nIdx = (ny * width + nx) * 4;
                      if(getBrightness(nIdx) > threshold * 0.8) {
                          queue.push([nx, ny]);
                      }
                  }
              }
          }
      }
  
      // 3. Calculate the center of mass of the blob
      if (blobPixels.length === 0) return null;
  
      let weightedX = 0;
      let weightedY = 0;
      let totalBrightness = 0;
      
      for (const p of blobPixels) {
          weightedX += p.x * p.brightness;
          weightedY += p.y * p.brightness;
          totalBrightness += p.brightness;
      }
  
      if (totalBrightness > 0) {
          return {
              x: weightedX / totalBrightness,
              y: weightedY / totalBrightness,
              brightness: totalBrightness,
              size: blobPixels.length,
          };
      }
  
      return null;
  };
  
  const handleStarAnnotationClick = (x: number, y: number) => {
    if (!manualSelectImageId) return;
    const manualSelectRadius = 15;
    
    const imageEntry = allImageStarData.find(img => img.id === manualSelectImageId);
    if (!imageEntry || !imageEntry.imageData) return;

    // Check if clicking on an existing star to remove it
    const existingStarIndex = manualSelectedStars.findIndex(star => Math.sqrt(Math.pow(star.x - x, 2) + Math.pow(star.y - y, 2)) < manualSelectRadius);
  
    if (existingStarIndex !== -1) {
      setManualSelectedStars(prev => prev.filter((_, index) => index !== existingStarIndex));
    } else {
      // Find the precise center of the clicked star
      const centeredStar = findNearbyStarCenter(imageEntry.imageData, x, y);
      if (centeredStar) {
        setManualSelectedStars(prev => [...prev, centeredStar]);
      } else {
        // Fallback to adding at the exact click position if no bright spot is found
        setManualSelectedStars(prev => [...prev, { x, y, brightness: 0, size: 0 }]);
      }
    }
  };

  const handleWipeAllStars = () => {
    const imageToUpdate = allImageStarData.find(img => img.id === manualSelectImageId);
    if (imageToUpdate) {
        setManualSelectedStars([]); // Clear only manual selections
        setCanvasStars(imageToUpdate.detectedStars); // Keep the auto-detected stars for visual reference
        addLog("Manual star selections for this image have been cleared.");
    }
  };

  const handleConfirmManualSelection = async () => {
    if (manualSelectedStars.length < 2) {
      window.alert("Please select at least 2 stars to define a pattern.");
      return;
    }

    const imageToLearnFrom = allImageStarData.find(img => img.id === manualSelectImageId);
    if (!imageToLearnFrom || !imageToLearnFrom.imageData) return;
    
    const patternId = 'aggregated-user-pattern';
    
    const { data, width, height } = imageToLearnFrom.imageData;
    const newCharacteristics = await extractCharacteristicsFromImage({
      stars: manualSelectedStars,
      imageData: { data: Array.from(data), width, height }
    });
    
    setLearnedPatterns(prev => {
      const existingPatternIndex = prev.findIndex(p => p.id === patternId);
      let updatedPatterns;

      if (existingPatternIndex !== -1) {
        // Update existing aggregated pattern
        const existingPattern = prev[existingPatternIndex];
        const updatedCharacteristics = [...existingPattern.characteristics, ...newCharacteristics];
        const updatedSourceIds = new Set([...existingPattern.sourceImageIds, imageToLearnFrom.id]);

        const newPattern: LearnedPattern = {
          id: patternId,
          timestamp: Date.now(),
          sourceImageIds: Array.from(updatedSourceIds),
          characteristics: updatedCharacteristics,
        };
        updatedPatterns = [...prev];
        updatedPatterns[existingPatternIndex] = newPattern;
        addLog(`Star Pattern Updated: ${newCharacteristics.length} new star characteristics from ${imageToLearnFrom.file.name} added to your aggregated pattern.`);

      } else {
        // Create new aggregated pattern
        const newPattern: LearnedPattern = {
          id: patternId,
          timestamp: Date.now(),
          sourceImageIds: [imageToLearnFrom.id],
          characteristics: newCharacteristics,
        };
        updatedPatterns = [...prev, newPattern];
        addLog(`Star Pattern Learned: A new aggregated pattern has been created with ${newCharacteristics.length} stars from ${imageToLearnFrom.file.name}.`);
      }

      saveLearnedPatterns(updatedPatterns);
      
      setSelectedPatternIDs(prevSelected => {
          const newSet = new Set(prevSelected);
          newSet.add(patternId);
          return newSet;
      });

      return updatedPatterns;
    });

    setManualSelectImageId(null);
    setManualSelectedStars([]);
    setCanvasStars([]);
  };


  const handleStackAllImages = async () => {
    if (allImageStarData.length < 2) {
      window.alert("Please upload at least two images.");
      return;
    }
    if (allImageStarData.some(img => img.isAnalyzing)) {
      window.alert("Please wait for all images to be analyzed before stacking.");
      return;
    }
    if (alignmentMethod === 'ai' && !trainedModel) {
        window.alert("AI Alignment is selected, but the model hasn't been trained. Please add star patterns and click 'Train AI Model'.");
        return;
    }
  
    setIsProcessingStack(true);
    setProgressPercent(0);
    setStackedImage(null);
    setShowPostProcessEditor(false);
    addLog(`[STACK START] Method: ${alignmentMethod}. Stacking ${allImageStarData.length} images. Mode: ${stackingMode}.`);
  
    try {
      let stackedImageData;
      if (alignmentMethod === 'ai' && trainedModel && modelNormalization) {
        addLog(`Using TFJS model for AI alignment.`);
        stackedImageData = await aiClientAlignAndStack(
            allImageStarData, 
            { model: trainedModel, normalization: modelNormalization },
            stackingMode, 
            addLog, 
            (p) => setProgressPercent(p * 100)
        );

      } else {
        const imageDatas = allImageStarData.map(entry => entry.imageData).filter((d): d is ImageData => d !== null);
        if (imageDatas.length !== allImageStarData.length) throw new Error("Some images have not been analyzed or loaded correctly.");
        // Standard Alignment
        const refImageForStandard = allImageStarData[0];
        const refStarsForStandard = (manualSelectImageId === refImageForStandard.id && manualSelectedStars.length > 1) 
            ? manualSelectedStars 
            : refImageForStandard.detectedStars;

        if (refStarsForStandard.length < 2) {
          throw new Error("Standard alignment requires at least 2 stars in the reference image. Please use Manual Select or ensure auto-detection finds stars.");
        }
        stackedImageData = await alignAndStack(allImageStarData, refStarsForStandard, stackingMode, (p) => setProgressPercent(p * 100));
      }

      const { width, height } = allImageStarData[0].analysisDimensions;
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
      addLog(`Stacking Complete: Successfully stacked ${allImageStarData.length} images.`);
  
    } catch (error) {
      console.error("Stacking error details:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLog(`[STACK FATAL ERROR] ${errorMessage}`);
      window.alert(`Stacking Failed: ${errorMessage}`);
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
        window.alert(t('noTestImageToastTitle'));
        return;
    }
    if (!trainedModel || !modelNormalization) {
        window.alert("AI model is not trained. Please train the model before running a test.");
        return;
    }
    
    setIsAnalyzingTestImage(true);
    addLog(`Running model test on ${testImage.file.name}`);
    
    // This timeout is just to allow the UI to update to the "loading" state before a potentially long-running operation.
    setTimeout(async () => {
        const {data, width, height} = testImage.imageData!;
        const { matchedStars, logs } = await findMatchingStars({
          imageData: {data: Array.from(data), width, height},
          model: trainedModel,
          normalization: modelNormalization,
        });
        
        logs.forEach(logMsg => addLog(`[AI TEST] ${logMsg}`));
        
        setTestImageMatchedStars(matchedStars);
        setIsAnalyzingTestImage(false);
        addLog(`Test complete. Found ${matchedStars.length} matching stars.`);
        window.alert(t('testAnalysisCompleteToastDesc', {count: matchedStars.length, fileName: testImage.file.name}));
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
    if (window.confirm(`Are you sure you want to delete the pattern "${patternId}"? This cannot be undone.`)) {
        setLearnedPatterns(prevPatterns => {
            const newPatterns = prevPatterns.filter(p => p.id !== patternId);
            saveLearnedPatterns(newPatterns);
            return newPatterns;
        });
        
        setSelectedPatternIDs(prevSelected => {
            const newSelectedIDs = new Set(prevSelected);
            newSelectedIDs.delete(patternId);
            return newSelectedIDs;
        });
        
        if (patternId === 'aggregated-user-pattern') {
            setManualSelectedStars([]);
            setCanvasStars([]);
        }
        addLog(`Pattern ${patternId} deleted.`);
    }
  };
  
  const handleExportPatterns = () => {
    if (learnedPatterns.length === 0) {
        window.alert(t('noPatternsToExport'));
        return;
    }
    const dataStr = JSON.stringify(learnedPatterns, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'astrostacker_patterns.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    addLog("Exported all learned patterns to astrostacker_patterns.json");
  };

  const handleImportPatterns = (files: File[]) => {
    if (files.length === 0) return;
    const file = files[0];
    const reader = new FileReader();

    reader.onload = (event) => {
        try {
            const content = event.target?.result as string;
            if (!content) throw new Error("File is empty or could not be read.");
            
            const importedPatterns: LearnedPattern[] = JSON.parse(content);

            // Basic validation
            if (!Array.isArray(importedPatterns) || importedPatterns.some(p => !p.id || !p.characteristics)) {
                throw new Error("Invalid pattern file format.");
            }

            setLearnedPatterns(prev => {
                const newPatternsMap = new Map(prev.map(p => [p.id, p]));
                let updatedCount = 0;
                let newCount = 0;

                for (const imported of importedPatterns) {
                    if (newPatternsMap.has(imported.id)) {
                        // Accumulate characteristics if pattern exists
                        const existingPattern = newPatternsMap.get(imported.id)!;
                        existingPattern.characteristics.push(...imported.characteristics);
                        existingPattern.sourceImageIds = Array.from(new Set([...existingPattern.sourceImageIds, ...imported.sourceImageIds]));
                        existingPattern.timestamp = Date.now();
                        updatedCount++;
                    } else {
                        // Add new pattern
                        newPatternsMap.set(imported.id, imported);
                        newCount++;
                    }
                }
                
                const finalPatterns = Array.from(newPatternsMap.values());
                saveLearnedPatterns(finalPatterns);
                addLog(`Import complete: ${newCount} new patterns added, ${updatedCount} existing patterns updated by accumulating data.`);
                window.alert(t('patternsImportedSuccess', { new: newCount, updated: updatedCount }));
                return finalPatterns;
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            addLog(`[ERROR] Pattern import failed: ${errorMessage}`);
            window.alert(`${t('patternImportFailed')}: ${errorMessage}`);
        }
    };
    reader.onerror = () => {
      addLog('[ERROR] Failed to read pattern file.');
      window.alert(t('patternImportFailed'));
    };
    reader.readAsText(file);
  };
  

  // --- Client-Side Model Training Logic ---

  type Sample = {
    features: number[];
    label: number;
  };

  function featuresFromCharacteristics(c: StarCharacteristics): number[] {
      const f_centerRGB = c.centerRGB.reduce((a, b) => a + b, 0) / 3;
      const f_patch3 = c.patch3x3RGB.reduce((a, b) => a + b, 0) / 3;
      const f_patch5 = c.patch5x5RGB.reduce((a, b) => a + b, 0) / 3;
      return [
          c.avgBrightness ?? 0, c.avgContrast ?? 0, c.fwhm ?? 0, c.pixelCount ?? 0,
          f_centerRGB, f_patch3, f_patch5,
      ];
  }

  function normalizeFeatures(mat: number[][]) {
      const cols = mat[0].length;
      const means = new Array(cols).fill(0);
      const stds = new Array(cols).fill(0);
      const n = mat.length;
      for (let j = 0; j < cols; j++) {
          for (let i = 0; i < n; i++) means[j] += mat[i][j];
          means[j] /= n;
          for (let i = 0; i < n; i++) stds[j] += Math.pow(mat[i][j] - means[j], 2);
          stds[j] = Math.sqrt(stds[j] / n) || 1;
      }
      const norm = mat.map(row => row.map((v, j) => (v - means[j]) / stds[j]));
      return { norm, means, stds };
  }

  async function trainClientModel(samples: Sample[], epochs = 30, batchSize = 16) {
      if (samples.some(s => typeof s.label === 'undefined')) {
          throw new Error('Labels are missing for some samples.');
      }
      const X = samples.map(s => s.features);
      const y = samples.map(s => s.label!);

      const { norm, means, stds } = normalizeFeatures(X);
      const xs = tf.tensor2d(norm);
      const ys = tf.tensor2d(y.map(v => [v]));

      const split = Math.floor(norm.length * 0.8);
      const [xTrain, xTest] = [xs.slice([0, 0], [split, xs.shape[1]]), xs.slice([split, 0], [xs.shape[0] - split, xs.shape[1]])];
      const [yTrain, yTest] = [ys.slice([0, 0], [split, 1]), ys.slice([split, 0], [ys.shape[0] - split, 1])];

      const model = buildModel();
      model.compile({ optimizer: tf.train.adam(0.001), loss: 'binaryCrossentropy', metrics: ['accuracy'] });

      const history = await model.fit(xTrain, yTrain, {
          epochs,
          batchSize,
          validationData: [xTest, yTest],
          shuffle: true,
          callbacks: {
              onEpochEnd: (epoch, logs) => {
                  if (logs && (epoch + 1) % 5 === 0) {
                      const acc = logs.acc || logs.accuracy;
                      const valAcc = logs.val_acc || logs.val_accuracy;
                      addLog(`Epoch ${epoch + 1}: Accuracy=${acc ? acc.toFixed(3) : 'N/A'}, Val Accuracy=${valAcc ? valAcc.toFixed(3) : 'N/A'}`);
                  }
              }
          }
      });
      
      const finalEpochLogs = history.history.acc ? { acc: history.history.acc[epochs - 1], val_acc: history.history.val_acc[epochs - 1] } : {};

      tf.dispose([xs, ys, xTrain, xTest, yTrain, yTest]);

      return { model, means, stds, accuracy: finalEpochLogs.acc as number };
  }


  const handleTrainModel = async () => {
      const activePatterns = learnedPatterns.filter(p => selectedPatternIDs.has(p.id));
      if (activePatterns.length === 0) {
          window.alert("Please select at least one pattern to train the model.");
          return;
      }
      
      const starCharacteristics = activePatterns.flatMap(p => p.characteristics);
      if (starCharacteristics.length < 20) {
        window.alert(`Need at least 20 star samples to train a model. You have ${starCharacteristics.length}. Please add more stars via Manual Select.`);
        return;
      }
      
      addLog(`[TRAIN] Starting client-side model training with ${starCharacteristics.length} star samples.`);
      setIsTrainingModel(true);
      
      try {
        const starSamples: Sample[] = starCharacteristics.map(c => ({ features: featuresFromCharacteristics(c), label: 1 }));
        
        // Generate artificial noise samples for negative examples
        const noiseSamples: Sample[] = [];
        const numNoiseSamples = Math.max(starSamples.length, 20);
        const numFeatures = starSamples[0].features.length;
        for (let i = 0; i < numNoiseSamples; i++) {
            const noiseFeatures = Array(numFeatures).fill(0).map(() => Math.random() * 50);
            noiseSamples.push({ features: noiseFeatures, label: 0 });
        }
        
        const allSamples = [...starSamples, ...noiseSamples];

        const { model, means, stds, accuracy } = await trainClientModel(allSamples);
        
        setTrainedModel(model);
        setModelNormalization({ means, stds });

        addLog(`[TRAIN] Client-side training successful! Accuracy: ${accuracy ? (accuracy * 100).toFixed(2) : 'N/A'}%. Model is ready.`);
        window.alert("AI Model trained successfully and is ready for alignment.");

      } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          addLog(`[TRAIN ERROR] ${errorMessage}`);
          window.alert(`Model training failed: ${errorMessage}`);
      } finally {
          setIsTrainingModel(false);
      }
  };


  const imageForAnnotation = allImageStarData.find(img => img.id === manualSelectImageId);
  const canStartStacking = allImageStarData.length >= 2 && allImageStarData.every(img => img.isAnalyzed);
  const isUiDisabled = isProcessingStack || isTrainingModel || allImageStarData.some(img => img.isAnalyzing);
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
                            onManualSelectToggle={() => handleManualSelectToggle(entry.id)} isProcessing={isUiDisabled}
                            isAnalyzed={entry.isAnalyzed} 
                            isManualSelectMode={manualSelectImageId === entry.id}
                          />
                        ))}
                      </div>
                    </ScrollArea>
                  </>
                )}
                {manualSelectImageId && imageForAnnotation && (
                  <Card className="mt-2 bg-muted/20">
                    <CardHeader className="p-3"><CardTitle className="text-base">Manual Star Selection</CardTitle>
                      <CardDescription className="text-xs">Now editing: {imageForAnnotation.file.name}. Selected {manualSelectedStars.length} stars.</CardDescription>
                    </CardHeader>
                    <CardFooter className="p-3 flex flex-col gap-2">
                       <Button onClick={handleWipeAllStars} className="w-full" variant="destructive" size="sm"><Eraser className="mr-2 h-4 w-4" />Wipe All Stars</Button>
                      <Button onClick={handleConfirmManualSelection} className="w-full" variant="secondary"><CheckCircle className="mr-2 h-4 w-4" />Confirm &amp; Learn Pattern</Button>
                      <Button onClick={() => {setManualSelectImageId(null); setManualSelectedStars([]); setCanvasStars([]);}} className="w-full"><X className="mr-2 h-4 w-4" />Cancel</Button>
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
                            <span className={ log.message.toLowerCase().includes('error') || log.message.toLowerCase().includes('failed') ? 'text-destructive' : log.message.toLowerCase().includes('warn') ? 'text-yellow-500' : log.message.startsWith('[ALIGN]') || log.message.startsWith('[AI ALIGN]') ? 'text-sky-400' : 'text-foreground/80'}>{log.message}</span>
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
              {imageForAnnotation ? (
                  <StarAnnotationCanvas imageUrl={imageForAnnotation.previewUrl} allStars={canvasStars} manualStars={manualSelectedStars} onCanvasClick={handleStarAnnotationClick} analysisWidth={imageForAnnotation.analysisDimensions.width} analysisHeight={imageForAnnotation.analysisDimensions.height} />
              ) : testImage ? (
                  <StarAnnotationCanvas imageUrl={testImage.previewUrl} allStars={testImage.detectedStars} manualStars={testImageMatchedStars} onCanvasClick={() => {}} analysisWidth={testImage.analysisDimensions.width} analysisHeight={testImage.analysisDimensions.height} />
              ) : (
                  <ImagePreview imageUrl={showPostProcessEditor ? editedPreviewUrl : stackedImage} fitMode={previewFitMode} />
              )}
            </div>
            {stackedImage && !showPostProcessEditor && (<Button onClick={handleOpenPostProcessEditor} className="w-full bg-purple-600 hover:bg-purple-700 text-white" size="lg" disabled={isProcessingStack}><Wand2 className="mr-2 h-5 w-5" />{t('finalizeAndDownload')}</Button>)}
            
            <Card>
                <CardHeader><CardTitle className="flex items-center"><BrainCircuit className="mr-2 h-5 w-5" />{t('learningModeCardTitle')}</CardTitle><CardDescription>{t('learningModeCardDescription')}</CardDescription></CardHeader>
                <CardContent>
                    <div className="grid grid-cols-2 gap-4 mb-4">
                      <Button onClick={handleExportPatterns} disabled={learnedPatterns.length === 0}><Download className="mr-2 h-4 w-4" />{t('exportPatternsButton')}</Button>
                      <ImageUploadArea onFilesAdded={handleImportPatterns} isProcessing={isUiDisabled} multiple={false} accept={{ 'application/json': ['.json'] }} dropzoneText={t('importPatternsDropzone')} buttonText={t('importPatternsButton')} />
                    </div>
                     <Button onClick={handleTrainModel} disabled={isUiDisabled || learnedPatterns.filter(p => selectedPatternIDs.has(p.id)).length === 0} className="w-full mb-4">
                        {isTrainingModel ? <><Loader2 className="mr-2 h-4 w-4 animate-spin"/>{t('trainingModelButton')}</> : <><Cpu className="mr-2 h-4 w-4" />{t('trainModelButton')}</>}
                    </Button>
                    {trainedModel && <Alert variant="default" className="mb-4"><AlertCircle className="h-4 w-4" /><AlertTitle>Model Trained</AlertTitle><AlertDescription>An AI model has been trained and is ready. The 'AI Pattern' stacking method will now use this model.</AlertDescription></Alert>}

                    <h4 className="font-semibold mb-2">{t('allLearnedPatternsListTitle')}</h4>
                    {learnedPatterns.length === 0 ? (<p className="text-sm text-muted-foreground">{t('noPatternLearnedYetInfo')}</p>) : (
                        <ScrollArea className="h-40 border rounded-md p-2">
                            {learnedPatterns.map(p => (
                                <div key={p.id} className="flex items-center justify-between p-2 rounded-md hover:bg-muted/50">
                                    <div className="flex items-center gap-2">
                                        <Checkbox id={`pattern-${p.id}`} checked={selectedPatternIDs.has(p.id)} onCheckedChange={(checked) => handlePatternSelectionChange(p.id, !!checked)} />
                                        <div>
                                            <label htmlFor={`pattern-${p.id}`} className="font-medium text-sm cursor-pointer">{p.id} ({p.characteristics.length} stars)</label>
                                            <p className="text-xs text-muted-foreground"> {p.sourceImageIds.length} source images. Learned on {new Date(p.timestamp).toLocaleDateString()}</p>
                                        </div>
                                    </div>
                                    <Button variant="ghost" size="icon" className="h-7 w-7 z-10" onClick={() => deletePattern(p.id)}><Trash2 className="h-4 w-4 text-destructive"/></Button>
                                </div>
                            ))}
                        </ScrollArea>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader><CardTitle className="flex items-center"><TestTube2 className="mr-2 h-5 w-5" />{t('learnTestCardTitle')}</CardTitle><CardDescription>{t('learnTestCardDescription')}</CardDescription></CardHeader>
                <CardContent className="space-y-4">
                    <ImageUploadArea onFilesAdded={handleTestFileAdded} isProcessing={isAnalyzingTestImage || isUiDisabled} multiple={false} />
                    <Button onClick={runPatternTest} disabled={isAnalyzingTestImage || isUiDisabled || !testImage} className="w-full">
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
