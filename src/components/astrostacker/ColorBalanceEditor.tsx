
"use client";

import type React from 'react';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ColorBalance, Rgb } from '@/types';

interface ColorBalanceEditorProps {
  balance: ColorBalance;
  onBalanceChange: (newBalance: ColorBalance) => void;
}

type Tone = 'shadows' | 'midtones' | 'highlights';

const ColorSlider = ({
  value,
  onChange,
  color,
  labels,
}: {
  value: number;
  onChange: (newValue: number) => void;
  color: string;
  labels: [string, string];
}) => (
  <div className="grid grid-cols-5 items-center gap-2">
    <Label className="text-xs text-right col-span-1">{labels[0]}</Label>
    <Slider
      value={[value]}
      onValueChange={([v]) => onChange(v)}
      min={-100}
      max={100}
      step={1}
      className="col-span-3"
      style={{ '--slider-color': color } as React.CSSProperties}
    />
    <Label className="text-xs col-span-1">{labels[1]}</Label>
  </div>
);

export function ColorBalanceEditor({ balance, onBalanceChange }: ColorBalanceEditorProps) {
  
  const handleSliderChange = (tone: Tone, channel: keyof Rgb, value: number) => {
    onBalanceChange({
      ...balance,
      [tone]: {
        ...balance[tone],
        [channel]: value,
      },
    });
  };

  const renderToneControls = (tone: Tone) => (
    <div className="space-y-4">
      <ColorSlider
        value={balance[tone].r}
        onChange={(v) => handleSliderChange(tone, 'r', v)}
        color="hsl(0, 80%, 60%)"
        labels={['Cyan', 'Red']}
      />
      <ColorSlider
        value={balance[tone].g}
        onChange={(v) => handleSliderChange(tone, 'g', v)}
        color="hsl(120, 80%, 60%)"
        labels={['Magenta', 'Green']}
      />
      <ColorSlider
        value={balance[tone].b}
        onChange={(v) => handleSliderChange(tone, 'b', v)}
        color="hsl(240, 80%, 60%)"
        labels={['Yellow', 'Blue']}
      />
    </div>
  );

  return (
    <div className="space-y-4">
       <style>{`
        .color-balance-slider .slider-track { background-color: #333; }
        .color-balance-slider .slider-range { background-color: var(--slider-color); }
        .color-balance-slider .slider-thumb { border-color: var(--slider-color); }
      `}</style>
      <Tabs defaultValue="midtones">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="shadows">Shadows</TabsTrigger>
          <TabsTrigger value="midtones">Midtones</TabsTrigger>
          <TabsTrigger value="highlights">Highlights</TabsTrigger>
        </TabsList>
        <TabsContent value="shadows" className="mt-4">
          {renderToneControls('shadows')}
        </TabsContent>
        <TabsContent value="midtones" className="mt-4">
          {renderToneControls('midtones')}
        </TabsContent>
        <TabsContent value="highlights" className="mt-4">
          {renderToneControls('highlights')}
        </TabsContent>
      </Tabs>
    </div>
  );
}

    