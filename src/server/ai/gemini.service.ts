import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { SupportedLocale, TokenUsageMetadata } from '../../shared/contracts';
import { getServerConfig, validateModelId, ModelValidationStatus } from '../config/env';
import { AIConfigurationError, ModelConfigurationError } from '../errors/app-error';

export interface GenerateAssistantReplyInput {
  message: string;
  history: Array<{ role: 'user' | 'model'; content: string }>;
  locale: SupportedLocale;
  mode: 'chat' | 'reasoning';
  userMemoriesContext?: string[];
}

export interface GenerateAssistantReplyOutput {
  reply: string;
  modelUsed: string;
  requestedModel: string;
  fallbackNotice?: string;
  tokenUsage?: TokenUsageMetadata;
}

const FAST_CHAT_FALLBACK_CHAIN = [
  'gemini-3.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
];

const REASONING_FALLBACK_CHAIN = [
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite',
];

/**
 * Server-Side Google AI (`@google/genai`) Service
 *
 * - Reuses a singleton `GoogleGenAI` client with Google AI API's minimum 10s deadline (`timeout: 10000`).
 * - Maintains a circuit-breaker cooldown cache (`modelCooldownMap`) so quota-exhausted (429) or overloaded (503)
 *   models are skipped in 0ms on subsequent turns instead of stalling every request.
 * - Configures `thinkingConfig` per mode (`MINIMAL` / `0` for Fast Chat; `LOW` / `512` for Deep Reasoning)
 *   to eliminate multi-second unbounded thinking delays.
 * - Extracts `usageMetadata` (prompt, response, thinking, and total tokens) on both JSON and streaming turns.
 */
export class GeminiService {
  private clientInstance: { apiKey: string; client: GoogleGenAI } | null = null;
  private verifiedModelCache = new Map<
    string,
    { status: ModelValidationStatus; expiresAt: number }
  >();
  private modelCooldownMap = new Map<string, { expiresAt: number; reason: string }>();

