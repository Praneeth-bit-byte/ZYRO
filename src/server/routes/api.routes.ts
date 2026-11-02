import { Router, Request, Response, NextFunction } from 'express';
import {
  AssistantChatRequest,
  AuditLogsListResponse,
  MemoriesListResponse,
  RiskTier,
  SystemDiagnosticsResponse,
  TasksListResponse,
  WorkflowsListResponse,
} from '../../shared/contracts';
import { geminiService } from '../ai/gemini.service';
import { optionalAuthMiddleware, requireUserScopedAuth } from '../auth/auth.service';
import { getFirebaseConfigurationStatus } from '../config/env';
import { ValidationError } from '../errors/app-error';
import { orchestratorService } from '../orchestrator/orchestrator.service';
import { permissionGateway } from '../permissions/gateway';
import { dataRepository } from '../persistence/firestore.repository';

export const apiRouter = Router();

// ----------------------------------------------------------------------------
// 1. System & Configuration Status (Public / Optional Auth)
// ----------------------------------------------------------------------------
apiRouter.get(
  '/system/status',
  optionalAuthMiddleware,
  async (req: Request, res: Response<SystemDiagnosticsResponse>, next: NextFunction) => {
    try {
      const aiDiag = await geminiService.getDiagnostics();
      const fbDiag = getFirebaseConfigurationStatus();

      res.json({
        service: 'ZYRO Core Backend',
        version: '0.1.2-firebase-admin',
        timestamp: new Date().toISOString(),
        ai: aiDiag,
        persistence: fbDiag,
        auth: {
          provider: 'firebase-auth',
          configured: fbDiag.configured,
          authenticatedUser: req.userContext
            ? {
                uid: req.userContext.uid,
                email: req.userContext.email,
                mode: req.userContext.mode,
              }
            : null,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ----------------------------------------------------------------------------
// 2. Assistant Conversation Turn (JSON + Progressive SSE Streaming)
// ----------------------------------------------------------------------------
apiRouter.post(
  '/assistant/chat',
  optionalAuthMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = req.body as AssistantChatRequest;
      const response = await orchestratorService.handleChatTurn(payload, req.userContext);
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

apiRouter.post(
  '/assistant/chat/stream',
  optionalAuthMiddleware,
  async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const payload = req.body as AssistantChatRequest;
      const finalResponse = await orchestratorService.handleChatTurnStream(
        payload,
        req.userContext,
        (deltaText, modelUsed, fallbackNotice) => {
          sendEvent('chunk', { deltaText, modelUsed, fallbackNotice });
        }
      );
      sendEvent('done', finalResponse);
      res.end();
    } catch (err: any) {
      sendEvent('error', {
        code: err?.code || 'INTERNAL_ERROR',
        message: err?.message || 'Failed to stream assistant response.',
      });
      res.end();
    }
  }
);

// ----------------------------------------------------------------------------
// 3. User-Scoped Conversations & Messages
// ----------------------------------------------------------------------------
apiRouter.get(
  '/conversations',
  optionalAuthMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fbDiag = getFirebaseConfigurationStatus();
      const isConfigured = dataRepository.isConfigured();
      if (!isConfigured || !req.userContext) {
        res.json({
          configured: isConfigured,
          conversations: [],
          persistence: fbDiag,
        });
        return;
      }
      const conversations = await dataRepository.listConversations(req.userContext.uid);
      res.json({
        configured: true,
        conversations,
        persistence: fbDiag,
      });
    } catch (err) {
      next(err);
    }
  }
);

apiRouter.post(
  '/conversations',
  requireUserScopedAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.userContext!.uid;
      const { title, platformOrigin = 'web', locale = 'en-US' } = req.body;
      if (!title || typeof title !== 'string' || !title.trim()) {
        throw new ValidationError('Conversation title is required.');
      }

      const conversation = await dataRepository.createConversation(uid, {
        title: title.trim(),
        platformOrigin,
        locale,
      });
      res.status(201).json({ conversation });
    } catch (err) {
      next(err);
    }
  }
);

apiRouter.get(
  '/conversations/:conversationId/messages',
  requireUserScopedAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.userContext!.uid;
      const conversationId = String(req.params.conversationId);
      const messages = await dataRepository.listMessages(uid, conversationId);
      res.json({ messages });
    } catch (err) {
      next(err);
    }
  }
);

