"use client";

import type React from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface ParameterControlsProps {
  alignmentMethod: string;
  setAlignmentMethod: (method: 'auto' | 'star_alignment' | 'manual') => void;
  stackingMode: string;
  setStackingMode: (mode: 'average' | 'lighten' | 'darken') => void;
  onAdjust: () => void;
  isProcessing: boolean;
  hasBaseImage: boolean;
}

const alignmentOptions = [
  { value: 'auto', label: 'Auto Detect' },
  { value: 'star_alignment', label: 'Star Alignment' },
  { value: 'manual', label: 'Manual (Advanced)' },
];

const stackingModeOptions = [
  { value: 'average', label: 'Average' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'darken', label: 'Darken' },
];

export function ParameterControls({
  alignmentMethod,
  setAlignmentMethod,
  stackingMode,
  setStackingMode,
  onAdjust,
  isProcessing,
  hasBaseImage,
}: ParameterControlsProps) {
  return (
    <Card className="shadow-lg">
      <CardHeader>
        <CardTitle className="flex items-center text-xl font-headline">
          <SlidersHorizontal className="mr-2 h-5 w-5 text-accent" />
          Adjust Parameters
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="alignmentMethod" className="font-medium">Alignment Method</Label>
          <Select
            value={alignmentMethod}
            onValueChange={(value) => setAlignmentMethod(value as 'auto' | 'star_alignment' | 'manual')}
            disabled={isProcessing || !hasBaseImage}
            
          >
            <SelectTrigger id="alignmentMethod" className="w-full">
              <SelectValue placeholder="Select alignment method" />
            </SelectTrigger>
            <SelectContent>
              {alignmentOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="stackingMode" className="font-medium">Stacking Mode</Label>
          <Select
            value={stackingMode}
            onValueChange={(value) => setStackingMode(value as 'average' | 'lighten' | 'darken')}
            disabled={isProcessing || !hasBaseImage}
          >
            <SelectTrigger id="stackingMode" className="w-full">
              <SelectValue placeholder="Select stacking mode" />
            </SelectTrigger>
            <SelectContent>
              {stackingModeOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        
        {/* Preset buttons example (can be expanded) */}
        {/* <div className="space-y-2">
          <Label className="font-medium">Presets</Label>
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={() => { setAlignmentMethod('auto'); setStackingMode('average'); }} disabled={isProcessing || !hasBaseImage}>Default</Button>
            <Button variant="outline" size="sm" onClick={() => { setAlignmentMethod('star_alignment'); setStackingMode('lighten'); }} disabled={isProcessing || !hasBaseImage}>Sharpen</Button>
          </div>
        </div> */}

        <Button
          onClick={onAdjust}
          disabled={isProcessing || !hasBaseImage}
          className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          {isProcessing ? 'Adjusting...' : 'Apply Adjustments'}
        </Button>
      </CardContent>
    </Card>
  );
}
