
'use client';
import type React from 'react';
import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { translations, defaultLocale, type Locale } from '@/lib/translations';

interface LanguageContextType {
  language: Locale;
  setLanguage: (language: Locale) => void;
  t: (key: string, params?: Record<string, string | number | undefined>) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider = ({ children }: { children: React.ReactNode }) => {
  // Always initialize with defaultLocale to match server render
  const [language, setLanguageState] = useState<Locale>(defaultLocale);
  const [isMounted, setIsMounted] = useState(false); // Track mount status

  // Effect to set initial language from localStorage after mount
  useEffect(() => {
    setIsMounted(true); // Component has mounted
    const storedLang = localStorage.getItem('astrostacker-lang') as Locale;
    if (storedLang && translations[storedLang]) {
      setLanguageState(storedLang);
      document.documentElement.lang = storedLang;
    } else {
      // If no stored lang or invalid, ensure html lang attribute matches default
      document.documentElement.lang = defaultLocale;
    }
  }, []); // Empty dependency array: run once on mount

  // Effect to update localStorage and html lang attribute when language changes *after* initial mount
  useEffect(() => {
    if (isMounted) { // Only run after initial mount and language restoration
      localStorage.setItem('astrostacker-lang', language);
      document.documentElement.lang = language;
    }
  }, [language, isMounted]);

  const setLanguage = (newLanguage: Locale) => {
    setLanguageState(newLanguage);
  };

  const t = useCallback((key: string, params?: Record<string, string | number | undefined>) => {
    // If not mounted yet, always use defaultLocale to prevent mismatch during hydration
    const effectiveLanguage = isMounted ? language : defaultLocale;
    let translationSet = translations[effectiveLanguage] || translations[defaultLocale];
    let translatedText = translationSet[key] || key; // Fallback to key if not found
    
    // Check if translationSet actually has the key to avoid errors with missing translations
    if (!translationSet.hasOwnProperty(key) && translations[defaultLocale].hasOwnProperty(key)){
        translatedText = translations[defaultLocale][key] || key; // Fallback to default locale's translation then key
    } else if (!translationSet.hasOwnProperty(key)) {
        translatedText = key; // Final fallback to key if not in current or default
    }


    if (params) {
      Object.keys(params).forEach(paramKey => {
        const value = params[paramKey];
        if (value !== undefined) {
          translatedText = translatedText.replace(`{${paramKey}}`, String(value));
        }
      });
    }
    return translatedText;
  }, [language, isMounted]);

  // Before the component is mounted, the context value might reflect defaultLocale
  // to ensure hydration match. After mount, it uses the potentially loaded language.
  const contextValue = {
    language: isMounted ? language : defaultLocale,
    setLanguage,
    t
  };

  return (
    <LanguageContext.Provider value={contextValue}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
};

