
"use client";

import type React from 'react';
import { useState, useEffect, useRef, useCallback }from 'react';
import { useFormState } from 'react-dom';
import * as tf from '@tensorflow/tfjs';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { alignAndStack, detectBrightBlobs, type Star, type StackingMode } from '@/lib/astro-align';
import { consensusAlignAndStack } from '@/lib/consensus-align';
import { planetaryAlignAndStack } from '@/lib/planetary-align';
import { dumbAlignAndStack } from '@/lib/dumb-align';
import { extractCharacteristicsFromImage, findMatchingStars, predictSingle, buildModel } from '@/lib/ai-star-matcher';
import { AppHeader } from '@/components/astrostacker/AppHeader';
import { ImageUploadArea } from '@/components/astrostacker/ImageUploadArea';
import { ImageQueueItem } from '@/components/astrostacker/ImageQueueItem';
import { ImagePreview } from '@/components/astrostacker/ImagePreview';
import { ImagePostProcessEditor } from '@/components/astrostacker/ImagePostProcessEditor';
import { TutorialDialog } from '@/components/astrostacker/TutorialDialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Star as StarIcon, Link, ListChecks, CheckCircle, RefreshCcw, Edit3, Loader2, Orbit, Trash2, Wand2, ShieldOff, Layers, Baseline, X, AlertTriangle, BrainCircuit, TestTube2, Eraser, Download, Upload, Cpu, AlertCircle, Moon, Sun, Sparkles, UserCheck, Zap, Diamond, Globe, Camera, Video, Play, StopCircle, Puzzle, Server, RotateCcw, Palette, Workflow } from 'lucide-react';
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
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { createMasterFrame, applyCalibration } from '@/lib/image-calibration';
import { applyPostProcessing } from '@/lib/post-process';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { saveAs } from 'file-saver';
import { stackImagesWithUrls, type ServerImagePayload } from '@/app/actions';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ImageQueueEntry, CalibrationFrameEntry, StarCategory, LearnedPattern, LabeledStar, TestResultStar, PreviewFitMode, OutputFormat, AlignmentMethod, StackingQuality, StarDetectionMethod, StarCharacteristics } from '@/types';
import { detectStarsAdvanced } from '@/lib/siril-like-detection';


export const dynamic = 'force-static';

const MIN_VALID_DATA_URL_LENGTH = 100;
const IS_LARGE_IMAGE_THRESHOLD_MP = 12;
const MAX_DIMENSION_DOWNSCALED = 2048;
const TF_MODEL_STORAGE_KEY = 'localstorage://astrostacker-model';
const STAR_CATEGORY_STORAGE_KEY = 'astrostacker-star-categories';
const LEARNED_PATTERNS_STORAGE_KEY = 'astrostacker-learned-patterns-v2';
const STAR_DEDUPLICATION_RADIUS = 10;

const CATEGORY_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#FED766', '#F0B8D9',
  '#97C1A9', '#FFD166', '#06D6A0', '#EF476F', '#118AB2'
];

const initialServerStackState = {
  success: false,
  message: '',
  stackedImageUrl: null,
  logs: [],
};


