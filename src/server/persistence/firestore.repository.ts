import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
  UserProfile,
  ConversationRecord,
  MessageRecord,
  MemoryRecord,
  TaskRecord,
  WorkflowRecord,
  AuditLogRecord,
} from '../../shared/contracts';
import { getFirebaseConfigurationStatus } from '../config/env';
import { PersistenceNotConfiguredError, AppError } from '../errors/app-error';
import { getFirebaseAdminFirestore, isFirebaseAdminConfigured } from './firebase-admin.client';
import { IDataRepository } from './repository.interface';

let testFirestoreOverride: Firestore | null = null;

/**
 * Allows automated integration tests to inject an isolated Firestore-compatible instance
 * to verify repository CRUD and cross-user isolation without enabling mock storage in production.
 */
export function setFirestoreInstanceForTesting(db: Firestore | null): void {
  testFirestoreOverride = db;
}

/**
 * Cloud Firestore Data Repository Implementation (Firebase Admin SDK)
 *
 * Enforces strict user-scoped document hierarchies in project `zyro-a3482`:
 *   /users/{userId}
 *   /users/{userId}/conversations/{conversationId}
 *   /users/{userId}/conversations/{conversationId}/messages/{messageId}
 *   /users/{userId}/memories/{memoryId}
 *   /users/{userId}/tasks/{taskId}
 *   /users/{userId}/workflows/{workflowId}
 *   /users/{userId}/auditLogs/{auditId}
 *
 * IMPORTANT ARCHITECTURAL INVARIANT:
 * - Uses Firebase Admin SDK (`firebase-admin/firestore`) strictly on the backend.
 * - Never falls back to temporary in-memory arrays or local files in production.
 * - Enforces explicit UID ownership verification on every read, create, update, and delete operation.
 */
export class FirestoreRepository implements IDataRepository {
  public isConfigured(): boolean {
    if (testFirestoreOverride) {
      return true;
    }
    return isFirebaseAdminConfigured();
  }

  private getDb(): Firestore {
    if (testFirestoreOverride) {
      return testFirestoreOverride;
    }
    const status = getFirebaseConfigurationStatus();
    if (!status.configured) {
      throw new PersistenceNotConfiguredError(status.missingEnvVars);
    }
    return getFirebaseAdminFirestore();
  }

  private assertValidUserId(userId: string): void {
    if (!userId || typeof userId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(userId)) {
      throw new AppError({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid user UID for user-scoped Firestore operation.',
      });
    }
  }

  private assertValidDocumentId(docId: string, label: string): void {
    if (!docId || typeof docId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(docId)) {
      throw new AppError({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: `Invalid ${label} identifier.`,
      });
    }
  }

  private assertRecordOwnership(recordUserId: unknown, authenticatedUserId: string, label: string): void {
    if (recordUserId !== authenticatedUserId) {
      throw new AppError({
        statusCode: 403,
        code: 'PERMISSION_DENIED',
        message: `Access denied: ${label} does not belong to the authenticated user.`,
      });
    }
  }

  private userDocRef(db: Firestore, userId: string) {
    return db.collection('users').doc(userId);
  }

  // --------------------------------------------------------------------------
  // User Profile Operations (/users/{userId})
  // --------------------------------------------------------------------------
  async getUserProfile(userId: string): Promise<UserProfile | null> {
    this.assertValidUserId(userId);
    const db = this.getDb();
    const snap = await this.userDocRef(db, userId).get();
    if (!snap.exists) {
      return null;
    }
    const data = snap.data() as UserProfile | undefined;
    if (!data) {
      return null;
    }
    this.assertRecordOwnership(data.uid, userId, 'User profile');
    return data;
  }

  async upsertUserProfile(userId: string, profile: Partial<UserProfile>): Promise<UserProfile> {
    this.assertValidUserId(userId);
    const db = this.getDb();
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

    await this.userDocRef(db, userId).set(merged, { merge: true });
    return merged;
  }

