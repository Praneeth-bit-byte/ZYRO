import crypto from 'crypto';
import {
  UserProfile,
  ConversationRecord,
  MessageRecord,
  MemoryRecord,
  TaskRecord,
  WorkflowRecord,
  AuditLogRecord,
} from '../../shared/contracts';
import { getFirebaseConfigurationStatus, getServerConfig } from '../config/env';
import { PersistenceNotConfiguredError, AppError } from '../errors/app-error';
import { IDataRepository } from './repository.interface';

/**
 * Cloud Firestore Data Repository Implementation
 *
 * Enforces strict user-scoped document hierarchies:
 *   /users/{userId}
 *   /users/{userId}/conversations/{conversationId}
 *   /users/{userId}/conversations/{conversationId}/messages/{messageId}
 *   /users/{userId}/memories/{memoryId}
 *   /users/{userId}/tasks/{taskId}
 *   /users/{userId}/workflows/{workflowId}
 *   /users/{userId}/auditLogs/{auditId}
 *
 * IMPORTANT ARCHITECTURAL INVARIANT:
 * Does NOT fall back to temporary in-memory arrays or local files.
 * If Firebase credentials are not configured in the environment, methods throw
 * `PersistenceNotConfiguredError` so the system never pretends persistence is active.
 */
export class FirestoreRepository implements IDataRepository {
  private cachedAccessToken: { token: string; expiresAt: number } | null = null;

  public isConfigured(): boolean {
    return getFirebaseConfigurationStatus().configured;
  }

  private assertConfigured(): {
    projectId: string;
    databaseId: string;
    clientEmail: string;
    privateKey: string;
  } {
    const status = getFirebaseConfigurationStatus();
    if (!status.configured) {
      throw new PersistenceNotConfiguredError(status.missingEnvVars);
    }
    const cfg = getServerConfig().firebase;
    return {
      projectId: cfg.projectId,
      databaseId: cfg.databaseId,
      clientEmail: cfg.clientEmail,
      privateKey: cfg.privateKey,
    };
  }

  private assertValidUserId(userId: string): void {
    if (!userId || !/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) {
      throw new AppError({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid user identifier for user-scoped data operation.',
      });
    }
  }