export default function AstroStackerPage() {
  const { t } = useLanguage();
  const [allImageStarData, setAllImageStarData] = useState<ImageQueueEntry[]>([]);
  const [stackedImage, setStackedImage] = useState<string | null>(null);
  const [isProcessingStack, setIsProcessingStack] = useState(false);
  const [isTrainingModel, setIsTrainingModel] = useState(false);
  const [stackingMode, setStackingMode] = useState<StackingMode>('median');
  const [alignmentMethod, setAlignmentMethod] = useState<AlignmentMethod>('dumb');
  const [starDetectionMethod, setStarDetectionMethod] = useState<StarDetectionMethod>('general');
  const [stackingQuality, setStackingQuality] = useState<StackingQuality>('standard');
  const [planetaryStackingQuality, setPlanetaryStackingQuality] = useState<number>(50);
  const [previewFitMode, setPreviewFitMode] = useState<PreviewFitMode>('contain');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('png');
  const [jpegQuality, setJpegQuality] = useState<number>(92);
  const [progressPercent, setProgressPercent] = useState(0);
  const [logs, setLogs] = useState<{ id: number; timestamp: string; message: string; }[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const logIdCounter = useRef(0);
  
  const [manualSelectImageId, setManualSelectImageId] = useState<string | null>(null);
  const [manualSelectedStars, setManualSelectedStars] = useState<LabeledStar[]>([]);
  const [showPostProcessEditor, setShowPostProcessEditor] = useState(false);
  const [imageForPostProcessing, setImageForPostProcessing] = useState<string | null>(null);
  const [editedPreviewUrl, setEditedPreviewUrl] = useState<string | null>(null);
  
  // --- Post-Processing State ---
  const [brightness, setBrightness] = useState(100);
  const [exposure, setExposure] = useState(0);
  const [saturation, setSaturation] = useState(100);
  const [blackPoint, setBlackPoint] = useState(0);
  const [midtones, setMidtones] = useState(1);
  const [whitePoint, setWhitePoint] = useState(255);
  const [isApplyingAdjustments, setIsApplyingAdjustments] = useState(false);
  const [isTutorialOpen, setIsTutorialOpen] = useState(false);

  // --- Calibration Frame State ---
  const [darkFrames, setDarkFrames] = useState<CalibrationFrameEntry[]>([]);
  const [flatFrames, setFlatFrames] = useState<CalibrationFrameEntry[]>([]);
  const [biasFrames, setBiasFrames] = useState<CalibrationFrameEntry[]>([]);
  const [useDarks, setUseDarks] = useState(false);
  const [useFlats, setUseFlats] = useState(false);
  const [useBias, setUseBias] = useState(false);
  
  // --- AI Learning State ---
  const [starCategories, setStarCategories] = useState<StarCategory[]>([]);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [learnedPatterns, setLearnedPatterns] = useState<Record<string, LearnedPattern>>({});
  const [selectedPatternIDs, setSelectedPatternIDs] = useState<Set<string>>(new Set());
  const [testImage, setTestImage] = useState<ImageQueueEntry | null>(null);
  const [isAnalyzingTestImage, setIsAnalyzingTestImage] = useState(false);
  const [testImageMatchedStars, setTestImageMatchedStars] = useState<TestResultStar[]>([]);

  // --- TFJS Model State ---
  const [trainedModel, setTrainedModel] = useState<tf.LayersModel | null>(null);
  const [modelNormalization, setModelNormalization] = useState<{ means: number[], stds: number[] } | null>(null);
  const [modelCategories, setModelCategories] = useState<string[] | null>(null);

  // --- File processing readiness ---
  const [isFileApiReady, setIsFileApiReady] = useState(false);
  useEffect(() => {
    // Since this runs client-side only, we know the APIs are available.
    setIsFileApiReady(true);
  }, []);

  const [serverStackState, formAction] = useFormState(stackImagesWithUrls, initialServerStackState);
  const formRef = useRef<HTMLFormElement>(null);
  const [isServerProcessing, setIsServerProcessing] = useState(false);
  
  useEffect(() => {
    if (serverStackState.logs.length > logs.length) {
      serverStackState.logs.slice(logs.length).forEach(log => addLog(log));
    }
    if (serverStackState.message && !logs.some(l => l.message.includes(serverStackState.message))) {
      addLog(`[SERVER] ${serverStackState.message}`);
      if (!serverStackState.success) {
        window.alert(`Server Stacking Failed: ${serverStackState.message}`);
      }
    }
    if (serverStackState.success && serverStackState.stackedImageUrl) {
        setStackedImage(serverStackState.stackedImageUrl);
        setImageForPostProcessing(serverStackState.stackedImageUrl);
        setEditedPreviewUrl(serverStackState.stackedImageUrl);
        handleResetAdjustments();
    }
    if (serverStackState.message || serverStackState.logs.length > 0) {
      setIsServerProcessing(false);
    }
  }, [serverStackState]);

  const addLog = useCallback((message: string) => {
    if (!message) return;
    setLogs(prevLogs => {
      // Avoid duplicate logs
      if (prevLogs.some(log => log.message === message)) {
          return prevLogs;
      }
      const newLog = {
        id: logIdCounter.current++,
        timestamp: new Date().toLocaleTimeString(),
        message
      };
      return [newLog, ...prevLogs].slice(0, 150);
    });
  }, []);

  const fileToDataURL = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        addLog(`[fileToDataURL] Processing ${file.name} (type: ${file.type})`);
        const reader = new FileReader();
        reader.onload = (e) => {
            if (e.target?.result) {
                addLog(`[fileToDataURL] FileReader success for ${file.name}.`);
                resolve(e.target.result as string);
            } else {
                reject(new Error(`FileReader failed for ${file.name}. Result was empty.`));
            }
        };
        reader.onerror = (e) => reject(new Error(`Error reading file ${file.name} with FileReader.`));
        reader.readAsDataURL(file);
    });
  }, [addLog]);

  // Load data from local storage on mount
  useEffect(() => {
    try {
      const storedPatterns = localStorage.getItem(LEARNED_PATTERNS_STORAGE_KEY);
      if (storedPatterns) setLearnedPatterns(JSON.parse(storedPatterns));
      
      const storedCategories = localStorage.getItem(STAR_CATEGORY_STORAGE_KEY);
      if (storedCategories) {
        setStarCategories(JSON.parse(storedCategories));
      } else {
        // Initialize default categories if none are stored
        const defaultCategories: StarCategory[] = CATEGORY_COLORS.map((color, index) => ({
          id: `category-${index + 1}`,
          name: `Category ${index + 1}`,
          color: color,
        }));
        setStarCategories(defaultCategories);
        localStorage.setItem(STAR_CATEGORY_STORAGE_KEY, JSON.stringify(defaultCategories));
      }
      
      const loadModel = async () => {
        addLog("[AI-CLIENT] Checking for a saved model in browser storage...");
        try {
            const loadedModel = await tf.loadLayersModel(TF_MODEL_STORAGE_KEY);
            const storedNormalization = localStorage.getItem('astrostacker-model-normalization');
            const storedCategories = localStorage.getItem('astrostacker-model-categories');
            if (loadedModel && storedNormalization && storedCategories) {
                setTrainedModel(loadedModel);
                setModelNormalization(JSON.parse(storedNormalization));
                setModelCategories(JSON.parse(storedCategories));
                addLog("[AI-CLIENT] Successfully loaded pre-trained model and metadata from storage.");
            } else {
                addLog("[AI-CLIENT] No complete pre-trained model found.");
            }
        } catch (e) {
            addLog("[AI-CLIENT] No pre-trained model found in storage.");
        }
      };
      loadModel();

    } catch (e) {
      console.error("Failed to load data from localStorage", e);
      addLog("[ERROR] Failed to load data from localStorage.");
    }
  }, [addLog]);

  // Save functions for localStorage
  const saveLearnedPatterns = (patterns: Record<string, LearnedPattern>) => {
    try {
      localStorage.setItem(LEARNED_PATTERNS_STORAGE_KEY, JSON.stringify(patterns));
    } catch (e) {
      console.error("Failed to save learned patterns", e);
      addLog("[ERROR] Failed to save learned patterns to localStorage.");
    }
  };

  const saveStarCategories = (categories: StarCategory[]) => {
    try {
      localStorage.setItem(STAR_CATEGORY_STORAGE_KEY, JSON.stringify(categories));
    } catch (e) {
      console.error("Failed to save star categories", e);
      addLog("[ERROR] Failed to save star categories to localStorage.");
    }
  };

  const handleCategoryNameChange = (id: string, newName: string) => {
    const newCategories = starCategories.map(c => c.id === id ? { ...c, name: newName } : c);
    setStarCategories(newCategories);
    saveStarCategories(newCategories);
  };


  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = 0;
    }
  }, [logs]);

  useEffect(() => {
    if (!imageForPostProcessing || !showPostProcessEditor) return;
    const applyAdjustments = async () => {
      setIsApplyingAdjustments(true);
      try {
        const adjustedUrl = await applyPostProcessing(
          imageForPostProcessing,
          { brightness, exposure, saturation },
          { blackPoint, midtones, whitePoint },
          outputFormat,
          jpegQuality / 100
        );
        setEditedPreviewUrl(adjustedUrl);
      } catch (error) {
        console.error("Adjustment Error", "Could not apply image adjustments.");
        setEditedPreviewUrl(imageForPostProcessing);
      } finally {
        setIsApplyingAdjustments(false);
      }
    };
    const debounceTimeout = setTimeout(applyAdjustments, 200);
    return () => clearTimeout(debounceTimeout);
  }, [
    imageForPostProcessing, brightness, exposure, saturation, 
    blackPoint, midtones, whitePoint,
    showPostProcessEditor, outputFormat, jpegQuality
  ]);

  const analyzeImageForStars = async (entryToAnalyze: ImageQueueEntry): Promise<ImageQueueEntry> => {
    setAllImageStarData(prevData =>
      prevData.map(e => e.id === entryToAnalyze.id ? { ...e, isAnalyzing: true, isAnalyzed: false } : e)
    );
  
    let finalUpdatedEntry: ImageQueueEntry = { ...entryToAnalyze, isAnalyzing: true, isAnalyzed: false };
  
    try {
      addLog(`[ANALYZE START] For: ${entryToAnalyze.file.name} using '${starDetectionMethod}' method.`);
      const imgEl = new Image();
      imgEl.src = entryToAnalyze.analysisPreviewUrl;
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
      
      let detectedStars: Star[] = [];
      if (starDetectionMethod === 'advanced') {
        detectedStars = detectStarsAdvanced(imageData, addLog);
      } else {
        // Fallback to general blob detection
        let currentThreshold = 200;
        const minThreshold = 150;
    
        addLog(`[ANALYZE] Initial detection at threshold ${currentThreshold}...`);
        while (detectedStars.length < 10 && currentThreshold >= minThreshold) {
          detectedStars = detectBrightBlobs(imageData, canvas.width, canvas.height, currentThreshold);
          if (detectedStars.length < 10 && currentThreshold > minThreshold) {
            addLog(`[ANALYZE] Found ${detectedStars.length} stars. Lowering threshold to ${currentThreshold - 5}.`);
            currentThreshold -= 5;
          } else {
            break;
          }
        }
      }


      finalUpdatedEntry = { ...finalUpdatedEntry, imageData, detectedStars, isAnalyzed: true };
      addLog(`[ANALYZE SUCCESS] Finalized with ${detectedStars.length} potential star candidates in ${entryToAnalyze.file.name}.`);
  
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

  const handleServerStacking = async (files: File[]) => {
      setIsServerProcessing(true);
      setStackedImage(null);
      setShowPostProcessEditor(false);
      addLog(`[API-STACK] Stacking ${files.length} file(s) via API...`);

      try {
        const formData = new FormData();
        files.forEach(file => {
            formData.append('images', file);
        });
        formData.append('alignmentMethod', alignmentMethod);
        formData.append('stackingMode', stackingMode);

        const response = await fetch('/api/stack', {
            method: 'POST',
            body: formData,
        });

        const result = await response.json();

        if (response.ok && result.stackedImageUrl) {
            addLog(`[API-STACK] Success: ${result.message}`);
            result.logs.forEach((l: string) => addLog(l));
            setStackedImage(result.stackedImageUrl);
            setImageForPostProcessing(result.stackedImageUrl);
            setEditedPreviewUrl(result.stackedImageUrl);
            handleResetAdjustments();
        } else {
            const errorMsg = result.error || 'Unknown API error';
            addLog(`[API-STACK] Error: ${errorMsg}`);
            if (result.details) addLog(`[API-STACK] Details: ${result.details}`);
            (result.logs || []).forEach((l: string) => addLog(l));
            window.alert(`Server Stacking Failed: ${errorMsg}`);
        }

      } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "An unknown server error occurred.";
          addLog(`[API-STACK] Fatal Error: ${errorMessage}`);
          window.alert(`Server Stacking Failed: ${errorMessage}`);
      } finally {
          setIsServerProcessing(false);
      }
  };

  const handleFilesAdded = useCallback(async (files: File[]) => {
    addLog(`Attempting to add ${files.length} file(s).`);
  
    const webImageFiles: File[] = [];
    const fitsFiles: File[] = [];
  
    for (const file of files) {
      if (file.type === 'image/fits' || file.name.toLowerCase().endsWith('.fits') || file.name.toLowerCase().endsWith('.fit')) {
        addLog(`[FITS DETECTED] Queueing ${file.name} for server-side processing.`);
        fitsFiles.push(file);
      } else {
        webImageFiles.push(file);
      }
    }
  
    if (fitsFiles.length > 0) {
      handleServerStacking(fitsFiles);
    }
  
    if (webImageFiles.length === 0) return;
  
    const newEntriesPromises = webImageFiles.map(async (file): Promise<ImageQueueEntry | null> => {
      try {
        const originalPreviewUrl = await fileToDataURL(file);
        const img = new Image();
        const originalDimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
          img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => reject(new Error("Could not load image to get dimensions."));
          img.src = originalPreviewUrl;
        });

        let analysisDimensions = { ...originalDimensions };
        let analysisPreviewUrl = originalPreviewUrl;

        const isLarge = (originalDimensions.width * originalDimensions.height) / 1_000_000 > IS_LARGE_IMAGE_THRESHOLD_MP;
        if (isLarge) {
          addLog(`[INFO] Image ${file.name} is large (${originalDimensions.width}x${originalDimensions.height}). It will be downscaled for analysis.`);
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          if (ctx) {
              let targetWidth = originalDimensions.width, targetHeight = originalDimensions.height;
              if (originalDimensions.width > MAX_DIMENSION_DOWNSCALED || originalDimensions.height > MAX_DIMENSION_DOWNSCALED) {
                  if (originalDimensions.width > originalDimensions.height) {
                      targetWidth = MAX_DIMENSION_DOWNSCALED;
                      targetHeight = Math.round((originalDimensions.height / originalDimensions.width) * MAX_DIMENSION_DOWNSCALED);
                  } else {
                      targetHeight = MAX_DIMENSION_DOWNSCALED;
                      targetWidth = Math.round((originalDimensions.width / originalDimensions.height) * MAX_DIMENSION_DOWNSCALED);
                  }
              }
              canvas.width = targetWidth;
              canvas.height = targetHeight;
              ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
              analysisPreviewUrl = canvas.toDataURL('image/png');
              analysisDimensions = { width: targetWidth, height: targetHeight };
              addLog(`Downscaled ${file.name} to ${targetWidth}x${targetHeight} for analysis.`);
          }
        }
  
        return {
          id: `${file.name}-${Date.now()}`,
          file,
          originalPreviewUrl,
          analysisPreviewUrl,
          isAnalyzing: false,
          isAnalyzed: false,
          originalDimensions,
          analysisDimensions,
          imageData: null,
          detectedStars: [],
          manualStars: [],
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
  }, [addLog, fileToDataURL, starDetectionMethod, alignmentMethod, stackingMode]);


  const handleCalibrationFilesAdded = useCallback(async (
    files: File[],
    type: 'dark' | 'flat' | 'bias'
  ) => {
      addLog(`[CALIBRATION] Loading ${files.length} ${type} frame(s)...`);
      const setters = {
          dark: setDarkFrames,
          flat: setFlatFrames,
          bias: setBiasFrames,
      };
      const setState = setters[type];

      const newEntriesPromises = files.map(async (file): Promise<CalibrationFrameEntry | null> => {
          try {
              const previewUrl = await fileToDataURL(file);
              const img = new Image();
              const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
                  img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
                  img.onerror = () => reject(new Error("Could not load image."));
                  img.src = previewUrl;
              });

              const canvas = document.createElement('canvas');
              const ctx = canvas.getContext('2d', { willReadFrequently: true });
              if (!ctx) throw new Error("Could not get canvas context.");
              canvas.width = dimensions.width;
              canvas.height = dimensions.height;
              ctx.drawImage(img, 0, 0);
              const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              
              addLog(`[CALIBRATION] Loaded ${type} frame: ${file.name} (${dimensions.width}x${dimensions.height})`);
              return {
                  id: `${type}-${file.name}-${Date.now()}`,
                  file, previewUrl, imageData, dimensions,
              };
          } catch (error) {
              addLog(`[ERROR] Failed to load ${type} frame ${file.name}: ${error instanceof Error ? error.message : "Unknown"}`);
              return null;
          }
      });

      const newEntries = (await Promise.all(newEntriesPromises)).filter((e): e is CalibrationFrameEntry => e !== null);
      if (newEntries.length > 0) {
        setState(prev => [...prev, ...newEntries]);
      }
  }, [addLog, fileToDataURL]);
  
  const handleRemoveImage = (idToRemove: string) => {
    setAllImageStarData(prev => prev.filter(item => item.id !== idToRemove));
    if (manualSelectImageId === idToRemove) {
      setManualSelectImageId(null);
      setManualSelectedStars([]);
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
      setActiveCategoryId(null);
      return;
    }
    
    setManualSelectImageId(imageId);
    // Load existing manual stars for this image, or start fresh
    setManualSelectedStars(imageToSelect.manualStars || []);
    // Set first category as active by default
    setActiveCategoryId(starCategories[0]?.id || null);
  };

  const findNearbyStarCenter = (
    imageData: ImageData,
    clickX: number,
    clickY: number,
    searchRadius: number = 20
  ): Star | null => {
      const { data, width, height } = imageData;
      const getBrightness = (idx: number) => 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  
      let maxBrightness = -1;
      let peakX = -1, peakY = -1;
  
      const startX = Math.max(0, Math.round(clickX - searchRadius));
      const endX = Math.min(width, Math.round(clickX + searchRadius));
      const startY = Math.max(0, Math.round(clickY - searchRadius));
      const endY = Math.min(height, Math.round(clickY + searchRadius));
  
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
  
      if (peakX === -1) return null;
  
      const threshold = maxBrightness * 0.5;
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
  
          for(let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                  if (dx === 0 && dy === 0) continue;
                  const nx = cx + dx;
                  const ny = cy + dy;
                  const nKey = `${nx},${ny}`;
                  if (nx >= 0 && nx < width && ny >= 0 && ny < height && !visited.has(nKey)) {
                      visited.add(nKey);
                      const nIdx = (ny * width + nx) * 4;
                      if(getBrightness(nIdx) > threshold * 0.8) {
                          queue.push([nx, ny]);
                      }
                  }
              }
          }
      }
  
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
    if (!manualSelectImageId || !activeCategoryId) return;
    const imageEntry = allImageStarData.find(img => img.id === manualSelectImageId);
    if (!imageEntry || !imageEntry.imageData) return;

    // Check if a star is already selected nearby
    const existingStarIndex = manualSelectedStars.findIndex(star => Math.hypot(star.x - x, star.y - y) < STAR_DEDUPLICATION_RADIUS);

    if (existingStarIndex !== -1) {
      // If a star exists nearby, remove it
      setManualSelectedStars(prev => prev.filter((_, index) => index !== existingStarIndex));
    } else {
      // Otherwise, add a new star
      const centeredStar = findNearbyStarCenter(imageEntry.imageData, x, y);
      if (centeredStar) {
        const newStar: LabeledStar = { ...centeredStar, categoryId: activeCategoryId };

        // Deduplication logic
        setManualSelectedStars(prevStars => {
          const filteredStars = prevStars.filter(existingStar => {
            return Math.hypot(existingStar.x - newStar.x, existingStar.y - newStar.y) >= STAR_DEDUPLICATION_RADIUS;
          });
          return [...filteredStars, newStar];
        });
      }
    }
  };
  

  const handleWipeAllStars = () => {
    if (manualSelectImageId) {
        setManualSelectedStars([]);
        addLog("Manual star selections for this image have been cleared.");
    }
  };

  const handleConfirmManualSelection = () => {
    if (!manualSelectImageId) return;
    
    setAllImageStarData(prev => prev.map(entry => 
      entry.id === manualSelectImageId 
        ? { ...entry, manualStars: manualSelectedStars } 
        : entry
    ));

    addLog(`Saved ${manualSelectedStars.length} manual stars for ${allImageStarData.find(e=>e.id === manualSelectImageId)?.file.name}.`);

    setManualSelectImageId(null);
    setManualSelectedStars([]);
    setActiveCategoryId(null);
  };

  const handleStackAllImages = async () => {
    const imagesToStack = allImageStarData.filter(img => img.isAnalyzed && img.imageData);
    if (imagesToStack.length < 2) {
      window.alert("Please upload and analyze at least two images.");
      return;
    }
    
    setIsProcessingStack(true);
    setProgressPercent(0);
    setStackedImage(null);
    setShowPostProcessEditor(false);
    addLog(`[STACK START] Method: ${alignmentMethod}. Quality: ${stackingQuality}. Stacking ${imagesToStack.length} images. Mode: ${stackingMode}.`);
  
    try {
      let masterBias: ImageData | null = null;
      if (useBias && biasFrames.length > 0) {
        masterBias = await createMasterFrame(biasFrames.map(f => f.imageData), 'average', addLog, 'BIAS');
      }

      let masterDark: ImageData | null = null;
      if (useDarks && darkFrames.length > 0) {
        masterDark = await createMasterFrame(darkFrames.map(f => f.imageData), 'average', addLog, 'DARK');
        if (masterDark && masterBias) {
            masterDark = applyCalibration(masterDark, null, masterBias, null, addLog, 'Master Dark');
        }
      }

      let masterFlat: ImageData | null = null;
      if (useFlats && flatFrames.length > 0) {
          masterFlat = await createMasterFrame(flatFrames.map(f => f.imageData), 'average', addLog, 'FLAT');
          if (masterFlat && masterBias) {
              masterFlat = applyCalibration(masterFlat, null, masterBias, null, addLog, 'Master Flat');
          }
      }

      addLog("[CALIBRATION] Applying calibration to light frames...");
      
      const lightFramesToProcess = [...imagesToStack];
      let stackingDimensions = lightFramesToProcess[0].analysisDimensions;

      if (stackingQuality === 'high') {
          addLog("[QUALITY] High quality selected. Loading original resolution images...");
          stackingDimensions = lightFramesToProcess[0].originalDimensions;
          for(let i = 0; i < lightFramesToProcess.length; i++) {
            const entry = lightFramesToProcess[i];
            addLog(`[QUALITY] Loading original for ${entry.file.name}`);
            const img = new Image();
            img.src = entry.originalPreviewUrl;
            await new Promise(res => img.onload = res);
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if(!ctx) continue;
            ctx.drawImage(img, 0, 0);
            entry.imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            entry.analysisDimensions = { width: canvas.width, height: canvas.height };
          }
          addLog("[QUALITY] Original resolution images loaded.");
      }


      const calibratedLightFrames = lightFramesToProcess.map((entry, index) => {
          if (!entry.imageData) return entry;
          setProgressPercent(5 + 15 * (index / lightFramesToProcess.length)); // Calibration is first 20%
          const calibratedImageData = applyCalibration(entry.imageData, masterDark, masterBias, masterFlat, addLog, entry.file.name);
          return { ...entry, imageData: calibratedImageData };
      });
      addLog("[CALIBRATION] Light frame calibration complete.");
      setProgressPercent(20);

      let stackedImageData;
      const progressUpdate = (p: number) => setProgressPercent(20 + p * 80);

      const shouldUseAi = starDetectionMethod === 'ai' && trainedModel && modelNormalization && modelCategories;
      const modelPackage = shouldUseAi ? { model: trainedModel, normalization: modelNormalization, categories: modelCategories } : undefined;

      if (alignmentMethod === 'planetary') {
        stackedImageData = await planetaryAlignAndStack(
            calibratedLightFrames,
            stackingMode,
            addLog,
            progressUpdate,
            planetaryStackingQuality
        );
      } else if (alignmentMethod === 'consensus') {
          if (shouldUseAi) {
            addLog("[CONSENSUS] Using AI-powered star detection for alignment.");
          } else {
            addLog("[CONSENSUS] Using general brightness-based star detection for alignment.");
          }
          stackedImageData = await consensusAlignAndStack({
              imageEntries: calibratedLightFrames,
              stackingMode,
              modelPackage,
              addLog,
              setProgress: progressUpdate,
          });
      } else if (alignmentMethod === 'dumb') {
          if (shouldUseAi) {
            addLog("[DUMB-STACK] Using AI-powered candidate selection for dumb alignment.");
          } else {
            addLog("[DUMB-STACK] Using brightest pixel detection for dumb alignment.");
          }
          stackedImageData = await dumbAlignAndStack({
              imageEntries: calibratedLightFrames,
              stackingMode,
              modelPackage,
              addLog,
              setProgress: progressUpdate,
          });
      } else {
        const refImageForStandard = calibratedLightFrames[0];
        // Use manually selected stars if they exist for the reference image.
        const refStarsForStandard = (refImageForStandard.manualStars && refImageForStandard.manualStars.length > 1) 
            ? refImageForStandard.manualStars 
            : refImageForStandard.detectedStars;

        if (refImageForStandard.manualStars && refImageForStandard.manualStars.length > 1) {
          addLog(`[ALIGN] Using ${refImageForStandard.manualStars.length} manually selected stars from reference image.`);
        } else {
          addLog(`[ALIGN] Using auto-detected stars from reference image.`);
        }

        if (refStarsForStandard.length < 2) {
          throw new Error("Standard alignment requires at least 2 stars in the reference image. Please use Manual Select or ensure auto-detection finds stars.");
        }
        stackedImageData = await alignAndStack(calibratedLightFrames, refStarsForStandard, stackingMode, progressUpdate, addLog);
      }

      const { width, height } = stackingDimensions;
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
  
      handleResetAdjustments();
      // Don't show post-process editor immediately, wait for user action
      // setShowPostProcessEditor(true); 
      addLog(`Stacking Complete: Successfully stacked ${calibratedLightFrames.length} images.`);
  
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
      setImageForPostProcessing(stackedImage); 
      setEditedPreviewUrl(stackedImage); 
      handleResetAdjustments();
      setShowPostProcessEditor(true);
    }
  };

  const handleResetAdjustments = () => {
    setBrightness(100); setExposure(0); setSaturation(100);
    setBlackPoint(0); setMidtones(1); setWhitePoint(255);
  };
  
  const handleTestFileAdded = useCallback(async (files: File[]) => {
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
            const detectedStars = detectBrightBlobs(imageData, canvas.width, canvas.height, 180);
            return { id: `test-${file.name}-${Date.now()}`, file, originalPreviewUrl: previewUrl, analysisPreviewUrl: previewUrl, isAnalyzing: false, isAnalyzed: true, originalDimensions: dimensions, analysisDimensions: dimensions, imageData, detectedStars, manualStars: [] };
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
  }, [addLog, fileToDataURL]);

  const runPatternTest = async () => {
    if (!testImage || !testImage.imageData) {
        window.alert(t('noTestImageToastTitle'));
        return;
    }
    if (!trainedModel || !modelNormalization || !modelCategories) {
        window.alert("AI model is not trained. Please train the model before running a test.");
        return;
    }
    
    setIsAnalyzingTestImage(true);
    addLog(`Running model test on ${testImage.file.name}`);
    
    setTimeout(async () => {
        const {data, width, height} = testImage.imageData!;

        const allMatchedStars: TestResultStar[] = [];
        
        const activePatterns = Object.values(learnedPatterns).filter(p => selectedPatternIDs.has(p.id));
        const categoriesToTest = starCategories.filter(cat => activePatterns.some(p => p.categoryId === cat.id));

        for (const category of categoriesToTest) {
          addLog(`[AI TEST] Searching for stars matching category: ${category.name}`);
          const { rankedStars, logs } = await findMatchingStars({
            imageData: {data: Array.from(data), width, height},
            candidates: testImage.detectedStars,
            model: trainedModel,
            normalization: modelNormalization,
            modelCategories: modelCategories,
            targetCategoryId: category.id,
          });
          
          logs.forEach(logMsg => addLog(`[AI TEST - ${category.name}] ${logMsg}`));
          
          const matchedStars = rankedStars
              .filter(rs => rs.probability > 0.7) // Use a higher threshold for better confidence
              .map(rs => ({ ...rs.star, categoryId: category.id, color: category.color }));

          allMatchedStars.push(...matchedStars);
        }

        setTestImageMatchedStars(allMatchedStars);
        addLog(`Test complete. Found ${allMatchedStars.length} matching stars across all selected patterns.`);
        window.alert(t('testAnalysisCompleteToastDesc', {count: allMatchedStars.length, fileName: testImage.file.name}));
        
        setIsAnalyzingTestImage(false);
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
    if (window.confirm(`Are you sure you want to delete the pattern "${learnedPatterns[patternId].sourceImageFileName}"? This cannot be undone.`)) {
        setLearnedPatterns(prevPatterns => {
            const newPatterns = { ...prevPatterns };
            delete newPatterns[patternId];
            saveLearnedPatterns(newPatterns);
            return newPatterns;
        });
        
        setSelectedPatternIDs(prevSelected => {
            const newSelectedIDs = new Set(prevSelected);
            newSelectedIDs.delete(patternId);
            return newSelectedIDs;
        });
        
        addLog(`Pattern ${patternId} deleted.`);
    }
  };
  
  const handleExportPatterns = () => {
    if (Object.keys(learnedPatterns).length === 0) {
        window.alert(t('noPatternsToExport'));
        return;
    }
    const dataToExport = {
      patterns: learnedPatterns,
      categories: starCategories,
    };
    const dataStr = JSON.stringify(dataToExport, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'astrostacker_patterns_and_categories.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    addLog("Exported all learned patterns and categories.");
  };

  const handleImportPatterns = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const file = files[0];
    const reader = new FileReader();

    reader.onload = (event) => {
        try {
            const content = event.target?.result as string;
            if (!content) throw new Error("File is empty or could not be read.");
            
            const importedData = JSON.parse(content);
            const importedPatterns = importedData.patterns;
            const importedCategories = importedData.categories;

            if (!importedPatterns || !importedCategories) {
              throw new Error("Invalid file format. Must contain 'patterns' and 'categories' keys.");
            }

            // Import Categories
            if (Array.isArray(importedCategories)) {
              setStarCategories(importedCategories);
              saveStarCategories(importedCategories);
              addLog(`Imported ${importedCategories.length} star categories.`);
            }

            // Import Patterns
            if (typeof importedPatterns === 'object' && importedPatterns !== null) {
              setLearnedPatterns(prev => {
                  const newPatterns = { ...prev, ...importedPatterns };
                  saveLearnedPatterns(newPatterns);
                  const newCount = Object.keys(importedPatterns).length;
                  addLog(`Imported ${newCount} patterns.`);
                  window.alert(`Import successful: ${newCount} patterns and ${importedCategories.length} categories loaded.`);
                  return newPatterns;
              });
            }

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
  }, [t]);
  

  type Sample = {
    features: number[];
    label: string; // Now the categoryId
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

  async function trainClientModel(samples: Sample[], categoriesForModel: StarCategory[], epochs = 40, batchSize = 32) {
    if (samples.length === 0) throw new Error("No samples to train on.");

    const categoryIds = categoriesForModel.map(c => c.id);
    const categoryToIndex = new Map(categoryIds.map((id, i) => [id, i]));
    const numClasses = categoryIds.length;

    const X = samples.map(s => s.features);
    const y = samples.map(s => {
        const index = categoryToIndex.get(s.label);
        const oneHot = new Array(numClasses).fill(0);
        if (index !== undefined) {
            oneHot[index] = 1;
        }
        return oneHot;
    });

    const { norm, means, stds } = normalizeFeatures(X);
    const xs = tf.tensor2d(norm);
    const ys = tf.tensor2d(y);

    const split = Math.floor(norm.length * 0.8);
    const [xTrain, xTest] = [xs.slice([0, 0], [split, xs.shape[1]]), xs.slice([split, 0], [xs.shape[0] - split, xs.shape[1]])];
    const [yTrain, yTest] = [ys.slice([0, 0], [split, numClasses]), ys.slice([split, 0], [ys.shape[0] - split, numClasses])];

    const model = buildModel(numClasses);
    model.compile({ optimizer: tf.train.adam(0.001), loss: 'categoricalCrossentropy', metrics: ['accuracy'] });

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

    return { model, means, stds, categories: categoryIds, accuracy: finalEpochLogs.acc as number };
}


  const handleTrainModel = async () => {
      const activePatterns = Object.values(learnedPatterns).filter(p => selectedPatternIDs.has(p.id));
      if (activePatterns.length === 0) {
          window.alert("Please select at least one pattern to train the model.");
          return;
      }
      
      const allCharacteristics = activePatterns.flatMap(p => 
          p.characteristics.map(c => ({ ...c, categoryId: p.categoryId }))
      );

      if (allCharacteristics.length < 20) {
        window.alert(`Need at least 20 star samples across all selected patterns to train. You have ${allCharacteristics.length}.`);
        return;
      }

      // Get the unique categories from the selected patterns
      const categoriesInUseIds = new Set(activePatterns.map(p => p.categoryId));
      const categoriesForModel = starCategories.filter(c => categoriesInUseIds.has(c.id));
      
      addLog(`[TRAIN] Starting model training with ${allCharacteristics.length} star samples across ${categoriesForModel.length} categories.`);
      setIsTrainingModel(true);
      
      try {
        const samples: Sample[] = allCharacteristics.map(c => ({
          features: featuresFromCharacteristics(c),
          label: c.categoryId,
        }));
        
        const { model, means, stds, categories, accuracy } = await trainClientModel(samples, categoriesForModel);
        
        setTrainedModel(model);
        setModelNormalization({ means, stds });
        setModelCategories(categories);
        
        await model.save(TF_MODEL_STORAGE_KEY);
        localStorage.setItem('astrostacker-model-normalization', JSON.stringify({ means, stds }));
        localStorage.setItem('astrostacker-model-categories', JSON.stringify(categories));


        addLog(`[TRAIN] Training successful! Accuracy: ${accuracy ? (accuracy * 100).toFixed(2) : 'N/A'}%. Model is saved and ready.`);
        window.alert("AI Model trained successfully and is ready for use.");

      } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          addLog(`[TRAIN ERROR] ${errorMessage}`);
          window.alert(`Model training failed: ${errorMessage}`);
      } finally {
          setIsTrainingModel(false);
      }
  };

  const handleResetModel = async () => {
    if (!trainedModel) {
        window.alert("No trained model to reset.");
        return;
    }
    if (window.confirm("Are you sure you want to reset the AI model? All training progress will be lost and the model will be removed from your browser's storage.")) {
        try {
            await tf.io.removeModel(TF_MODEL_STORAGE_KEY);
            localStorage.removeItem('astrostacker-model-normalization');
            localStorage.removeItem('astrostacker-model-categories');
            setTrainedModel(null);
            setModelNormalization(null);
            setModelCategories(null);
            addLog("[AI-CLIENT] Trained model has been successfully reset and removed from storage.");
            window.alert("AI model has been reset.");
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            addLog(`[AI-CLIENT ERROR] Could not reset the model: ${errorMessage}`);
            window.alert(`Failed to reset the model: ${errorMessage}`);
        }
    }
  };

  const imageForAnnotation = allImageStarData.find(img => img.id === manualSelectImageId);
  const canStartStacking = allImageStarData.length >= 2 && allImageStarData.every(img => img.isAnalyzed);
  const isUiDisabled = isProcessingStack || isTrainingModel || isServerProcessing || allImageStarData.some(img => img.isAnalyzing);
  const currentYear = new Date().getFullYear();

  const mainPreviewUrl = (showPostProcessEditor ? editedPreviewUrl : stackedImage) || null;

  const handleAiLearnFromManualSelection = async () => {
    if (manualSelectedStars.length === 0) {
      window.alert("Please select at least one star to define a pattern.");
      return;
    }

    const imageToLearnFrom = allImageStarData.find(img => img.id === manualSelectImageId);
    if (!imageToLearnFrom || !imageToLearnFrom.imageData) return;

    // Group stars by category
    const starsByCategory: { [key: string]: Star[] } = {};
    for (const star of manualSelectedStars) {
      if (!starsByCategory[star.categoryId]) {
        starsByCategory[star.categoryId] = [];
      }
      starsByCategory[star.categoryId].push(star);
    }

    const { data, width, height } = imageToLearnFrom.imageData;
    let patternsLearnedCount = 0;

    for (const categoryId in starsByCategory) {
        const starsInCat = starsByCategory[categoryId];
        if (starsInCat.length === 0) continue;

        const newCharacteristics = await extractCharacteristicsFromImage({
          stars: starsInCat,
          imageData: { data: Array.from(data), width, height }
        });

        // Use the image file name + category ID as a unique pattern ID
        const patternId = `${imageToLearnFrom.file.name}::${categoryId}`;
        const categoryName = starCategories.find(c => c.id === categoryId)?.name || categoryId;

        const newPattern: LearnedPattern = {
          id: patternId,
          sourceImageFileName: imageToLearnFrom.file.name,
          categoryId: categoryId,
          timestamp: Date.now(),
          characteristics: newCharacteristics,
        };

        setLearnedPatterns(prev => {
            const updatedPatterns = { ...prev };
            if(updatedPatterns[patternId] && !window.confirm(`A pattern for category '${categoryName}' from this image already exists. Overwrite it?`)) {
                addLog(`Skipped overwriting pattern for ${categoryName}.`);
                return updatedPatterns;
            }
            updatedPatterns[patternId] = newPattern;
            saveLearnedPatterns(updatedPatterns);
            addLog(`Pattern Learned: '${categoryName}' from ${imageToLearnFrom.file.name} with ${newCharacteristics.length} stars.`);
            patternsLearnedCount++;
            return updatedPatterns;
        });

         setSelectedPatternIDs(prevSelected => {
            const newSet = new Set(prevSelected);
            newSet.add(patternId);
            return newSet;
        });
    }

    if (patternsLearnedCount > 0) {
        window.alert(`${patternsLearnedCount} star pattern(s) learned and saved.`);
    }
    handleConfirmManualSelection(); // Save for alignment and close editor
  };

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <AppHeader onTutorialClick={() => setIsTutorialOpen(true)} />
      <main className="flex-grow container mx-auto py-6 px-2 sm:px-4 md:px-6">
        <div className="flex flex-col lg:flex-row gap-6 mt-6">
          <div className="w-full lg:w-2/5 xl:w-1/3 space-y-6">
            <Card className="shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center text-xl font-headline"><StarIcon className="mr-2 h-5 w-5 text-accent" />{t('uploadAndConfigure')}</CardTitle>
                <CardDescription className="text-sm max-h-32 overflow-y-auto">{t('cardDescription')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Tabs defaultValue="local" className="w-full">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="local"><Upload className="mr-2 h-4 w-4" /> From Device</TabsTrigger>
                    <TabsTrigger value="url"><Server className="mr-2 h-4 w-4" /> From URLs</TabsTrigger>
                  </TabsList>
                  <TabsContent value="local" className="mt-4 space-y-4">
                     <ImageUploadArea onFilesAdded={handleFilesAdded} isProcessing={isUiDisabled || !isFileApiReady} multiple={true} accept={{ 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.tiff', '.tif', '.fits', '.fit'] }} />
                  </TabsContent>
                  <TabsContent value="url" className="mt-4">
                     <form ref={formRef} action={formAction} onSubmit={() => setIsServerProcessing(true)} className="space-y-4">
                        <Label htmlFor="url-input">Image URLs</Label>
                        <Textarea
                            id="url-input"
                            name="imageUrls"
                            placeholder="https://.../image1.jpg&#10;https://.../image2.fits"
                            rows={5}
                            disabled={isUiDisabled}
                        />
                        <input type="hidden" name="alignmentMethod" value={alignmentMethod} />
                        <input type="hidden" name="stackingMode" value={stackingMode} />
                        <Button type="submit" disabled={isUiDisabled} className="w-full">
                            {isServerProcessing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Server className="mr-2 h-4 w-4" />}
                            Stack from URLs
                        </Button>
                     </form>
                  </TabsContent>
                </Tabs>
                
                <Accordion type="multiple" className="w-full">
                  <AccordionItem value="darks">
                    <AccordionTrigger>
                      <div className="flex items-center gap-2">
                        <Moon className="h-5 w-5" />
                        <div>
                          <p>Dark Frames ({darkFrames.length})</p>
                          <span className="text-xs text-muted-foreground font-normal">Optional - for thermal noise</span>
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="space-y-2">
                      <div className="flex items-center space-x-2">
                        <Switch id="use-darks" checked={useDarks} onCheckedChange={setUseDarks} disabled={isUiDisabled || darkFrames.length === 0} />
                        <Label htmlFor="use-darks">{t('useDarkFramesLabel')}</Label>
                      </div>
                      <ImageUploadArea onFilesAdded={(f) => handleCalibrationFilesAdded(f, 'dark')} isProcessing={isUiDisabled || !isFileApiReady} multiple={true} />
                      {darkFrames.length > 0 && 
                        <ScrollArea className="h-32">
                          <div className="grid grid-cols-2 gap-2 p-1">
                            {darkFrames.map(f => (
                              <div key={f.id} className="relative">
                                <NextImage src={f.previewUrl} alt={f.file.name} width={100} height={60} className="rounded-md object-cover" />
                                <Button size="icon" variant="destructive" className="absolute top-1 right-1 h-6 w-6" onClick={() => setDarkFrames(p => p.filter(i => i.id !== f.id))}><X className="h-4 w-4"/></Button>
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                      }
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="flats">
                    <AccordionTrigger>
                      <div className="flex items-center gap-2">
                        <Sun className="h-5 w-5" />
                        <div>
                          <p>Flat Frames ({flatFrames.length})</p>
                          <span className="text-xs text-muted-foreground font-normal">Optional - for dust/vignetting</span>
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="space-y-2">
                      <div className="flex items-center space-x-2">
                        <Switch id="use-flats" checked={useFlats} onCheckedChange={setUseFlats} disabled={isUiDisabled || flatFrames.length === 0} />
                        <Label htmlFor="use-flats">{t('useFlatFramesLabel')}</Label>
                      </div>
                      <ImageUploadArea onFilesAdded={(f) => handleCalibrationFilesAdded(f, 'flat')} isProcessing={isUiDisabled || !isFileApiReady} multiple={true} />
                      {flatFrames.length > 0 && 
                        <ScrollArea className="h-32">
                          <div className="grid grid-cols-2 gap-2 p-1">
                            {flatFrames.map(f => (
                              <div key={f.id} className="relative">
                                <NextImage src={f.previewUrl} alt={f.file.name} width={100} height={60} className="rounded-md object-cover" />
                                <Button size="icon" variant="destructive" className="absolute top-1 right-1 h-6 w-6" onClick={() => setFlatFrames(p => p.filter(i => i.id !== f.id))}><X className="h-4 w-4"/></Button>
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                      }
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="bias">
                    <AccordionTrigger>
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5" />
                        <div>
                          <p>Bias Frames ({biasFrames.length})</p>
                          <span className="text-xs text-muted-foreground font-normal">Optional - for read-out noise</span>
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="space-y-2">
                      <div className="flex items-center space-x-2">
                        <Switch id="use-bias" checked={useBias} onCheckedChange={setUseBias} disabled={isUiDisabled || biasFrames.length === 0} />
                        <Label htmlFor="use-bias">{t('useBiasFramesLabel')}</Label>
                      </div>
                      <ImageUploadArea onFilesAdded={(f) => handleCalibrationFilesAdded(f, 'bias')} isProcessing={isUiDisabled || !isFileApiReady} multiple={true} />
                      {biasFrames.length > 0 && 
                        <ScrollArea className="h-32">
                          <div className="grid grid-cols-2 gap-2 p-1">
                            {biasFrames.map(f => (
                              <div key={f.id} className="relative">
                                <NextImage src={f.previewUrl} alt={f.file.name} width={100} height={60} className="rounded-md object-cover" />
                                <Button size="icon" variant="destructive" className="absolute top-1 right-1 h-6 w-6" onClick={() => setBiasFrames(p => p.filter(i => i.id !== f.id))}><X className="h-4 w-4"/></Button>
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                      }
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>


                {(isProcessingStack || isServerProcessing) && progressPercent > 0 && (
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
                            key={entry.id} id={entry.id} index={index} file={entry.file} previewUrl={entry.analysisPreviewUrl}
                            isAnalyzing={entry.isAnalyzing} onRemove={() => handleRemoveImage(entry.id)}
                            onManualSelectToggle={() => handleManualSelectToggle(entry.id)} isProcessing={isUiDisabled}
                            isAnalyzed={entry.isAnalyzed} 
                            isManualSelectMode={manualSelectImageId === entry.id}
                            manualStarCount={entry.manualStars.length}
                          />
                        ))}
                      </div>
                    </ScrollArea>
                  </>
                )}
                {manualSelectImageId && imageForAnnotation && (
                  <Card className="mt-2 bg-muted/20">
                    <CardHeader className="p-3"><CardTitle className="text-base">Manual Star Selection</CardTitle>
                      <CardDescription className="text-xs">Now editing: {imageForAnnotation.file.name}. Click a category, then click on stars.</CardDescription>
                    </CardHeader>
                     <CardContent className="p-3 space-y-2">
                      <div className="grid grid-cols-5 gap-2">
                        {starCategories.map(cat => (
                          <Button 
                            key={cat.id}
                            size="icon"
                            variant={activeCategoryId === cat.id ? 'default' : 'outline'}
                            onClick={() => setActiveCategoryId(cat.id)}
                            className="h-8 w-8"
                            style={{ backgroundColor: activeCategoryId === cat.id ? cat.color : undefined, borderColor: cat.color }}
                            title={cat.name}
                          >
                          </Button>
                        ))}
                      </div>
                    </CardContent>
                    <CardFooter className="p-3 flex flex-col gap-2">
                       <Button onClick={handleConfirmManualSelection} className="w-full" variant="secondary"><CheckCircle className="mr-2 h-4 w-4" />Confirm Selections</Button>
                      <Button onClick={handleAiLearnFromManualSelection} className="w-full" variant="outline" size="sm"><BrainCircuit className="mr-2 h-4 w-4"/>Confirm & Also Teach AI</Button>
                       <Button onClick={handleWipeAllStars} className="w-full" variant="destructive" size="sm"><Eraser className="mr-2 h-4 w-4" />Wipe All Stars</Button>
                      <Button onClick={() => {setManualSelectImageId(null); setManualSelectedStars([]);}} className="w-full"><X className="mr-2 h-4 w-4" />Cancel</Button>
                    </CardFooter>
                  </Card>
                )}
              </CardContent>
            </Card>
          </div>
          <div className="w-full lg:w-3/5 xl:w-2/3 flex flex-col space-y-6">
            <div className="flex-grow">
              {imageForAnnotation ? (
                  <StarAnnotationCanvas imageUrl={imageForAnnotation.analysisPreviewUrl} allStars={imageForAnnotation.detectedStars} manualStars={manualSelectedStars} onCanvasClick={handleStarAnnotationClick} analysisWidth={imageForAnnotation.analysisDimensions.width} analysisHeight={imageForAnnotation.analysisDimensions.height} categories={starCategories} />
              ) : testImage ? (
                  <StarAnnotationCanvas imageUrl={testImage.analysisPreviewUrl} allStars={testImage.detectedStars} manualStars={testImageMatchedStars} onCanvasClick={() => {}} analysisWidth={testImage.analysisDimensions.width} analysisHeight={testImage.analysisDimensions.height} categories={starCategories} isReadOnly={true} />
              ) : (
                  <ImagePreview imageUrl={mainPreviewUrl} fitMode={previewFitMode} />
              )}
            </div>
            {stackedImage && (
              <Card className="bg-background/50">
                <CardContent className="p-4 space-y-4">
                    <Button onClick={handleOpenPostProcessEditor} className="w-full" variant="outline" size="lg" disabled={isUiDisabled}><Wand2 className="mr-2 h-5 w-5" />{t('finalizeAndDownload')}</Button>
                </CardContent>
              </Card>
            )}
            <div className="space-y-4 pt-4">
                <div className="space-y-2"><Label className="text-base font-semibold text-foreground">Alignment Method</Label>
                  <RadioGroup value={alignmentMethod} onValueChange={(v) => setAlignmentMethod(v as AlignmentMethod)} className="grid grid-cols-2 gap-x-2 gap-y-2" disabled={isUiDisabled}>
                    <div className="flex items-center space-x-1"><RadioGroupItem value="standard" id="align-standard" /><Label htmlFor="align-standard" className="flex items-center gap-1"><StarIcon className="h-4 w-4"/>Standard (Deep Sky)</Label></div>
                    <div className="flex items-center space-x-1"><RadioGroupItem value="consensus" id="align-consensus" /><Label htmlFor="align-consensus" className="flex items-center gap-1"><Sparkles className="h-4 w-4"/>Consensus (Deep Sky)</Label></div>
                    <div className="flex items-center space-x-1"><RadioGroupItem value="planetary" id="align-planetary" /><Label htmlFor="align-planetary" className="flex items-center gap-1"><Globe className="h-4 w-4"/>Planetary (Surface)</Label></div>
                     <div className="flex items-center space-x-1"><RadioGroupItem value="dumb" id="align-dumb" /><Label htmlFor="align-dumb" className="flex items-center gap-1"><Puzzle className="h-4 w-4"/>Dumb (White Pixel)</Label></div>
                  </RadioGroup>
                   {alignmentMethod === 'planetary' && (
                    <div className="space-y-2 pl-2 pt-2 border-l-2 border-accent/50 ml-2">
                        <Label htmlFor="planetaryQualitySlider">Stack Top {planetaryStackingQuality}% of Frames</Label>
                        <Slider id="planetaryQualitySlider" min={1} max={100} step={1} value={[planetaryStackingQuality]} onValueChange={(v) => setPlanetaryStackingQuality(v[0])} disabled={isUiDisabled} />
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label className="text-base font-semibold text-foreground">Star Detection Method</Label>
                  <RadioGroup value={starDetectionMethod} onValueChange={(v) => setStarDetectionMethod(v as StarDetectionMethod)} className="grid grid-cols-2 gap-x-2 gap-y-2" disabled={isUiDisabled}>
                      <div className="flex items-center space-x-2"><RadioGroupItem value="general" id="detect-general" /><Label htmlFor="detect-general" className="flex items-center gap-1"><ShieldOff className="h-4 w-4"/>General</Label></div>
                      <div className="flex items-center space-x-2"><RadioGroupItem value="advanced" id="detect-advanced" /><Label htmlFor="detect-advanced" className="flex items-center gap-1"><Zap className="h-4 w-4"/>Advanced (Siril-like)</Label></div>
                      <div className="flex items-center space-x-2"><RadioGroupItem value="ai" id="detect-ai" disabled={!trainedModel} /><Label htmlFor="detect-ai" className={`flex items-center gap-1 ${!trainedModel ? 'text-muted-foreground' : ''}`}><BrainCircuit className="h-4 w-4"/>AI {!trainedModel && '(Train model first)'}</Label></div>
                  </RadioGroup>
                </div>


                 <div className="space-y-2"><Label className="text-base font-semibold text-foreground">Stacking Quality</Label>
                  <RadioGroup value={stackingQuality} onValueChange={(v) => setStackingQuality(v as StackingQuality)} className="flex space-x-2" disabled={isUiDisabled}>
                    <div className="flex items-center space-x-1"><RadioGroupItem value="standard" id="quality-standard" /><Label htmlFor="quality-standard" className="flex items-center gap-1"><Zap className="h-4 w-4"/>Standard (Fast)</Label></div>
                    <div className="flex items-center space-x-1"><RadioGroupItem value="high" id="quality-high" /><Label htmlFor="quality-high" className="flex items-center gap-1"><Diamond className="h-4 w-4"/>High Quality (Slow)</Label></div>
                  </RadioGroup>
                </div>
                <div className="space-y-2"><Label className="text-base font-semibold text-foreground">{t('stackingMode')}</Label>
                  <RadioGroup value={stackingMode} onValueChange={(v) => setStackingMode(v as StackingMode)} className="grid grid-cols-2 gap-2" disabled={isUiDisabled}>
                    <div className="flex items-center space-x-1"><RadioGroupItem value="median" id="mode-median" /><Label htmlFor="mode-median">Median</Label></div>
                    <div className="flex items-center space-x-1"><RadioGroupItem value="sigma" id="mode-sigma" /><Label htmlFor="mode-sigma">Sigma Clip</Label></div>
                    <div className="flex items-center space-x-1"><RadioGroupItem value="laplacian" id="mode-laplacian" /><Label htmlFor="mode-laplacian">Planetary (Sharpen)</Label></div>
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
          </div>
        </div>

        <div className="flex flex-col lg:flex-row gap-6 mt-6">
          <div className="w-full lg:w-2/5 xl:w-1/3 space-y-6">
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
          </div>
          <div className="w-full lg:w-3/5 xl:w-2/3 space-y-6">
              <Card>
                  <CardHeader><CardTitle className="flex items-center"><BrainCircuit className="mr-2 h-5 w-5" />{t('learningModeCardTitle')}</CardTitle><CardDescription>{t('learningModeCardDescription')}</CardDescription></CardHeader>
                  <CardContent className="space-y-4">
                      <Accordion type="single" collapsible>
                        <AccordionItem value="categories">
                          <AccordionTrigger><Palette className="mr-2 h-4 w-4" />Star Categories</AccordionTrigger>
                          <AccordionContent className="space-y-3 pt-2">
                             {starCategories.map(cat => (
                              <div key={cat.id} className="flex items-center gap-2">
                                <div className="h-6 w-6 rounded-full border-2" style={{backgroundColor: cat.color}}></div>
                                <Input 
                                  value={cat.name} 
                                  onChange={(e) => handleCategoryNameChange(cat.id, e.target.value)}
                                  className="h-8"
                                />
                              </div>
                             ))}
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>
                  
                      <div className="grid grid-cols-2 gap-4 mb-4">
                        <Button onClick={handleExportPatterns} disabled={Object.keys(learnedPatterns).length === 0}><Download className="mr-2 h-4 w-4" />{t('exportPatternsButton')}</Button>
                        <ImageUploadArea onFilesAdded={handleImportPatterns} isProcessing={isUiDisabled} multiple={false} accept={{ 'application/json': ['.json'] }} dropzoneText={t('importPatternsDropzone')} buttonText={t('importPatternsButton')} />
                      </div>
                      <div className="flex gap-4 mb-4">
                       <Button onClick={handleTrainModel} disabled={isUiDisabled || selectedPatternIDs.size === 0} className="w-full">
                          {isTrainingModel ? <><Loader2 className="mr-2 h-4 w-4 animate-spin"/>{t('trainingModelButton')}</> : <><Cpu className="mr-2 h-4 w-4" />{t('trainModelButton')}</>}
                      </Button>
                      <Button onClick={handleResetModel} disabled={isUiDisabled || !trainedModel} variant="destructive" className="w-full">
                        <RotateCcw className="mr-2 h-4 w-4"/> Reset AI Model
                      </Button>
                      </div>
                      {trainedModel && <Alert variant="default" className="mb-4"><AlertCircle className="h-4 w-4" /><AlertTitle>Model Ready</AlertTitle><AlertDescription>An AI model is trained and ready. The 'Consensus' alignment method will be enhanced by this for better star recognition.</AlertDescription></Alert>}

                      <h4 className="font-semibold mb-2">{t('allLearnedPatternsListTitle')}</h4>
                      {Object.keys(learnedPatterns).length === 0 ? (<p className="text-sm text-muted-foreground">{t('noPatternLearnedYetInfo')}</p>) : (
                          <ScrollArea className="h-40 border rounded-md p-2">
                              {Object.values(learnedPatterns).map(p => {
                                const category = starCategories.find(c => c.id === p.categoryId);
                                return (
                                  <div key={p.id} className="flex items-center justify-between p-2 rounded-md hover:bg-muted/50">
                                      <div className="flex items-center gap-2">
                                          <Checkbox id={`pattern-${p.id}`} checked={selectedPatternIDs.has(p.id)} onCheckedChange={(checked) => handlePatternSelectionChange(p.id, !!checked)} />
                                          <div className='flex items-center gap-2'>
                                              <div className="h-4 w-4 rounded-full" style={{backgroundColor: category?.color}}></div>
                                              <div>
                                                  <label htmlFor={`pattern-${p.id}`} className="font-medium text-sm cursor-pointer">{p.sourceImageFileName} - {category?.name}</label>
                                                  <p className="text-xs text-muted-foreground"> {p.characteristics.length} stars. Learned on {new Date(p.timestamp).toLocaleDateString()}</p>
                                              </div>
                                          </div>
                                      </div>
                                      <Button variant="ghost" size="icon" className="h-7 w-7 z-10" onClick={() => deletePattern(p.id)}><Trash2 className="h-4 w-4 text-destructive"/></Button>
                                  </div>
                                )
                              })}
                          </ScrollArea>
                      )}
                  </CardContent>
              </Card>

              <Card>
                  <CardHeader><CardTitle className="flex items-center"><TestTube2 className="mr-2 h-5 w-5" />{t('learnTestCardTitle')}</CardTitle><CardDescription>{t('learnTestCardDescription')}</CardDescription></CardHeader>
                  <CardContent className="space-y-4">
                      <ImageUploadArea onFilesAdded={handleTestFileAdded} isProcessing={isAnalyzingTestImage || isUiDisabled || !isFileApiReady} multiple={false} />
                      <Button onClick={runPatternTest} disabled={isAnalyzingTestImage || isUiDisabled || !testImage || selectedPatternIDs.size === 0} className="w-full">
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
        <ImagePostProcessEditor
          isOpen={showPostProcessEditor}
          onClose={() => setShowPostProcessEditor(false)}
          baseImageUrl={imageForPostProcessing}
          editedImageUrl={editedPreviewUrl}
          isAdjusting={isApplyingAdjustments}
          outputFormat={outputFormat}
          jpegQuality={jpegQuality}
          onResetAdjustments={handleResetAdjustments}
          basicSettings={{ brightness, exposure, saturation }}
          onBasicSettingsChange={({ brightness, exposure, saturation }) => {
            setBrightness(brightness);
            setExposure(exposure);
            setSaturation(saturation);
          }}
          histogramSettings={{ blackPoint, midtones, whitePoint }}
          onHistogramSettingsChange={({ blackPoint, midtones, whitePoint }) => {
            setBlackPoint(blackPoint);
            setMidtones(midtones);
            setWhitePoint(whitePoint);
          }}
        />
      )}
    </div>
  );
}

    

    
