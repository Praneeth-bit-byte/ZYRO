/**
 * ZYRO Shared Platform-Independent Contracts
 * Defines domain entities, API payloads, permission tiers, and error structures
 * shared across Web, Windows, macOS, Linux, Android, and iOS clients and the backend.
 */

export type PlatformTarget = 'web' | 'windows' | 'macos' | 'linux' | 'android' | 'ios';

export type SupportedLocale = 'en-US' | 'hi-IN' | 'te-IN';

export enum RiskTier {
  READ_ONLY = 0,
  INTERNAL_WRITE = 1,
  EXTERNAL_OR_DEVICE = 2,
  CRITICAL_RESTRICTED = 3,
}

export interface PlatformCapabilities {
  platform: PlatformTarget;
  supportsSpeechRecognition: boolean;
  supportsSpeechSynthesis: boolean;
  supportsNotifications: boolean;
  supportsLocalSystemBridge: boolean;
  formFactor: 'desktop' | 'tablet' | 'mobile';
}

export interface UserPreferences {
  locale: SupportedLocale;
  theme: 'dark' | 'light';
  voiceOutputEnabled: boolean;
}

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  preferences: UserPreferences;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationRecord {
  id: string;
  userId: string;
  title: string;
  platformOrigin: PlatformTarget;
  locale: SupportedLocale;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  userId: string;
  role: 'user' | 'model' | 'system';
  content: string;
  modelUsed?: string;
  locale: SupportedLocale;
  createdAt: string;
}

export interface MemoryRecord {
  id: string;
  userId: string;
  category: 'Personal Fact' | 'Preference' | 'Project Context' | 'System Rule';
  content: string;
  tags: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  userId: string;
  title: string;
  description?: string;
  category: 'Productivity' | 'Development' | 'Research' | 'Automation';
  priority: 'High' | 'Medium' | 'Low';
  status: 'pending' | 'in_progress' | 'completed';
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStep {
  id: string;
  name: string;
  actionType: string;
  riskTier: RiskTier;
}

export interface WorkflowRecord {
  id: string;
  userId: string;
  name: string;
  description: string;
  triggerType: 'manual' | 'scheduled' | 'event';
  steps: WorkflowStep[];
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogRecord {
  id: string;
  userId: string;
  actionName: string;
  module: string;
  riskTier: RiskTier;
  decision: 'allowed' | 'requires_approval' | 'denied';
  verificationStatus: 'verified' | 'unverified' | 'failed' | 'not_applicable';
  platform: PlatformTarget;
  details: string;
  timestamp: string;
}

export interface PersistenceConfigurationStatus {
  provider: 'firebase-firestore';
  configured: boolean;
  projectId: string | null;
  databaseId: string;
  missingEnvVars: string[];
  message: string;
}

export interface SystemDiagnosticsResponse {
  service: 'ZYRO Core Backend';
  version: string;
  timestamp: string;
  ai: {
    apiKeyConfigured: boolean;
    models: {
      chat: { configuredId: string; valid: boolean; error?: string };
      reasoning: { configuredId: string; valid: boolean; error?: string };
      embedding: { configuredId: string; valid: boolean; error?: string };
      tts: { configuredId: string; valid: boolean; error?: string };
      transcribe: { configuredId: string; valid: boolean; error?: string };
    };
  };
  persistence: PersistenceConfigurationStatus;
  auth: {
    provider: 'firebase-auth';
    configured: boolean;
    authenticatedUser: {
      uid: string;
      email: string | null;
      mode: 'verified_token' | 'unconfigured_guest';
    } | null;
  };
}

export interface AssistantChatRequest {
  message: string;
  conversationId?: string;
  history?: Array<{ role: 'user' | 'model'; content: string }>;
  locale: SupportedLocale;
  platform: PlatformTarget;
  mode?: 'chat' | 'reasoning';
}

export interface TokenUsageMetadata {
  promptTokens: number;
  responseTokens: number;
  thinkingTokens: number;
  totalTokens: number;
}

export interface AssistantChatResponse {
  reply: string;
  modelUsed: string;
  requestedModel?: string;
  fallbackNotice?: string;
  latencyMs?: number;
  tokenUsage?: TokenUsageMetadata;
  conversationId: string | null;
  persisted: boolean;
  persistenceNotice?: string;
  auditEntry: Omit<AuditLogRecord, 'id' | 'userId'>;
  timestamp: string;
}

export interface MemoriesListResponse {
  configured: boolean;
  memories: MemoryRecord[];
  persistence: PersistenceConfigurationStatus;
}

export interface TasksListResponse {
  configured: boolean;
  tasks: TaskRecord[];
  persistence: PersistenceConfigurationStatus;
}

export interface WorkflowsListResponse {
  configured: boolean;
  workflows: WorkflowRecord[];
  persistence: PersistenceConfigurationStatus;
}

export interface AuditLogsListResponse {
  configured: boolean;
  auditLogs: AuditLogRecord[];
  persistence: PersistenceConfigurationStatus;
}

export interface ApiErrorPayload {
  error: {
    code:
      | 'PERSISTENCE_NOT_CONFIGURED'
      | 'AUTHENTICATION_REQUIRED'
      | 'AI_CONFIGURATION_ERROR'
      | 'MODEL_NOT_AVAILABLE'
      | 'PERMISSION_DENIED'
      | 'VALIDATION_ERROR'
      | 'NOT_FOUND'
      | 'INTERNAL_ERROR';
    message: string;
    missingEnvVars?: string[];
    details?: Record<string, unknown>;
  };
}
