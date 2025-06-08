
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
    cardDescription: "Add PNG, JPG, GIF, or WEBP. Images are aligned using star centroids or brightness. Optionally downscale large images on upload. Stacking uses processed resolution. Median or Sigma Clip methods available.",
    creditsLine1: 'AstroStacker © {year}',
    creditsLine2Part1: 'Created by Min Hong Seo (암흑광자) with invaluable help from 천관사, Saturn, 구구, Plex, Latte, 얼음세상, 뉴비, 오르트, 지민, and many others.',
    switchToEnglish: 'EN',
    switchToKorean: 'KO',
    stackImagesButton: 'Stack Images ({count})',
    stackingButtonInProgress: 'Stacking...',
    finalizeAndDownload: 'Finalize & Download Image',
    imageQueueCount: 'Image Queue ({count})',
    stackingMode: 'Stacking Mode',
    previewFit: 'Preview Fit',
    fitContain: 'Contain',
    fitCover: 'Cover',
    outputFormat: 'Output Format',
    jpgQuality: 'JPG Quality: {jpegQuality}%',
    editStarsFor: 'Edit Stars for: {fileName}',
    editStarsDescription: 'Click on stars to add/remove. Current: {starCount} stars. Image Dim: {width}x{height}.',
    resetToAuto: 'Reset to Auto',
    wipeAllStars: 'Wipe All Stars',
    confirmAndClose: 'Confirm & Close',
    cancelEditing: 'Cancel Editing',
    processingLogs: 'Processing Logs',
    applyStarsToOther: 'Apply Star Selection to Other Images?',
    applyStarsDescription: "You've manually set {starCount} stars for '{fileName}' ({width}x{height}px). Apply this star selection to all {otherImageCount} other images in the queue that have matching dimensions? This will set them to Manual mode and mark them as reviewed.",
    noKeepIndividual: 'No, Keep Individual',
    yesApplyToAll: 'Yes, Apply to All Matching',
    downscalePrompt: "Image '{fileName}' ({width}x{height}px) is large. Downscaling it to max {maxSize}px (maintaining aspect ratio) can improve stability and speed. Downscale it?",
    stackingProgress: 'Stacking: {progressPercent}%',
  },
  ko: {
    appTitle: '아스트로스태커',
    uploadAndConfigure: '이미지 업로드 및 설정',
    cardDescription: "PNG, JPG, GIF 또는 WEBP 파일을 추가하세요. 이미지는 별 중심 또는 밝기 중심으로 정렬됩니다. 업로드 시 큰 이미지를 선택적으로 축소할 수 있습니다. 스태킹은 처리된 해상도를 사용합니다. 중간값 또는 시그마 클립 방법을 사용할 수 있습니다.",
    creditsLine1: '아스트로스태커 © {year}',
    creditsLine2Part1: '천관사님, 새턴님, 구구님, 플렉님, 라떼님, 얼음세상님, 늅님, 오르트님, 지민님, 그리고 다른 여러 분들의 도움으로 서민홍(암흑광자) 에 의해 제작되었습니다.',
    switchToEnglish: '영',
    switchToKorean: '한',
    stackImagesButton: '이미지 스태킹 ({count}개)',
    stackingButtonInProgress: '스태킹 중...',
    finalizeAndDownload: '이미지 확정 및 다운로드',
    imageQueueCount: '이미지 대기열 ({count}개)',
    stackingMode: '스태킹 모드',
    previewFit: '미리보기 맞춤',
    fitContain: '포함',
    fitCover: '채우기',
    outputFormat: '출력 형식',
    jpgQuality: 'JPG 품질: {jpegQuality}%',
    editStarsFor: '별 편집: {fileName}',
    editStarsDescription: '별을 클릭하여 추가/제거하세요. 현재: 별 {starCount}개. 이미지 크기: {width}x{height}.',
    resetToAuto: '자동으로 재설정',
    wipeAllStars: '모든 별 지우기',
    confirmAndClose: '확인 및 닫기',
    cancelEditing: '편집 취소',
    processingLogs: '처리 로그',
    applyStarsToOther: '다른 이미지에도 이 별 선택을 적용할까요?',
    applyStarsDescription: "'{fileName}'({width}x{height}px)에 대해 {starCount}개의 별을 수동으로 설정했습니다. 동일한 크기를 가진 대기열의 다른 {otherImageCount}개 이미지에도 이 별 선택을 적용하시겠습니까? 해당 이미지들은 수동 모드로 설정되고 검토된 것으로 표시됩니다.",
    noKeepIndividual: '아니요, 개별 유지',
    yesApplyToAll: '예, 일치하는 모든 항목에 적용',
    downscalePrompt: "이미지 '{fileName}' ({width}x{height}px)이(가) 큽니다. 최대 크기를 {maxSize}px로 축소(종횡비 유지)하면 안정성과 처리 속도를 향상시킬 수 있습니다. 축소하시겠습니까?",
    stackingProgress: '스태킹 진행률: {progressPercent}%',
  },
};

export const defaultLocale: Locale = 'en';

// Helper function to get translations, can be used in server components if needed
export const getTranslations = (locale: Locale) => translations[locale] || translations[defaultLocale];