  // --------------------------------------------------------------------------
  // Conversations & Messages (/users/{userId}/conversations/{conversationId}/messages/{messageId})
  // --------------------------------------------------------------------------
  async listConversations(userId: string): Promise<ConversationRecord[]> {
    this.assertValidUserId(userId);
    const db = this.getDb();
    const snap = await this.userDocRef(db, userId).collection('conversations').get();
    const records: ConversationRecord[] = [];

    for (const doc of snap.docs) {
      const data = doc.data() as ConversationRecord;
      if (data && data.userId === userId) {
        records.push({ ...data, id: data.id || doc.id });
      }
    }

    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createConversation(
    userId: string,
    data: Omit<ConversationRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
  ): Promise<ConversationRecord> {
    this.assertValidUserId(userId);
    const db = this.getDb();
    const id = `conv-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
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

    await this.userDocRef(db, userId).collection('conversations').doc(id).set(record);
    return record;
  }

  async listMessages(userId: string, conversationId: string): Promise<MessageRecord[]> {
    this.assertValidUserId(userId);
    this.assertValidDocumentId(conversationId, 'conversation');
    const db = this.getDb();

    const convRef = this.userDocRef(db, userId).collection('conversations').doc(conversationId);
    const convSnap = await convRef.get();
    if (!convSnap.exists) {
      throw new AppError({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: `Conversation "${conversationId}" not found for the authenticated user.`,
      });
    }
    const convData = convSnap.data() as ConversationRecord | undefined;
    this.assertRecordOwnership(convData?.userId, userId, 'Conversation');

    const msgSnap = await convRef.collection('messages').get();
    const messages: MessageRecord[] = [];
    for (const doc of msgSnap.docs) {
      const data = doc.data() as MessageRecord;
      if (data && data.userId === userId) {
        messages.push({ ...data, id: data.id || doc.id });
      }
    }

    return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async appendMessage(
    userId: string,
    data: Omit<MessageRecord, 'id' | 'userId' | 'createdAt'>
  ): Promise<MessageRecord> {
    this.assertValidUserId(userId);
    this.assertValidDocumentId(data.conversationId, 'conversation');
    const db = this.getDb();

    const convRef = this.userDocRef(db, userId)
      .collection('conversations')
      .doc(data.conversationId);
    const convSnap = await convRef.get();
    if (!convSnap.exists) {
      throw new AppError({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: `Conversation "${data.conversationId}" not found for the authenticated user.`,
      });
    }
    const convData = convSnap.data() as ConversationRecord | undefined;
    this.assertRecordOwnership(convData?.userId, userId, 'Conversation');

    const id = `msg-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const record: MessageRecord = {
      id,
      userId,
      conversationId: data.conversationId,
      role: data.role,
      content: data.content,
      ...(data.modelUsed ? { modelUsed: data.modelUsed } : {}),
      locale: data.locale,
      createdAt: now,
    };

    await convRef.collection('messages').doc(id).set(record);
    await convRef.set({ updatedAt: now }, { merge: true });
    return record;
  }

  // --------------------------------------------------------------------------
  // Long-Term Memories (/users/{userId}/memories/{memoryId})
  // --------------------------------------------------------------------------
  async listMemories(userId: string): Promise<MemoryRecord[]> {
    this.assertValidUserId(userId);
    const db = this.getDb();
    const snap = await this.userDocRef(db, userId).collection('memories').get();
    const memories: MemoryRecord[] = [];

    for (const doc of snap.docs) {
      const data = doc.data() as MemoryRecord;
      if (data && data.userId === userId) {
        memories.push({ ...data, id: data.id || doc.id });
      }
    }

    return memories.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createMemory(
    userId: string,
    data: Omit<MemoryRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryRecord> {
    this.assertValidUserId(userId);
    const db = this.getDb();
    const id = `mem-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();

    const record: MemoryRecord = {
      id,
      userId,
      category: data.category,
      content: data.content,
      tags: Array.isArray(data.tags) ? data.tags : [],
      source: data.source,
      createdAt: now,
      updatedAt: now,
    };

    await this.userDocRef(db, userId).collection('memories').doc(id).set(record);
    return record;
  }

  async deleteMemory(userId: string, memoryId: string): Promise<void> {
    this.assertValidUserId(userId);
    this.assertValidDocumentId(memoryId, 'memory');
    const db = this.getDb();

    const memRef = this.userDocRef(db, userId).collection('memories').doc(memoryId);
    const snap = await memRef.get();
    if (!snap.exists) {
      throw new AppError({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: `Memory "${memoryId}" not found for the authenticated user.`,
      });
    }
    const existing = snap.data() as MemoryRecord | undefined;
    this.assertRecordOwnership(existing?.userId, userId, 'Memory');

    await memRef.delete();
  }

  // --------------------------------------------------------------------------
  // Tasks (/users/{userId}/tasks/{taskId})
  // --------------------------------------------------------------------------
  async listTasks(userId: string): Promise<TaskRecord[]> {
    this.assertValidUserId(userId);
    const db = this.getDb();
    const snap = await this.userDocRef(db, userId).collection('tasks').get();
    const tasks: TaskRecord[] = [];

    for (const doc of snap.docs) {
      const data = doc.data() as TaskRecord;
      if (data && data.userId === userId) {
        tasks.push({ ...data, id: data.id || doc.id });
      }
    }

    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createTask(
    userId: string,
    data: Omit<TaskRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
  ): Promise<TaskRecord> {
    this.assertValidUserId(userId);
    const db = this.getDb();
    const id = `task-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();

    const record: TaskRecord = {
      id,
      userId,
      title: data.title,
      ...(data.description !== undefined ? { description: data.description } : {}),
      category: data.category,
      priority: data.priority,
      status: data.status,
      ...(data.dueDate !== undefined ? { dueDate: data.dueDate } : {}),
      createdAt: now,
      updatedAt: now,
    };

    await this.userDocRef(db, userId).collection('tasks').doc(id).set(record);
    return record;
  }

  async updateTaskStatus(
    userId: string,
    taskId: string,
    status: TaskRecord['status']
  ): Promise<TaskRecord> {
    this.assertValidUserId(userId);
    this.assertValidDocumentId(taskId, 'task');
    const db = this.getDb();

    const taskRef = this.userDocRef(db, userId).collection('tasks').doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) {
      throw new AppError({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: `Task "${taskId}" not found for the authenticated user.`,
      });
    }

    const existing = snap.data() as TaskRecord;
    this.assertRecordOwnership(existing.userId, userId, 'Task');

    const updated: TaskRecord = {
      ...existing,
      id: existing.id || taskId,
      status,
      updatedAt: new Date().toISOString(),
    };

    await taskRef.set(updated);
    return updated;
  }

  async deleteTask(userId: string, taskId: string): Promise<void> {
    this.assertValidUserId(userId);
    this.assertValidDocumentId(taskId, 'task');
    const db = this.getDb();

    const taskRef = this.userDocRef(db, userId).collection('tasks').doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) {
      throw new AppError({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: `Task "${taskId}" not found for the authenticated user.`,
      });
    }

    const existing = snap.data() as TaskRecord | undefined;
    this.assertRecordOwnership(existing?.userId, userId, 'Task');

    await taskRef.delete();
  }

  // --------------------------------------------------------------------------
  // Workflows (/users/{userId}/workflows/{workflowId})
  // --------------------------------------------------------------------------
  async listWorkflows(userId: string): Promise<WorkflowRecord[]> {
    this.assertValidUserId(userId);
    const db = this.getDb();
    const snap = await this.userDocRef(db, userId).collection('workflows').get();
    const workflows: WorkflowRecord[] = [];

    for (const doc of snap.docs) {
      const data = doc.data() as WorkflowRecord;
      if (data && data.userId === userId) {
        workflows.push({ ...data, id: data.id || doc.id });
      }
    }

    return workflows;
  }

  async createWorkflow(
    userId: string,
    data: Omit<WorkflowRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'lastRunAt'>
  ): Promise<WorkflowRecord> {
    this.assertValidUserId(userId);
    const db = this.getDb();
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

    await this.userDocRef(db, userId).collection('workflows').doc(id).set(record);
    return record;
  }

  // --------------------------------------------------------------------------
  // Audit Logs (/users/{userId}/auditLogs/{auditId})
  // --------------------------------------------------------------------------
  async listAuditLogs(userId: string, limit = 50): Promise<AuditLogRecord[]> {
    this.assertValidUserId(userId);
    const db = this.getDb();
    const snap = await this.userDocRef(db, userId).collection('auditLogs').get();
    const logs: AuditLogRecord[] = [];

    for (const doc of snap.docs) {
      const data = doc.data() as AuditLogRecord;
      if (data && data.userId === userId) {
        logs.push({ ...data, id: data.id || doc.id });
      }
    }

    return logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
  }

  async appendAuditLog(
    userId: string,
    entry: Omit<AuditLogRecord, 'id' | 'userId' | 'timestamp'>
  ): Promise<AuditLogRecord> {
    this.assertValidUserId(userId);
    const db = this.getDb();
    const id = `audit-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const timestamp = new Date().toISOString();

    const record: AuditLogRecord = {
      id,
      userId,
      ...entry,
      timestamp,
    };

    await this.userDocRef(db, userId).collection('auditLogs').doc(id).set(record);
    return record;
  }
}

export const dataRepository: IDataRepository = new FirestoreRepository();
