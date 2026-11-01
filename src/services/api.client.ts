import {
  ApiErrorPayload,
  AssistantChatRequest,
  AssistantChatResponse,
  AuditLogsListResponse,
  MemoriesListResponse,
  MemoryRecord,
  PersistenceConfigurationStatus,
  SystemDiagnosticsResponse,
  TaskRecord,
  TasksListResponse,
  WorkflowsListResponse,
} from '../shared/contracts';

const DEFAULT_UNCONFIGURED_PERSISTENCE: PersistenceConfigurationStatus = {
  provider: 'firebase-firestore',
  configured: false,
  projectId: null,
  databaseId: '(default)',
  missingEnvVars: ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'],
  message:
    'Persistence not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in environment variables to enable Cloud Firestore storage.',
};

export class ZyroApiClientError extends Error {
  public readonly code: ApiErrorPayload['error']['code'];
  public readonly missingEnvVars?: string[];

  constructor(payload: ApiErrorPayload['error']) {
    super(payload.message);
    this.name = 'ZyroApiClientError';
    this.code = payload.code;
    this.missingEnvVars = payload.missingEnvVars;
  }
}

class ZyroApiClient {
  private idToken: string | null = null;

  public setAuthToken(token: string | null): void {
    this.idToken = token;
  }

  public getAuthToken(): string | null {
    return this.idToken;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(extra || {}),
    };
    if (this.idToken) {
      headers['Authorization'] = `Bearer ${this.idToken}`;
    }
    return headers;
  }

  private async request<T>(path: string, options: RequestInit = {}, attempt = 0): Promise<T> {
    const headers = this.buildHeaders(options.headers as Record<string, string>);
    const method = (options.method || 'GET').toUpperCase();

    const res = await fetch(`/api/v1${path}`, {
      ...options,
      cache: 'no-store',
      headers,
    });

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const rawText = await res.text().catch(() => '');

    let data: any = null;
    if (rawText && (contentType.includes('application/json') || rawText.trim().startsWith('{'))) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = null;
      }
    }

    // If reverse proxy (nginx) intercepted a transient 502/503 with warmup.html (200 OK text/html) on a GET request, retry once
    if (
      (!data || typeof data !== 'object') &&
      method === 'GET' &&
      attempt < 1 &&
      contentType.includes('text/html')
    ) {
      await new Promise((r) => setTimeout(r, 350));
      return this.request<T>(path, options, attempt + 1);
    }

    if (!res.ok) {
      if (data && typeof data === 'object' && data.error) {
        throw new ZyroApiClientError(data.error);
      }
      throw new ZyroApiClientError({
        code: 'INTERNAL_ERROR',
        message: `Request to /api/v1${path} failed with HTTP status ${res.status}.`,
      });
    }

    if (!data || typeof data !== 'object') {
      throw new ZyroApiClientError({
        code: 'INTERNAL_ERROR',
        message: `Received an unexpected non-JSON response from /api/v1${path}.`,
      });
    }

    return data as T;
  }

  public getSystemStatus(): Promise<SystemDiagnosticsResponse> {
    return this.request<SystemDiagnosticsResponse>('/system/status');
  }

  public sendChatMessage(
    payload: AssistantChatRequest,
    signal?: AbortSignal
  ): Promise<AssistantChatResponse> {
    return this.request<AssistantChatResponse>('/assistant/chat', {
      method: 'POST',
      body: JSON.stringify(payload),
      signal,
    });
  }

  /**
   * Progressive SSE Streaming Chat Request with AbortSignal cancellation support.
   * Streams text chunks as they arrive from the server and resolves with the final `AssistantChatResponse`.
   */
  public async streamChatMessage(
    payload: AssistantChatRequest,
    onChunk: (deltaText: string, modelUsed?: string, fallbackNotice?: string) => void,
    signal?: AbortSignal
  ): Promise<AssistantChatResponse> {
    const res = await fetch('/api/v1/assistant/chat/stream', {
      method: 'POST',
      cache: 'no-store',
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok || !res.body) {
      return this.sendChatMessage(payload, signal);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalPayload: AssistantChatResponse | null = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';

      for (const block of blocks) {
        const lines = block.split('\n');
        let eventName = 'message';
        let dataStr = '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataStr += line.slice(5).trim();
          }
        }

        if (!dataStr) continue;
        let parsed: any;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (eventName === 'chunk') {
          if (parsed?.deltaText) {
            onChunk(parsed.deltaText, parsed.modelUsed, parsed.fallbackNotice);
          }
        } else if (eventName === 'done') {
          finalPayload = parsed as AssistantChatResponse;
        } else if (eventName === 'error') {
          throw new ZyroApiClientError({
            code: parsed?.code || 'INTERNAL_ERROR',
            message: parsed?.message || 'Streaming request failed.',
          });
        }
      }
    }

    if (!finalPayload) {
      return this.sendChatMessage(payload, signal);
    }

    return finalPayload;
  }

  public async listMemories(): Promise<MemoriesListResponse> {
    try {
      const data = await this.request<Partial<MemoriesListResponse>>('/memories');
      return {
        configured: Boolean(data?.configured),
        memories: Array.isArray(data?.memories) ? data.memories : [],
        persistence: data?.persistence || DEFAULT_UNCONFIGURED_PERSISTENCE,
      };
    } catch (err: any) {
      if (err instanceof ZyroApiClientError && err.code === 'PERSISTENCE_NOT_CONFIGURED') {
        return {
          configured: false,
          memories: [],
          persistence: {
            ...DEFAULT_UNCONFIGURED_PERSISTENCE,
            missingEnvVars: err.missingEnvVars || DEFAULT_UNCONFIGURED_PERSISTENCE.missingEnvVars,
            message: err.message || DEFAULT_UNCONFIGURED_PERSISTENCE.message,
          },
        };
      }
      throw err;
    }
  }

  public createMemory(input: {
    category: MemoryRecord['category'];
    content: string;
    tags: string[];
  }): Promise<{ memory: MemoryRecord }> {
    return this.request<{ memory: MemoryRecord }>('/memories', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  public deleteMemory(memoryId: string): Promise<{ deletedId: string }> {
    return this.request<{ deletedId: string }>(`/memories/${encodeURIComponent(memoryId)}`, {
      method: 'DELETE',
    });
  }

  public async listTasks(): Promise<TasksListResponse> {
    try {
      const data = await this.request<Partial<TasksListResponse>>('/tasks');
      return {
        configured: Boolean(data?.configured),
        tasks: Array.isArray(data?.tasks) ? data.tasks : [],
        persistence: data?.persistence || DEFAULT_UNCONFIGURED_PERSISTENCE,
      };
    } catch (err: any) {
      if (err instanceof ZyroApiClientError && err.code === 'PERSISTENCE_NOT_CONFIGURED') {
        return {
          configured: false,
          tasks: [],
          persistence: {
            ...DEFAULT_UNCONFIGURED_PERSISTENCE,
            missingEnvVars: err.missingEnvVars || DEFAULT_UNCONFIGURED_PERSISTENCE.missingEnvVars,
            message: err.message || DEFAULT_UNCONFIGURED_PERSISTENCE.message,
          },
        };
      }
      throw err;
    }
  }

  public createTask(input: {
    title: string;
    category: TaskRecord['category'];
    priority: TaskRecord['priority'];
    dueDate?: string;
  }): Promise<{ task: TaskRecord }> {
    return this.request<{ task: TaskRecord }>('/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  public updateTaskStatus(
    taskId: string,
    status: TaskRecord['status']
  ): Promise<{ task: TaskRecord }> {
    return this.request<{ task: TaskRecord }>(`/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  }

  public deleteTask(taskId: string): Promise<{ deletedId: string }> {
    return this.request<{ deletedId: string }>(`/tasks/${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
    });
  }

  public async listWorkflows(): Promise<WorkflowsListResponse> {
    try {
      const data = await this.request<Partial<WorkflowsListResponse>>('/workflows');
      return {
        configured: Boolean(data?.configured),
        workflows: Array.isArray(data?.workflows) ? data.workflows : [],
        persistence: data?.persistence || DEFAULT_UNCONFIGURED_PERSISTENCE,
      };
    } catch (err: any) {
      if (err instanceof ZyroApiClientError && err.code === 'PERSISTENCE_NOT_CONFIGURED') {
        return {
          configured: false,
          workflows: [],
          persistence: {
            ...DEFAULT_UNCONFIGURED_PERSISTENCE,
            missingEnvVars: err.missingEnvVars || DEFAULT_UNCONFIGURED_PERSISTENCE.missingEnvVars,
            message: err.message || DEFAULT_UNCONFIGURED_PERSISTENCE.message,
          },
        };
      }
      throw err;
    }
  }

  public async listAuditLogs(): Promise<AuditLogsListResponse> {
    try {
      const data = await this.request<Partial<AuditLogsListResponse>>('/audit');
      return {
        configured: Boolean(data?.configured),
        auditLogs: Array.isArray(data?.auditLogs) ? data.auditLogs : [],
        persistence: data?.persistence || DEFAULT_UNCONFIGURED_PERSISTENCE,
      };
    } catch (err: any) {
      if (err instanceof ZyroApiClientError && err.code === 'PERSISTENCE_NOT_CONFIGURED') {
        return {
          configured: false,
          auditLogs: [],
          persistence: {
            ...DEFAULT_UNCONFIGURED_PERSISTENCE,
            missingEnvVars: err.missingEnvVars || DEFAULT_UNCONFIGURED_PERSISTENCE.missingEnvVars,
            message: err.message || DEFAULT_UNCONFIGURED_PERSISTENCE.message,
          },
        };
      }
      throw err;
    }
  }
}

export const zyroApi = new ZyroApiClient();