  private getClient(): GoogleGenAI {
    const { geminiApiKey } = getServerConfig();
    if (!geminiApiKey) {
      throw new AIConfigurationError(
        'GEMINI_API_KEY is not configured on the server. Set GEMINI_API_KEY in environment variables or the AI Studio Secrets panel.',
        ['GEMINI_API_KEY']
      );
    }

    if (this.clientInstance && this.clientInstance.apiKey === geminiApiKey) {
      return this.clientInstance.client;
    }

    const client = new GoogleGenAI({
      apiKey: geminiApiKey,
      httpOptions: {
        timeout: 10000,
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    this.clientInstance = { apiKey: geminiApiKey, client };
    return client;
  }

  public async verifyModelAvailability(modelId: string): Promise<ModelValidationStatus> {
    const staticCheck = validateModelId(modelId);
    if (!staticCheck.valid) {
      return staticCheck;
    }

    const { geminiApiKey } = getServerConfig();
    if (!geminiApiKey) {
      return {
        configuredId: staticCheck.configuredId,
        valid: false,
        error: 'Cannot verify model with Google AI API because GEMINI_API_KEY is not configured.',
      };
    }

    const now = Date.now();
    const cached = this.verifiedModelCache.get(staticCheck.configuredId);
    if (cached && cached.expiresAt > now) {
      return cached.status;
    }

    try {
      const ai = this.getClient();
      const modelInfo = await ai.models.get({ model: staticCheck.configuredId });
      if (!modelInfo || !modelInfo.name) {
        return {
          configuredId: staticCheck.configuredId,
          valid: false,
          error: `Google AI API did not return metadata for model "${staticCheck.configuredId}".`,
        };
      }

      const verifiedStatus: ModelValidationStatus = {
        configuredId: staticCheck.configuredId,
        valid: true,
      };
      this.verifiedModelCache.set(staticCheck.configuredId, {
        status: verifiedStatus,
        expiresAt: now + 30 * 60 * 1000,
      });
      return verifiedStatus;
    } catch (err: any) {
      return {
        configuredId: staticCheck.configuredId,
        valid: false,
        error: `Live Google AI API check failed for "${staticCheck.configuredId}": ${
          err?.message || String(err)
        }`,
      };
    }
  }

  public async getDiagnostics() {
    const cfg = getServerConfig();
    const [chat, reasoning, embedding, tts, transcribe] = await Promise.all([
      this.verifyModelAvailability(cfg.models.chat),
      this.verifyModelAvailability(cfg.models.reasoning),
      this.verifyModelAvailability(cfg.models.embedding),
      this.verifyModelAvailability(cfg.models.tts),
      this.verifyModelAvailability(cfg.models.transcribe),
    ]);

    return {
      apiKeyConfigured: Boolean(cfg.geminiApiKey),
      models: {
        chat,
        reasoning,
        embedding,
        tts,
        transcribe,
      },
    };
  }

  public resolveVerifiedModelIdFast(mode: 'chat' | 'reasoning'): string {
    const cfg = getServerConfig();
    const targetModelId = mode === 'reasoning' ? cfg.models.reasoning : cfg.models.chat;
    const staticValidation = validateModelId(targetModelId);

    if (!staticValidation.valid) {
      throw new ModelConfigurationError(
        staticValidation.error || `Configured model "${targetModelId}" is invalid or unavailable.`,
        {
          mode,
          configuredModelId: targetModelId,
          envVar: mode === 'reasoning' ? 'ZYRO_REASONING_MODEL' : 'ZYRO_CHAT_MODEL',
        }
      );
    }

    return staticValidation.configuredId;
  }

  private buildPromptPayload(input: GenerateAssistantReplyInput) {
    const languageDirective =
      input.locale === 'hi-IN'
        ? 'Respond naturally in Hindi (Devanagari script).'
        : input.locale === 'te-IN'
        ? 'Respond naturally in Telugu (Telugu script).'
        : 'Respond in clear, concise English.';

    const memorySection =
      input.userMemoriesContext && input.userMemoriesContext.length > 0
        ? `\nUser Memories:\n${input.userMemoriesContext.map((m) => `- ${m}`).join('\n')}\n`
        : '';

    const systemInstruction = `You are ZYRO, a personal AI assistant created by Praneeth Thota (cross-platform: Web, Windows, macOS, Linux, Android, iOS).${memorySection}
Rules:
1. Be direct, accurate, and concise. Never fabricate facts, user records, or external actions (Gmail, Calendar, desktop control, or live web search are not active in this milestone).
2. Uncertainty & Live Data: When asked for real-time/live information (e.g., live stock prices, current weather, breaking news) or unverified facts, explicitly state that live web search is not enabled and distinguish general knowledge from live data instead of guessing.
3. Ambiguous Requests: If a request lacks essential context (e.g., missing code, recipient, or target parameters), ask 1–3 brief clarifying questions.
4. Security & Permission Gateway: Enforce ZYRO's 4-Tier Permission Gateway (Tier 0 Read-Only, Tier 1 Internal Write, Tier 2 External/Device Approval Required, Tier 3 Critical Restricted). Refuse destructive commands (e.g., rm -rf), unapproved external actions, or exposing server secrets (GEMINI_API_KEY, FIREBASE_PRIVATE_KEY).
5. ${languageDirective}`;

    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    const recentHistory = (input.history || []).slice(-8);
    for (const turn of recentHistory) {
      if (turn && (turn.role === 'user' || turn.role === 'model') && turn.content?.trim()) {
        const trimmed = turn.content.trim().slice(0, 1200);
        const prev = contents[contents.length - 1];
        if (prev && prev.role === turn.role && prev.parts[0]?.text === trimmed) {
          continue;
        }
        contents.push({
          role: turn.role,
          parts: [{ text: trimmed }],
        });
      }
    }
    contents.push({
      role: 'user',
      parts: [{ text: input.message.trim() }],
    });

    return { systemInstruction, contents };
  }

  private getModelConfig(modelId: string, mode: 'chat' | 'reasoning', systemInstruction: string) {
    const config: Record<string, any> = {
      systemInstruction,
    };

    if (mode === 'chat') {
      if (modelId.startsWith('gemini-3') && !modelId.includes('lite')) {
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL };
      } else if (modelId.startsWith('gemini-2.5')) {
        config.thinkingConfig = { thinkingBudget: 0 };
      }
    } else {
      // mode === 'reasoning': use bounded LOW thinking level for fast, structured multi-step reasoning
      if (modelId.startsWith('gemini-3') && !modelId.includes('lite')) {
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
      } else if (modelId.startsWith('gemini-2.5')) {
        config.thinkingConfig = { thinkingBudget: 512 };
      }
    }

    return config;
  }

  private extractTokenUsage(usageMetadata: any): TokenUsageMetadata | undefined {
    if (!usageMetadata || typeof usageMetadata !== 'object') return undefined;
    const promptTokens = Number(usageMetadata.promptTokenCount || 0);
    const responseTokens = Number(usageMetadata.candidatesTokenCount || 0);
    const thinkingTokens = Number(usageMetadata.thoughtsTokenCount || 0);
    const totalTokens =
      Number(usageMetadata.totalTokenCount || 0) ||
      promptTokens + responseTokens + thinkingTokens;
    return {
      promptTokens,
      responseTokens,
      thinkingTokens,
      totalTokens,
    };
  }

  private isRetriableUpstreamError(err: any): boolean {
    const msg = (err?.message || String(err)).toLowerCase();
    const status = err?.status;
    return (
      status === 429 ||
      status === 503 ||
      msg.includes('429') ||
      msg.includes('503') ||
      msg.includes('quota') ||
      msg.includes('resource_exhausted') ||
      msg.includes('unavailable') ||
      msg.includes('overloaded') ||
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('aborted') ||
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('econnreset') ||
      msg.includes('socket')
    );
  }

  private recordModelCooldown(modelId: string, err: any): void {
    const msg = (err?.message || String(err)).toLowerCase();
    const isQuota =
      err?.status === 429 || msg.includes('429') || msg.includes('quota') || msg.includes('resource_exhausted');
    const durationMs = isQuota ? 10 * 60 * 1000 : 45 * 1000;
    this.modelCooldownMap.set(modelId, {
      expiresAt: Date.now() + durationMs,
      reason: isQuota ? '429 quota exhausted' : 'transient upstream timeout/503',
    });
  }

  private getCandidateModelList(primaryModel: string, mode: 'chat' | 'reasoning'): {
    candidates: string[];
    skippedPrimaryReason?: string;
  } {
    const fallbacks = mode === 'reasoning' ? REASONING_FALLBACK_CHAIN : FAST_CHAT_FALLBACK_CHAIN;
    const allUnique = [primaryModel, ...fallbacks.filter((m) => m !== primaryModel)];
    const now = Date.now();

    const available: string[] = [];
    const coolingDown: string[] = [];
    let skippedPrimaryReason: string | undefined;

    for (const m of allUnique) {
      const cd = this.modelCooldownMap.get(m);
      if (cd && cd.expiresAt > now) {
        coolingDown.push(m);
        if (m === primaryModel) {
          skippedPrimaryReason = cd.reason;
        }
      } else {
        if (cd) this.modelCooldownMap.delete(m);
        available.push(m);
      }
    }

    return {
      candidates: [...available, ...coolingDown].slice(0, 4),
      skippedPrimaryReason,
    };
  }

  public async generateReply(
    input: GenerateAssistantReplyInput
  ): Promise<GenerateAssistantReplyOutput> {
    const requestedModel = this.resolveVerifiedModelIdFast(input.mode);
    const ai = this.getClient();
    const { systemInstruction, contents } = this.buildPromptPayload(input);
    const { candidates, skippedPrimaryReason } = this.getCandidateModelList(
      requestedModel,
      input.mode
    );

    let lastError: any = null;

    for (const candidateModel of candidates) {
      try {
        const response = await ai.models.generateContent({
          model: candidateModel,
          contents,
          config: this.getModelConfig(candidateModel, input.mode, systemInstruction),
        });

        const replyText = (response.text || '').trim();
        if (!replyText) {
          throw new AIConfigurationError(
            `Model "${candidateModel}" returned an empty response payload.`
          );
        }

        const fallbackNotice =
          candidateModel !== requestedModel
            ? `Primary model "${requestedModel}" was unavailable (${
                skippedPrimaryReason || lastError?.status || 'quota/timeout'
              }); served via verified fallback model "${candidateModel}".`
            : undefined;

        return {
          reply: replyText,
          modelUsed: candidateModel,
          requestedModel,
          fallbackNotice,
          tokenUsage: this.extractTokenUsage(response.usageMetadata),
        };
      } catch (err: any) {
        lastError = err;
        if (this.isRetriableUpstreamError(err)) {
          this.recordModelCooldown(candidateModel, err);
          continue;
        }
        break;
      }
    }

    const rawMessage = lastError?.message || String(lastError);
    if (rawMessage.includes('404') || rawMessage.toLowerCase().includes('not found')) {
      throw new ModelConfigurationError(
        `Configured Google AI model "${requestedModel}" was not found or is unavailable: ${rawMessage}`,
        { modelId: requestedModel }
      );
    }
    throw new AIConfigurationError(
      `Google AI request failed (${requestedModel}): ${rawMessage}`
    );
  }

  public async streamReply(
    input: GenerateAssistantReplyInput,
    onChunk: (deltaText: string, modelUsed: string, fallbackNotice?: string) => void
  ): Promise<GenerateAssistantReplyOutput> {
    const requestedModel = this.resolveVerifiedModelIdFast(input.mode);
    const ai = this.getClient();
    const { systemInstruction, contents } = this.buildPromptPayload(input);
    const { candidates, skippedPrimaryReason } = this.getCandidateModelList(
      requestedModel,
      input.mode
    );

    let lastError: any = null;

    for (const candidateModel of candidates) {
      try {
        const stream = await ai.models.generateContentStream({
          model: candidateModel,
          contents,
          config: this.getModelConfig(candidateModel, input.mode, systemInstruction),
        });

        const fallbackNotice =
          candidateModel !== requestedModel
            ? `Primary model "${requestedModel}" was unavailable (${
                skippedPrimaryReason || 'quota/timeout'
              }); served via verified fallback model "${candidateModel}".`
            : undefined;

        let fullText = '';
        let latestUsage: TokenUsageMetadata | undefined;

        for await (const chunk of stream) {
          if (chunk.usageMetadata) {
            latestUsage = this.extractTokenUsage(chunk.usageMetadata);
          }
          const piece = chunk.text || '';
          if (piece) {
            fullText += piece;
            onChunk(piece, candidateModel, fallbackNotice);
          }
        }

        const trimmed = fullText.trim();
        if (!trimmed) {
          throw new AIConfigurationError(
            `Streaming model "${candidateModel}" returned an empty response.`
          );
        }

        return {
          reply: trimmed,
          modelUsed: candidateModel,
          requestedModel,
          fallbackNotice,
          tokenUsage: latestUsage,
        };
      } catch (err: any) {
        lastError = err;
        if (this.isRetriableUpstreamError(err)) {
          this.recordModelCooldown(candidateModel, err);
          continue;
        }
        break;
      }
    }

    const rawMessage = lastError?.message || String(lastError);
    throw new AIConfigurationError(
      `Google AI streaming request failed (${requestedModel}): ${rawMessage}`
    );
  }
}

export const geminiService = new GeminiService();