apiRouter.post(
  '/conversations/:conversationId/messages',
  requireUserScopedAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.userContext!.uid;
      const conversationId = String(req.params.conversationId);
      const { role = 'user', content, modelUsed, locale = 'en-US' } = req.body;
      if (!content || typeof content !== 'string' || !content.trim()) {
        throw new ValidationError('Message content is required.');
      }
      if (role !== 'user' && role !== 'model' && role !== 'system') {
        throw new ValidationError('Invalid message role.');
      }

      const message = await dataRepository.appendMessage(uid, {
        conversationId,
        role,
        content: content.trim(),
        modelUsed: modelUsed ? String(modelUsed) : undefined,
        locale,
      });
      res.status(201).json({ message });
    } catch (err) {
      next(err);
    }
  }
);

// ----------------------------------------------------------------------------
// 4. User-Scoped Long-Term Memories
// ----------------------------------------------------------------------------
apiRouter.get(
  '/memories',
  optionalAuthMiddleware,
  async (req: Request, res: Response<MemoriesListResponse>, next: NextFunction) => {
    try {
      const fbDiag = getFirebaseConfigurationStatus();
      const isConfigured = dataRepository.isConfigured();
      if (!isConfigured || !req.userContext) {
        res.json({
          configured: isConfigured,
          memories: [],
          persistence: fbDiag,
        });
        return;
      }
      const memories = await dataRepository.listMemories(req.userContext.uid);
      res.json({
        configured: true,
        memories,
        persistence: fbDiag,
      });
    } catch (err) {
      next(err);
    }
  }
);

apiRouter.post(
  '/memories',
  requireUserScopedAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.userContext!.uid;
      const { category = 'Personal Fact', content, tags = [], platform = 'web' } = req.body;
      if (!content || typeof content !== 'string' || !content.trim()) {
        throw new ValidationError('Memory content is required.');
      }

      await permissionGateway.evaluateAndAudit({
        userId: uid,
        actionName: 'memory.create',
        module: 'long-term-memory',
        riskTier: RiskTier.INTERNAL_WRITE,
        platform,
        details: `Created ${category} memory record.`,
      });

      const created = await dataRepository.createMemory(uid, {
        category,
        content: content.trim(),
        tags: Array.isArray(tags) ? tags.map(String) : [],
        source: 'User Entry',
      });
      res.status(201).json({ memory: created });
    } catch (err) {
      next(err);
    }
  }
);

apiRouter.delete(
  '/memories/:memoryId',
  requireUserScopedAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.userContext!.uid;
      const memoryId = String(req.params.memoryId);
      await permissionGateway.evaluateAndAudit({
        userId: uid,
        actionName: 'memory.delete',
        module: 'long-term-memory',
        riskTier: RiskTier.INTERNAL_WRITE,
        platform: 'web',
        details: `Deleted memory record ${memoryId}.`,
      });
      await dataRepository.deleteMemory(uid, memoryId);
      res.json({ deletedId: memoryId });
    } catch (err) {
      next(err);
    }
  }
);

// ----------------------------------------------------------------------------
// 5. User-Scoped Tasks
// ----------------------------------------------------------------------------
apiRouter.get(
  '/tasks',
  optionalAuthMiddleware,
  async (req: Request, res: Response<TasksListResponse>, next: NextFunction) => {
    try {
      const fbDiag = getFirebaseConfigurationStatus();
      const isConfigured = dataRepository.isConfigured();
      if (!isConfigured || !req.userContext) {
        res.json({
          configured: isConfigured,
          tasks: [],
          persistence: fbDiag,
        });
        return;
      }
      const tasks = await dataRepository.listTasks(req.userContext.uid);
      res.json({
        configured: true,
        tasks,
        persistence: fbDiag,
      });
    } catch (err) {
      next(err);
    }
  }
);

