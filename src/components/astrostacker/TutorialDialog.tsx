
"use client";

import type React from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { ScrollArea } from '../ui/scroll-area';

interface TutorialDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TutorialDialog({ isOpen, onClose }: TutorialDialogProps) {
  const { t } = useLanguage();

  const tutorialSteps = [
    { id: '1', titleKey: 'tutorialStep1Title', contentKey: 'tutorialStep1Content' },
    { id: '2', titleKey: 'tutorialStep2Title', contentKey: 'tutorialStep2Content' },
    { id: '3', titleKey: 'tutorialStep3Title', contentKey: 'tutorialStep3Content' },
    { id: '4', titleKey: 'tutorialStep4Title', contentKey: 'tutorialStep4Content' },
    { id: '5', titleKey: 'tutorialStep5Title', contentKey: 'tutorialStep5Content' },
  ];

  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl w-[90vw] h-auto max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('tutorialTitle')}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="flex-grow pr-6 min-h-0">
          <Accordion type="single" collapsible defaultValue="1" className="w-full">
            {tutorialSteps.map(step => (
              <AccordionItem value={step.id} key={step.id}>
                <AccordionTrigger>{t(step.titleKey)}</AccordionTrigger>
                <AccordionContent className="text-base text-muted-foreground whitespace-pre-wrap">
                  {t(step.contentKey)}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </ScrollArea>
        <DialogFooter className="mt-4 pt-4 border-t flex-shrink-0">
          <DialogClose asChild>
            <Button variant="outline" onClick={onClose}>Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