  /**
   * Generates an OAuth2 access token from the configured Firebase service account
   * using Node's built-in `crypto` module for zero-dependency Google Cloud REST communication.
   */
  private async getServiceAccountAccessToken(): Promise<string> {
    const { clientEmail, privateKey } = this.assertConfigured();
    const nowSec = Math.floor(Date.now() / 1000);

    if (this.cachedAccessToken && this.cachedAccessToken.expiresAt > nowSec + 60) {
      return this.cachedAccessToken.token;
    }

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: clientEmail,
        sub: clientEmail,
        aud: 'https://oauth2.googleapis.com/token',
        iat: nowSec,
        exp: nowSec + 3600,
        scope: 'https://www.googleapis.com/auth/datastore',
      })
    ).toString('base64url');

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    const signature = signer.sign(privateKey, 'base64url');
    const assertion = `${header}.${payload}.${signature}`;

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new AppError({
        statusCode: 503,
        code: 'PERSISTENCE_NOT_CONFIGURED',
        message: `Failed to authenticate with Cloud Firestore using service account credentials: ${errText}`,
      });
    }

    const tokenData = (await response.json()) as { access_token: string; expires_in: number };
    this.cachedAccessToken = {
      token: tokenData.access_token,
      expiresAt: nowSec + (tokenData.expires_in || 3600),
    };
    return tokenData.access_token;
  }

  private getBaseUrl(): string {
    const { projectId, databaseId } = this.assertConfigured();
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      projectId
    )}/databases/${encodeURIComponent(databaseId)}/documents`;
  }

  private toFirestoreValue(val: unknown): Record<string, unknown> {
    if (val === null || val === undefined) return { nullValue: null };
    if (typeof val === 'boolean') return { booleanValue: val };
    if (typeof val === 'number') {
      return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
    }
    if (typeof val === 'string') return { stringValue: val };
    if (Array.isArray(val)) {
      return { arrayValue: { values: val.map((item) => this.toFirestoreValue(item)) } };
    }
    if (typeof val === 'object') {
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (v !== undefined) {
          fields[k] = this.toFirestoreValue(v);
        }
      }
      return { mapValue: { fields } };
    }
    return { stringValue: String(val) };
  }

  private fromFirestoreValue(field: any): any {
    if (!field || typeof field !== 'object') return null;
    if ('stringValue' in field) return field.stringValue;
    if ('booleanValue' in field) return field.booleanValue;
    if ('integerValue' in field) return Number(field.integerValue);
    if ('doubleValue' in field) return Number(field.doubleValue);
    if ('nullValue' in field) return null;
    if ('arrayValue' in field) {
      return (field.arrayValue?.values || []).map((v: any) => this.fromFirestoreValue(v));
    }
    if ('mapValue' in field) {
      const out: Record<string, any> = {};
      const fields = field.mapValue?.fields || {};
      for (const [k, v] of Object.entries(fields)) {
        out[k] = this.fromFirestoreValue(v);
      }
      return out;
    }
    return null;
  }

  private fromFirestoreDocument<T>(doc: any): T {
    const fields = doc.fields || {};
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = this.fromFirestoreValue(v);
    }
    if (doc.name && !out.id) {
      const segments = String(doc.name).split('/');
      out.id = segments[segments.length - 1];
    }
    return out as T;
  }

  private async requestFirestore(
    relativePath: string,
    options: RequestInit = {}
  ): Promise<any> {
    const token = await this.getServiceAccountAccessToken();
    const url = `${this.getBaseUrl()}/${relativePath}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new AppError({
        statusCode: res.status,
        code: 'INTERNAL_ERROR',
        message: `Firestore operation failed (${res.status}): ${text}`,
      });
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // --------------------------------------------------------------------------
  // User Profile Operations
  // --------------------------------------------------------------------------
  async getUserProfile(userId: string): Promise<UserProfile | null> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    const doc = await this.requestFirestore(`users/${encodeURIComponent(userId)}`);
    if (!doc) return null;
    return this.fromFirestoreDocument<UserProfile>(doc);
  }

  async upsertUserProfile(userId: string, profile: Partial<UserProfile>): Promise<UserProfile> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    const existing = await this.getUserProfile(userId);
    const now = new Date().toISOString();
    const merged: UserProfile = {
      uid: userId,
      email: profile.email ?? existing?.email ?? null,
      displayName: profile.displayName ?? existing?.displayName ?? null,
      preferences: profile.preferences ??
        existing?.preferences ?? {
          locale: 'en-US',
          theme: 'dark',
          voiceOutputEnabled: false,
        },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const encoded = this.toFirestoreValue(merged).mapValue as { fields: Record<string, unknown> };
    const saved = await this.requestFirestore(`users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: encoded.fields }),
    });
    return this.fromFirestoreDocument<UserProfile>(saved);
  }

  // --------------------------------------------------------------------------
  // Conversations & Messages (User-Scoped)
  // --------------------------------------------------------------------------
  async listConversations(userId: string): Promise<ConversationRecord[]> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    const data = await this.requestFirestore(
      `users/${encodeURIComponent(userId)}/conversations`
    );
    const docs = data?.documents || [];
    return docs
      .map((d: any) => this.fromFirestoreDocument<ConversationRecord>(d))
      .sort((a: ConversationRecord, b: ConversationRecord) =>
        b.updatedAt.localeCompare(a.updatedAt)
      );
  }

  async createConversation(
    userId: string,
    data: Omit<ConversationRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
  ): Promise<ConversationRecord> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    const id = `conv-${Date.now()}-${ crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const record: ConversationRecord = {
      id,
      userId,
      title: data.title,
      platformOrigin: data.platformOrigin,
      locale: data.locale,
      createdAt: now,
      updatedAt: now,
    };
    const encoded = this.toFirestoreValue(record).mapValue as { fields: Record<string, unknown> };
    await this.requestFirestore(
      `users/${encodeURIComponent(userId)}/conversations?documentId=${encodeURIComponent(id)}`,
      {
        method: 'POST',
        body: JSON.stringify({ fields: encoded.fields }),
      }
    );
    return record;
  }

  async listMessages(userId: string, conversationId: string): Promise<MessageRecord[]> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    const data = await this.requestFirestore(
      `users/${encodeURIComponent(userId)}/conversations/${encodeURIComponent(
        conversationId
      )}/messages`
    );
    const docs = data?.documents || [];
    return docs
      .map((d: any) => this.fromFirestoreDocument<MessageRecord>(d))
      .sort((a: MessageRecord, b: MessageRecord) => a.createdAt.localeCompare(b.createdAt));
  }

  async appendMessage(
    userId: string,
    data: Omit<MessageRecord, 'id' | 'userId' | 'createdAt'>
  ): Promise<MessageRecord> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    const id = `msg-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const record: MessageRecord = {
      id,
      userId,
      conversationId: data.conversationId,
      role: data.role,
      content: data.content,
      modelUsed: data.modelUsed,
      locale: data.locale,
      createdAt: now,
    };
    const encoded = this.toFirestoreValue(record).mapValue as { fields: Record<string, unknown> };
    await this.requestFirestore(
      `users/${encodeURIComponent(userId)}/conversations/${encodeURIComponent(
        data.conversationId
      )}/messages?documentId=${encodeURIComponent(id)}`,
      {
        method: 'POST',
        body: JSON.stringify({ fields: encoded.fields }),
      }
    );
    return record;
  }

  // --------------------------------------------------------------------------
  // Long-Term Memories (User-Scoped)
  // --------------------------------------------------------------------------
  async listMemories(userId: string): Promise<MemoryRecord[]> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    const data = await this.requestFirestore(`users/${encodeURIComponent(userId)}/memories`);
    const docs = data?.documents || [];
    return docs
      .map((d: any) => this.fromFirestoreDocument<MemoryRecord>(d))
      .sort((a: MemoryRecord, b: MemoryRecord) => b.createdAt.localeCompare(a.createdAt));
  }

  async createMemory(
    userId: string,
    data: Omit<MemoryRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryRecord> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    const id = `mem-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      id,
      userId,
      category: data.category,
      content: data.content,
      tags: data.tags,
      source: data.source,
      createdAt: now,
      updatedAt: now,
    };
    const encoded = this.toFirestoreValue(record).mapValue as { fields: Record<string, unknown> };
    await this.requestFirestore(
      `users/${encodeURIComponent(userId)}/memories?documentId=${encodeURIComponent(id)}`,
      {
        method: 'POST',
        body: JSON.stringify({ fields: encoded.fields }),
      }
    );
    return record;
  }

  async deleteMemory(userId: string, memoryId: string): Promise<void> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    await this.requestFirestore(
      `users/${encodeURIComponent(userId)}/memories/${encodeURIComponent(memoryId)}`,
      { method: 'DELETE' }
    );
  }

  // --------------------------------------------------------------------------
  // Tasks (User-Scoped)
  // --------------------------------------------------------------------------
  async listTasks(userId: string): Promise<TaskRecord[]> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    const data = await this.requestFirestore(`users/${encodeURIComponent(userId)}/tasks`);
    const docs = data?.documents || [];
    return docs
      .map((d: any) => this.fromFirestoreDocument<TaskRecord>(d))
      .sort((a: TaskRecord, b: TaskRecord) => b.createdAt.localeCompare(a.createdAt));
  }

  async createTask(
    userId: string,
    data: Omit<TaskRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
  ): Promise<TaskRecord> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    const id = `task-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const record: TaskRecord = {
      id,
      userId,
      title: data.title,
      description: data.description,
      category: data.category,
      priority: data.priority,
      status: data.status,
      dueDate: data.dueDate,
      createdAt: now,
      updatedAt: now,
    };
    const encoded = this.toFirestoreValue(record).mapValue as { fields: Record<string, unknown> };
    await this.requestFirestore(
      `users/${encodeURIComponent(userId)}/tasks?documentId=${encodeURIComponent(id)}`,
      {
        method: 'POST',
        body: JSON.stringify({ fields: encoded.fields }),
      }
    );
    return record;
  }

  async updateTaskStatus(
    userId: string,
    taskId: string,
    status: TaskRecord['status']
  ): Promise<TaskRecord> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    const docPath = `users/${encodeURIComponent(userId)}/tasks/${encodeURIComponent(taskId)}`;
    const existingDoc = await this.requestFirestore(docPath);
    if (!existingDoc) {
      throw new AppError({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: `Task "${taskId}" not found.`,
      });
    }
    const existing = this.fromFirestoreDocument<TaskRecord>(existingDoc);
    const updated: TaskRecord = {
      ...existing,
      status,
      updatedAt: new Date().toISOString(),
    };
    const encoded = this.toFirestoreValue(updated).mapValue as { fields: Record<string, unknown> };
    await this.requestFirestore(docPath, {
      method: 'PATCH',
      body: JSON.stringify({ fields: encoded.fields }),
    });
    return updated;
  }

  async deleteTask(userId: string, taskId: string): Promise<void> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    await this.requestFirestore(
      `users/${encodeURIComponent(userId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: 'DELETE' }
    );
  }

  // --------------------------------------------------------------------------
  // Workflows (User-Scoped)
  // --------------------------------------------------------------------------
  async listWorkflows(userId: string): Promise<WorkflowRecord[]> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    const data = await this.requestFirestore(`users/${encodeURIComponent(userId)}/workflows`);
    const docs = data?.documents || [];
    return docs.map((d: any) => this.fromFirestoreDocument<WorkflowRecord>(d));
  }

  async createWorkflow(
    userId: string,
    data: Omit<WorkflowRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'lastRunAt'>
  ): Promise<WorkflowRecord> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    const id = `wf-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const record: WorkflowRecord = {
      id,
      userId,
      name: data.name,
      description: data.description,
      triggerType: data.triggerType,
      steps: data.steps,
      enabled: data.enabled,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const encoded = this.toFirestoreValue(record).mapValue as { fields: Record<string, unknown> };
    await this.requestFirestore(
      `users/${encodeURIComponent(userId)}/workflows?documentId=${encodeURIComponent(id)}`,
      {
        method: 'POST',
        body: JSON.stringify({ fields: encoded.fields }),
      }
    );
    return record;
  }

  // --------------------------------------------------------------------------
  // Audit Logs (User-Scoped)
  // --------------------------------------------------------------------------
  async listAuditLogs(userId: string, limit = 50): Promise<AuditLogRecord[]> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    const data = await this.requestFirestore(`users/${encodeURIComponent(userId)}/auditLogs`);
    const docs = data?.documents || [];
    return docs
      .map((d: any) => this.fromFirestoreDocument<AuditLogRecord>(d))
      .sort((a: AuditLogRecord, b: AuditLogRecord) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  async appendAuditLog(
    userId: string,
    entry: Omit<AuditLogRecord, 'id' | 'userId' | 'timestamp'>
  ): Promise<AuditLogRecord> {
    this.assertConfigured();
    this.assertValidUserId(userId);
    const id = `audit-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const timestamp = new Date().toISOString();
    const record: AuditLogRecord = {
      id,
      userId,
      ...entry,
      timestamp,
    };
    const encoded = this.toFirestoreValue(record).mapValue as { fields: Record<string, unknown> };
    await this.requestFirestore(
      `users/${encodeURIComponent(userId)}/auditLogs?documentId=${encodeURIComponent(id)}`,
      {
        method: 'POST',
        body: JSON.stringify({ fields: encoded.fields }),
      }
    );
    return record;
  }
}

export const dataRepository: IDataRepository = new FirestoreRepository();