apiRouter.post(
  '/tasks',
  requireUserScopedAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.userContext!.uid;
      const {
        title,
        description,
        category = 'Productivity',
        priority = 'Medium',
        dueDate,
        platform = 'web',
      } = req.body;
      if (!title || typeof title !== 'string' || !title.trim()) {
        throw new ValidationError('Task title is required.');
      }

      await permissionGateway.evaluateAndAudit({
        userId: uid,
        actionName: 'task.create',
        module: 'productivity',
        riskTier: RiskTier.INTERNAL_WRITE,
        platform,
        details: `Created task "${title.trim()}".`,
      });

      const created = await dataRepository.createTask(uid, {
        title: title.trim(),
        description: description ? String(description).trim() : undefined,
        category,
        priority,
        status: 'pending',
        dueDate: dueDate ? String(dueDate) : undefined,
      });
      res.status(201).json({ task: created });
    } catch (err) {
      next(err);
    }
  }
);

apiRouter.patch(
  '/tasks/:taskId',
  requireUserScopedAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.userContext!.uid;
      const taskId = String(req.params.taskId);
      const { status } = req.body;
      if (!['pending', 'in_progress', 'completed'].includes(status)) {
        throw new ValidationError('Valid task status is required.');
      }

      await permissionGateway.evaluateAndAudit({
        userId: uid,
        actionName: 'task.update_status',
        module: 'productivity',
        riskTier: RiskTier.INTERNAL_WRITE,
        platform: 'web',
        details: `Updated task ${taskId} to ${status}.`,
      });

      const updated = await dataRepository.updateTaskStatus(uid, taskId, status);
      res.json({ task: updated });
    } catch (err) {
      next(err);
    }
  }
);

apiRouter.delete(
  '/tasks/:taskId',
  requireUserScopedAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.userContext!.uid;
      const taskId = String(req.params.taskId);
      await permissionGateway.evaluateAndAudit({
        userId: uid,
        actionName: 'task.delete',
        module: 'productivity',
        riskTier: RiskTier.INTERNAL_WRITE,
        platform: 'web',
        details: `Deleted task ${taskId}.`,
      });
      await dataRepository.deleteTask(uid, taskId);
      res.json({ deletedId: taskId });
    } catch (err) {
      next(err);
    }
  }
);

// ----------------------------------------------------------------------------
// 6. User-Scoped Workflows & Audit Logs
// ----------------------------------------------------------------------------
apiRouter.get(
  '/workflows',
  optionalAuthMiddleware,
  async (req: Request, res: Response<WorkflowsListResponse>, next: NextFunction) => {
    try {
      const fbDiag = getFirebaseConfigurationStatus();
      const isConfigured = dataRepository.isConfigured();
      if (!isConfigured || !req.userContext) {
        res.json({
          configured: isConfigured,
          workflows: [],
          persistence: fbDiag,
        });
        return;
      }
      const workflows = await dataRepository.listWorkflows(req.userContext.uid);
      res.json({
        configured: true,
        workflows,
        persistence: fbDiag,
      });
    } catch (err) {
      next(err);
    }
  }
);

apiRouter.get(
  '/audit',
  optionalAuthMiddleware,
  async (req: Request, res: Response<AuditLogsListResponse>, next: NextFunction) => {
    try {
      const fbDiag = getFirebaseConfigurationStatus();
      const isConfigured = dataRepository.isConfigured();
      if (!isConfigured || !req.userContext) {
        res.json({
          configured: isConfigured,
          auditLogs: [],
          persistence: fbDiag,
        });
        return;
      }
      const logs = await dataRepository.listAuditLogs(req.userContext.uid);
      res.json({
        configured: true,
        auditLogs: logs,
        persistence: fbDiag,
      });
    } catch (err) {
      next(err);
    }
  }
);
