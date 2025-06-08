
export type Locale = 'en' | 'ko';

interface TranslationMessages {
  [key: string]: string;
}

interface Translations {
  en: TranslationMessages;
  ko: TranslationMessages;
}

export const translations: Translations = {
  en: {
    appTitle: 'AstroStacker',
    uploadAndConfigure: 'Upload & Configure Images',
    creditsLine1: 'AstroStacker © {year}',
    creditsLine2Part1: 'Created by Min Hong Seo (암흑광자) with invaluable help from 천관사, Saturn, 구구, Plex, Latte, 얼음세상, 뉴비, 오르트, 지민, and many others.',
    switchToEnglish: 'EN',
    switchToKorean: 'KO',
    stackImagesButton: 'Stack Images ({count})',
    finalizeAndDownload: 'Finalize & Download Image',
    imageQueueCount: 'Image Queue ({count})',
    cardDescription: "Add PNG, JPG, GIF, or WEBP. TIFF/DNG files require manual pre-conversion. Images are aligned using star-based centroids or brightness centroids. Star analysis and stacking use original image resolution. Large images may impact performance. Median stacking uses median pixel values. Sigma Clip removes outliers then averages.",
  },
  ko: {
    appTitle: '아스트로스태커',
    uploadAndConfigure: '이미지 업로드 및 설정',
    creditsLine1: '아스트로스태커 © {year}',
    creditsLine2Part1: '천관사님, 새턴님, 구구님, 플렉님, 라떼님, 얼음세상님, 늅님, 오르트님, 지민님, 그리고 다른 여러 분들의 도움으로 서민홍(암흑광자) 에 의해 제작되었습니다.',
    switchToEnglish: '영',
    switchToKorean: '한',
    stackImagesButton: '이미지 스태킹 ({count}개)',
    finalizeAndDownload: '이미지 확정 및 다운로드',
    imageQueueCount: '이미지 대기열 ({count}개)',
    cardDescription: "PNG, JPG, GIF 또는 WEBP 파일을 추가하세요. TIFF/DNG 파일은 수동 사전 변환이 필요합니다. 이미지는 별 기반 중심점 또는 밝기 중심점을 사용하여 정렬됩니다. 별 분석 및 스태킹은 원본 이미지 해상도를 사용합니다. 큰 이미지는 성능에 영향을 줄 수 있습니다. 중간값 스태킹은 중간 픽셀 값을 사용합니다. 시그마 클립은 이상치를 제거한 후 평균을 냅니다.",
  },
};

export const defaultLocale: Locale = 'en';
