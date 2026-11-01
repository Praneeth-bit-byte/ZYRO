import {
  AssistantChatRequest,
  AssistantChatResponse,
  RiskTier,
} from '../../shared/contracts';
import { AuthenticatedUserContext } from '../auth/auth.service';
import { ValidationError } from '../errors/app-error';
import { geminiService } from '../ai/gemini.service';
import { dataRepository } from '../persistence/firestore.repository';
import { permissionGateway } from '../permissions/gateway';

/**
 * Platform-Independent ZYRO Orchestrator
 * Coordinates permission evaluation, user-scoped memory context loading (when Firestore is configured),
 * AI response generation (both standard and streaming), and conversation persistence.
 */
export class OrchestratorService {
  private async prepareTurnContext(
    request: AssistantChatRequest,
    userContext?: AuthenticatedUserContext
  ) {
    const trimmedMessage = (request.message || '').trim();
    if (!trimmedMessage) {
      throw new ValidationError('Message content cannot be empty.');
    }

    const locale = request.locale || 'en-US';
    const platform = request.platform || 'web';
    const mode: 'chat' | 'reasoning' = request.mode === 'reasoning' ? 'reasoning' : 'chat';
    const userId = userContext?.uid || null;

    // 1. Evaluate Permission Gateway & Audit (redactSensitiveAuditDetails automatically masks any secrets in details)
    const permissionResult = await permissionGateway.evaluateAndAudit({
      userId,
      actionName: `assistant.${mode}_completion`,
      module: 'ai-orchestrator',
      riskTier: RiskTier.READ_ONLY,
      platform,
      details: `Processed ${mode} prompt (${locale}) from ${platform} adapter: "${trimmedMessage.slice(
        0,
        160
      )}"`,
    });

    // 2. Load User-Scoped Memories ONLY if Firestore is configured and user is authenticated
    let userMemoriesContext: string[] = [];
    let persistenceNotice: string | undefined;

    if (userId && dataRepository.isConfigured()) {
      try {
        const memories = await dataRepository.listMemories(userId);
        userMemoriesContext = memories.slice(0, 15).map((m) => `[${m.category}] ${m.content}`);
      } catch (err) {
        console.warn('[ZYRO Orchestrator] Could not retrieve user memories:', err);
      }
    } else if (!dataRepository.isConfigured()) {
      persistenceNotice =
        'Persistence not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY to store conversation history and memories in Cloud Firestore.';
    } else if (!userId) {
      persistenceNotice =
        'Unauthenticated session. Sign in with Firebase Authentication to persist conversation history and personal memories.';
    }

    return {
      trimmedMessage,
      locale,
      platform,
      mode,
      userId,
      permissionResult,
      userMemoriesContext,
      persistenceNotice,
    };
  }

  private async persistTurnIfConfigured(params: {
    userId: string | null;
    conversationId: string | null;
    trimmedMessage: string;
    reply: string;
    modelUsed: string;
    locale: AssistantChatRequest['locale'];
    platform: AssistantChatRequest['platform'];
    initialNotice?: string;
  }) {
    let { conversationId } = params;
    let persisted = false;
    let persistenceNotice = params.initialNotice;

    if (params.userId && dataRepository.isConfigured()) {
      try {
        if (!conversationId) {
          const createdConv = await dataRepository.createConversation(params.userId, {
            title: params.trimmedMessage.slice(0, 60),
            platformOrigin: params.platform,
            locale: params.locale,
          });
          conversationId = createdConv.id;
        }
        await dataRepository.appendMessage(params.userId, {
          conversationId,
          role: 'user',
          content: params.trimmedMessage,
          locale: params.locale,
        });
        await dataRepository.appendMessage(params.userId, {
          conversationId,
          role: 'model',
          content: params.reply,
          modelUsed: params.modelUsed,
          locale: params.locale,
        });
        persisted = true;
      } catch (err: any) {
        persistenceNotice = `Message generated, but Firestore write failed: ${
          err?.message || 'Unknown error'
        }`;
      }
    }

    return { conversationId, persisted, persistenceNotice };
  }

  public async handleChatTurn(
    request: AssistantChatRequest,
    userContext?: AuthenticatedUserContext
  ): Promise<AssistantChatResponse> {
    const startMs = Date.now();
    const ctx = await this.prepareTurnContext(request, userContext);

    const aiOutput = await geminiService.generateReply({
      message: ctx.trimmedMessage,
      history: request.history || [],
      locale: ctx.locale,
      mode: ctx.mode,
      userMemoriesContext: ctx.userMemoriesContext,
    });

    const persistenceResult = await this.persistTurnIfConfigured({
      userId: ctx.userId,
      conversationId: request.conversationId || null,
      trimmedMessage: ctx.trimmedMessage,
      reply: aiOutput.reply,
      modelUsed: aiOutput.modelUsed,
      locale: ctx.locale,
      platform: ctx.platform,
      initialNotice: ctx.persistenceNotice,
    });

    return {
      reply: aiOutput.reply,
      modelUsed: aiOutput.modelUsed,
      requestedModel: aiOutput.requestedModel,
      fallbackNotice: aiOutput.fallbackNotice,
      latencyMs: Date.now() - startMs,
      tokenUsage: aiOutput.tokenUsage,
      conversationId: persistenceResult.conversationId,
      persisted: persistenceResult.persisted,
      persistenceNotice: persistenceResult.persistenceNotice,
      auditEntry: ctx.permissionResult.auditEntry,
      timestamp: new Date().toISOString(),
    };
  }

  public async handleChatTurnStream(
    request: AssistantChatRequest,
    userContext: AuthenticatedUserContext | undefined,
    onChunk: (deltaText: string, modelUsed: string, fallbackNotice?: string) => void
  ): Promise<AssistantChatResponse> {
    const startMs = Date.now();
    const ctx = await this.prepareTurnContext(request, userContext);

    const aiOutput = await geminiService.streamReply(
      {
        message: ctx.trimmedMessage,
        history: request.history || [],
        locale: ctx.locale,
        mode: ctx.mode,
        userMemoriesContext: ctx.userMemoriesContext,
      },
      onChunk
    );

    const persistenceResult = await this.persistTurnIfConfigured({
      userId: ctx.userId,
      conversationId: request.conversationId || null,
      trimmedMessage: ctx.trimmedMessage,
      reply: aiOutput.reply,
      modelUsed: aiOutput.modelUsed,
      locale: ctx.locale,
      platform: ctx.platform,
      initialNotice: ctx.persistenceNotice,
    });

    return {
      reply: aiOutput.reply,
      modelUsed: aiOutput.modelUsed,
      requestedModel: aiOutput.requestedModel,
      fallbackNotice: aiOutput.fallbackNotice,
      latencyMs: Date.now() - startMs,
      tokenUsage: aiOutput.tokenUsage,
      conversationId: persistenceResult.conversationId,
      persisted: persistenceResult.persisted,
      persistenceNotice: persistenceResult.persistenceNotice,
      auditEntry: ctx.permissionResult.auditEntry,
      timestamp: new Date().toISOString(),
    };
  }
}

export const orchestratorService = new OrchestratorService();
