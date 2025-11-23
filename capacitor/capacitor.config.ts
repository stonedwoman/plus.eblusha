import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'org.eblusha.plus',
  appName: 'Еблуша Plus',
  webDir: '../frontend/dist',
  server: {
    // По умолчанию используем ru.eblusha.org как источник веб-приложения
    url: 'https://ru.eblusha.org',
    cleartext: false,
    
    // Для разработки раскомментируйте:
    // url: 'http://localhost:5173',
    // cleartext: true,
    
    // Для использования встроенного приложения (офлайн режим) закомментируйте server.url
    // и используйте только webDir
  },
  android: {
    allowMixedContent: false,
    buildOptions: {
      keystorePath: undefined,
      keystorePassword: undefined,
      keystoreAlias: undefined,
      keystoreAliasPassword: undefined,
      releaseType: 'AAB', // или 'APK'
    },
    // Настройки для работы в фоне
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#0b0b0f',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: {
      style: 'dark',
      backgroundColor: '#0b0b0f',
    },
  },
};

export default config;

