import fs from 'fs';
import path from 'path';
import { PersistenceConfigurationStatus } from '../../shared/contracts';

/**
 * Server-Side Environment & Model Configuration
 * Centralizes environment variables, validates configured Google AI model IDs,
 * and resolves server-side Firebase Admin credentials for project `zyro-a3482`.
 * Never imported by client code.
 */

export const DEFAULT_FIREBASE_PROJECT_ID = 'zyro-a3482';

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

export type FirebaseCredentialSource =
  | 'google_application_credentials_file'
  | 'service_account_json_env'
  | 'discrete_env_vars'
  | 'unconfigured';

export interface ResolvedFirebaseCredentials {
  source: FirebaseCredentialSource;
  projectId: string;
  databaseId: string;
  clientEmail: string;
  privateKey: string;
  credentialsFilePath: string | null;
  webApiKey: string;
  configurationError?: string;
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
  firebase: ResolvedFirebaseCredentials;
}

function resolveFirebaseCredentials(): ResolvedFirebaseCredentials {
  const configuredProjectId = (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.VITE_FIREBASE_PROJECT_ID ||
    DEFAULT_FIREBASE_PROJECT_ID
  ).trim();

  const databaseId = (process.env.FIREBASE_DATABASE_ID || '(default)').trim();
  const webApiKey = (process.env.VITE_FIREBASE_API_KEY || '').trim();
  const gacPathRaw = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  const rawServiceAccountJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  const envClientEmail = (process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const envPrivateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();

  // 1. Priority 1: GOOGLE_APPLICATION_CREDENTIALS file path
  if (gacPathRaw) {
    const resolvedPath = path.isAbsolute(gacPathRaw)
      ? gacPathRaw
      : path.resolve(process.cwd(), gacPathRaw);

    if (!fs.existsSync(resolvedPath)) {
      return {
        source: 'unconfigured',
        projectId: configuredProjectId,
        databaseId,
        clientEmail: '',
        privateKey: '',
        credentialsFilePath: resolvedPath,
        webApiKey,
        configurationError: `GOOGLE_APPLICATION_CREDENTIALS points to a non-existent file ("${gacPathRaw}").`,
      };
    }

    try {
      const fileContent = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = JSON.parse(fileContent) as {
        project_id?: string;
        client_email?: string;
        private_key?: string;
      };

      const clientEmail = (parsed.client_email || '').trim();
      const privateKey = (parsed.private_key || '').replace(/\\n/g, '\n').trim();
      const projectId = configuredProjectId || (parsed.project_id || '').trim() || DEFAULT_FIREBASE_PROJECT_ID;

      if (!clientEmail || !privateKey) {
        return {
          source: 'unconfigured',
          projectId,
          databaseId,
          clientEmail: '',
          privateKey: '',
          credentialsFilePath: resolvedPath,
          webApiKey,
          configurationError:
            'The GOOGLE_APPLICATION_CREDENTIALS JSON file is missing required "client_email" or "private_key" fields.',
        };
      }

      return {
        source: 'google_application_credentials_file',
        projectId,
        databaseId,
        clientEmail,
        privateKey,
        credentialsFilePath: resolvedPath,
        webApiKey,
      };
    } catch (err: any) {
      return {
        source: 'unconfigured',
        projectId: configuredProjectId,
        databaseId,
        clientEmail: '',
        privateKey: '',
        credentialsFilePath: resolvedPath,
        webApiKey,
        configurationError: `Failed to parse GOOGLE_APPLICATION_CREDENTIALS JSON file: ${
          err?.message || 'Invalid JSON'
        }`,
      };
    }
  }

  // 2. Priority 2: FIREBASE_SERVICE_ACCOUNT_JSON environment variable (hosting secrets)
  if (rawServiceAccountJson) {
    try {
      const parsed = JSON.parse(rawServiceAccountJson) as {
        project_id?: string;
        client_email?: string;
        private_key?: string;
      };
      const clientEmail = (parsed.client_email || '').trim();
      const privateKey = (parsed.private_key || '').replace(/\\n/g, '\n').trim();
      const projectId = configuredProjectId || (parsed.project_id || '').trim() || DEFAULT_FIREBASE_PROJECT_ID;

      if (!clientEmail || !privateKey) {
        return {
          source: 'unconfigured',
          projectId,
          databaseId,
          clientEmail: '',
          privateKey: '',
          credentialsFilePath: null,
          webApiKey,
          configurationError:
            'FIREBASE_SERVICE_ACCOUNT_JSON is missing required "client_email" or "private_key" fields.',
        };
      }

      return {
        source: 'service_account_json_env',
        projectId,
        databaseId,
        clientEmail,
        privateKey,
        credentialsFilePath: null,
        webApiKey,
      };
    } catch {
      return {
        source: 'unconfigured',
        projectId: configuredProjectId,
        databaseId,
        clientEmail: '',
        privateKey: '',
        credentialsFilePath: null,
        webApiKey,
        configurationError: 'FIREBASE_SERVICE_ACCOUNT_JSON does not contain valid JSON.',
      };
    }
  }

  // 3. Priority 3: Discrete FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY environment variables
  if (envClientEmail && envPrivateKey) {
    return {
      source: 'discrete_env_vars',
      projectId: configuredProjectId,
      databaseId,
      clientEmail: envClientEmail,
      privateKey: envPrivateKey,
      credentialsFilePath: null,
      webApiKey,
    };
  }

  return {
    source: 'unconfigured',
    projectId: configuredProjectId,
    databaseId,
    clientEmail: envClientEmail,
    privateKey: envPrivateKey,
    credentialsFilePath: null,
    webApiKey,
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
    firebase: resolveFirebaseCredentials(),
  };
}

export function getFirebaseConfigurationStatus(): PersistenceConfigurationStatus {
  const cfg = getServerConfig().firebase;
  const configured = cfg.source !== 'unconfigured' && Boolean(cfg.projectId && cfg.clientEmail && cfg.privateKey);

  const missingEnvVars: string[] = [];
  if (!configured) {
    missingEnvVars.push('GOOGLE_APPLICATION_CREDENTIALS');
  }

  return {
    provider: 'firebase-firestore',
    configured,
    projectId: cfg.projectId || DEFAULT_FIREBASE_PROJECT_ID,
    databaseId: cfg.databaseId,
    missingEnvVars,
    message: configured
      ? `Firebase Admin initialized for project "${cfg.projectId}" (database: ${cfg.databaseId}).`
      : cfg.configurationError
      ? `Persistence not configured for project "${cfg.projectId}": ${cfg.configurationError}`
      : `Persistence not configured for project "${cfg.projectId}". Set GOOGLE_APPLICATION_CREDENTIALS (or FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY) on the server to enable Cloud Firestore persistence.`,
  };
}
