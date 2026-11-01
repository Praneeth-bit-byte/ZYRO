import { PlatformCapabilities, PlatformTarget, SupportedLocale } from '../shared/contracts';

/**
 * Platform Adapter Contract
 * Isolates operating-system and device-specific behavior from ZYRO's platform-independent core.
 * Implementations can target Web browsers, Windows, macOS, Linux, Android, and iOS.
 */
export interface IPlatformAdapter {
  readonly target: PlatformTarget;
  getCapabilities(): PlatformCapabilities;
  speakText(text: string, locale: SupportedLocale): void;
  stopSpeaking(): void;
}

export function detectRuntimePlatform(): PlatformTarget {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'web';
  }
  const ua = navigator.userAgent.toLowerCase();
  const customBridge = (window as any).__ZYRO_NATIVE_BRIDGE__;

  if (customBridge?.platform) {
    return customBridge.platform as PlatformTarget;
  }
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return 'ios';
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('linux')) return 'linux';
  return 'web';
}

export function detectFormFactor(): 'desktop' | 'tablet' | 'mobile' {
  if (typeof window === 'undefined') return 'desktop';
  const width = window.innerWidth;
  if (width < 768) return 'mobile';
  if (width < 1024) return 'tablet';
  return 'desktop';
}

class CrossPlatformClientAdapter implements IPlatformAdapter {
  public readonly target: PlatformTarget;

  constructor(target?: PlatformTarget) {
    this.target = target || detectRuntimePlatform();
  }

  getCapabilities(): PlatformCapabilities {
    const isBrowser = typeof window !== 'undefined';
    const supportsSpeechRecognition =
      isBrowser &&
      Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
    const supportsSpeechSynthesis = isBrowser && 'speechSynthesis' in window;
    const supportsNotifications = isBrowser && 'Notification' in window;
    const supportsLocalSystemBridge =
      isBrowser && Boolean((window as any).__ZYRO_NATIVE_BRIDGE__);

    return {
      platform: this.target,
      supportsSpeechRecognition,
      supportsSpeechSynthesis,
      supportsNotifications,
      supportsLocalSystemBridge,
      formFactor: detectFormFactor(),
    };
  }

  speakText(text: string, locale: SupportedLocale): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const cleaned = text.replace(/[*#_`~]/g, '');
      const utterance = new SpeechSynthesisUtterance(cleaned);
      utterance.lang = locale;
      utterance.rate = 1.0;
      window.speechSynthesis.speak(utterance);
    } catch {
      // Safe no-op if audio output is restricted by OS/browser policy
    }
  }

  stopSpeaking(): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Safe no-op
    }
  }
}

export const platformAdapter: IPlatformAdapter = new CrossPlatformClientAdapter();
