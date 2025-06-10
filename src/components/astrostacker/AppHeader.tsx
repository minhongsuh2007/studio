
"use client"; // Added 'use client' for hooks
import { Rocket } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext'; // Added import
import { Button } from '@/components/ui/button'; // Added import
import type { Locale } from '@/lib/translations'; // Added import

export function AppHeader() {
  const { language, setLanguage, t } = useLanguage(); // Added hook usage

  const handleLanguageChange = (lang: Locale) => {
    setLanguage(lang);
  };

  return (
    <header className="py-4 px-6 border-b border-border sticky top-0 bg-background/80 backdrop-blur-md z-10">
      <div className="container mx-auto flex items-center justify-between"> {/* Changed to justify-between */}
        <div className="flex items-center gap-2">
          <Rocket className="h-7 w-7 text-accent" />
          <h1 className="text-2xl font-headline font-semibold text-foreground">
            {t('appTitle')} {/* Translated title */}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={language === 'en' ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleLanguageChange('en')}
            className="text-xs px-2 py-1 h-auto"
          >
            {t('switchToEnglish')}
          </Button>
          <Button
            variant={language === 'ko' ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleLanguageChange('ko')}
            className="text-xs px-2 py-1 h-auto"
          >
            {t('switchToKorean')}
          </Button>
          <Button
            variant={language === 'zh' ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleLanguageChange('zh')}
            className="text-xs px-2 py-1 h-auto"
          >
            {t('switchToChinese')}
          </Button>
        </div>
      </div>
    </header>
  );
}

    
