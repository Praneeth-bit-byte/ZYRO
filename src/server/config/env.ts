import { PersistenceConfigurationStatus } from '../../shared/contracts';

/**
 * Server-Side Environment & Model Configuration
 * Centralizes environment variables and validates configured Google AI model IDs.
 * Never imported by client code.
 */

export const SUPPORTED_GOOGLE_AI_MODELS: ReadonlySet<string> = new Set([
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-4-argon',
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite-image',
  'gemini-nano-banana-2.1',
  'gemini-3-pro-image',
  'gemini-3.8-live',
  'gemini-3.8-live-extended-thinking',
  'gemini-3.5-transcribe',
  'gemini-3.5-transcribe-live',
  'gemini-3.5-live-translate-preview',
  'gemini-3.8-flash-lite-tts',
  'gemini-3.8-flash-tts',
  'gemini-omni-1.1-flash',
  'gemini-embedding-2-preview',
]);

export interface ModelValidationStatus {
  configuredId: string;
  valid: boolean;
  error?: string;
}

export function validateModelId(modelId: string): ModelValidationStatus {
  const trimmed = (modelId || '').trim();
  if (!trimmed) {
    return {
      configuredId: '',
      valid: false,
      error: 'Model ID is empty. Configure a valid Google AI model ID in environment variables.',
    };
  }
  if (!SUPPORTED_GOOGLE_AI_MODELS.has(trimmed)) {
    return {
      configuredId: trimmed,
      valid: false,
      error: `Model "${trimmed}" is not a verified Google AI model. Allowed models include: ${Array.from(
        SUPPORTED_GOOGLE_AI_MODELS
      ).join(', ')}.`,
    };
  }
  return {
    configuredId: trimmed,
    valid: true,
  };
}

export interface ServerConfig {
  port: number;
  geminiApiKey: string;
  models: {
    chat: string;
    reasoning: string;
    embedding: string;
    tts: string;
    transcribe: string;
  };
  firebase: {
    projectId: string;
    databaseId: string;
    clientEmail: string;
    privateKey: string;
    webApiKey: string;
  };
}

export function getServerConfig(): ServerConfig {
  return {
    port: Number(process.env.PORT) || 3000,
    geminiApiKey: (process.env.GEMINI_API_KEY || '').trim(),
    models: {
      chat: (process.env.ZYRO_CHAT_MODEL || 'gemini-3.5-flash-lite').trim(),
      reasoning: (process.env.ZYRO_REASONING_MODEL || 'gemini-3.5-flash').trim(),
      embedding: (process.env.ZYRO_EMBEDDING_MODEL || 'gemini-embedding-2-preview').trim(),
      tts: (process.env.ZYRO_TTS_MODEL || 'gemini-3.8-flash-lite-tts').trim(),
      transcribe: (process.env.ZYRO_TRANSCRIBE_MODEL || 'gemini-3.5-transcribe').trim(),
    },
    firebase: {
      projectId: (
        process.env.FIREBASE_PROJECT_ID ||
        process.env.VITE_FIREBASE_PROJECT_ID ||
        ''
      ).trim(),
      databaseId: (process.env.FIREBASE_DATABASE_ID || '(default)').trim(),
      clientEmail: (process.env.FIREBASE_CLIENT_EMAIL || '').trim(),
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim(),
      webApiKey: (process.env.VITE_FIREBASE_API_KEY || '').trim(),
    },
  };
}

export function getFirebaseConfigurationStatus(): PersistenceConfigurationStatus {
  const cfg = getServerConfig().firebase;
  const missingEnvVars: string[] = [];

  if (!cfg.projectId) missingEnvVars.push('FIREBASE_PROJECT_ID');
  if (!cfg.clientEmail) missingEnvVars.push('FIREBASE_CLIENT_EMAIL');
  if (!cfg.privateKey) missingEnvVars.push('FIREBASE_PRIVATE_KEY');

  const configured = missingEnvVars.length === 0;

  return {
    provider: 'firebase-firestore',
    configured,
    projectId: cfg.projectId || null,
    databaseId: cfg.databaseId,
    missingEnvVars,
    message: configured
      ? `Connected to Cloud Firestore project "${cfg.projectId}" (${cfg.databaseId}).`
      : `Persistence not configured. Set ${missingEnvVars.join(
          ', '
        )} in environment variables to enable Cloud Firestore storage.`,
  };
}
