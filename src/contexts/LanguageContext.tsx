
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
  const [language, setLanguage] = useState<Locale>(() => {
    if (typeof window !== 'undefined') {
      const storedLang = localStorage.getItem('astrostacker-lang') as Locale;
      return storedLang && translations[storedLang] ? storedLang : defaultLocale;
    }
    return defaultLocale;
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('astrostacker-lang', language);
      document.documentElement.lang = language;
    }
  }, [language]);

  const t = useCallback((key: string, params?: Record<string, string | number | undefined>) => {
    let translationSet = translations[language] || translations[defaultLocale];
    let translatedText = translationSet[key] || key;
    
    if (params) {
      Object.keys(params).forEach(paramKey => {
        const value = params[paramKey];
        if (value !== undefined) {
          translatedText = translatedText.replace(`{${paramKey}}`, String(value));
        }
      });
    }
    return translatedText;
  }, [language]);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
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
