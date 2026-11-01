import {
  UserProfile,
  ConversationRecord,
  MessageRecord,
  MemoryRecord,
  TaskRecord,
  WorkflowRecord,
  AuditLogRecord,
} from '../../shared/contracts';

/**
 * Clean Data-Access Abstraction (`IDataRepository`)
 * Decouples ZYRO's business logic and orchestrator from the underlying database engine.
 * Every operation is strictly scoped by `userId` to enforce multi-tenant data isolation.
 */
export interface IDataRepository {
  isConfigured(): boolean;

  // Users
  getUserProfile(userId: string): Promise<UserProfile | null>;
  upsertUserProfile(userId: string, profile: Partial<UserProfile>): Promise<UserProfile>;

  // Conversations & Messages
  listConversations(userId: string): Promise<ConversationRecord[]>;
  createConversation(
    userId: string,
    data: Omit<ConversationRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
  ): Promise<ConversationRecord>;
  listMessages(userId: string, conversationId: string): Promise<MessageRecord[]>;
  appendMessage(
    userId: string,
    data: Omit<MessageRecord, 'id' | 'userId' | 'createdAt'>
  ): Promise<MessageRecord>;

  // Long-Term Memories
  listMemories(userId: string): Promise<MemoryRecord[]>;
  createMemory(
    userId: string,
    data: Omit<MemoryRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryRecord>;
  deleteMemory(userId: string, memoryId: string): Promise<void>;

  // Productivity Tasks
  listTasks(userId: string): Promise<TaskRecord[]>;
  createTask(
    userId: string,
    data: Omit<TaskRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
  ): Promise<TaskRecord>;
  updateTaskStatus(
    userId: string,
    taskId: string,
    status: TaskRecord['status']
  ): Promise<TaskRecord>;
  deleteTask(userId: string, taskId: string): Promise<void>;

  // Workflows
  listWorkflows(userId: string): Promise<WorkflowRecord[]>;
  createWorkflow(
    userId: string,
    data: Omit<WorkflowRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'lastRunAt'>
  ): Promise<WorkflowRecord>;

  // Security & Execution Audit Logs
  listAuditLogs(userId: string, limit?: number): Promise<AuditLogRecord[]>;
  appendAuditLog(
    userId: string,
    entry: Omit<AuditLogRecord, 'id' | 'userId' | 'timestamp'>
  ): Promise<AuditLogRecord>;
}
