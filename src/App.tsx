import React, { useState, useEffect, useRef } from 'react';
import {
  MessageSquare,
  Brain,
  CheckSquare,
  ShieldCheck,
  Settings,
  Send,
  Plus,
  Trash2,
  Sun,
  Moon,
  Check,
  AlertCircle,
  Volume2,
  VolumeX,
  RefreshCw,
  Menu,
  X,
} from 'lucide-react';
import {
  AuditLogRecord,
  MemoryRecord,
  PersistenceConfigurationStatus,
  RiskTier,
  SupportedLocale,
  SystemDiagnosticsResponse,
  TaskRecord,
  TokenUsageMetadata,
} from './shared/contracts';
import { platformAdapter } from './adapters/platform.adapter';
import { zyroApi, ZyroApiClientError } from './services/api.client';

type ActiveModule = 'assistant' | 'memory' | 'tasks' | 'audit' | 'system';

interface ConversationTurn {
  id: string;
  role: 'user' | 'model';
  content: string;
  timestamp: string;
  modelUsed?: string;
  latencyMs?: number;
  tokenUsage?: TokenUsageMetadata;
  persisted?: boolean;
  isStreaming?: boolean;
}

const LOCALE_LABELS: Record<SupportedLocale, string> = {
  'en-US': 'English',
  'hi-IN': 'Hindi (हिन्दी)',
  'te-IN': 'Telugu (తెలుగు)',
};

const RISK_TIER_LABELS: Record<RiskTier, string> = {
  [RiskTier.READ_ONLY]: 'Tier 0 · Read-Only',
  [RiskTier.INTERNAL_WRITE]: 'Tier 1 · Internal Write',
  [RiskTier.EXTERNAL_OR_DEVICE]: 'Tier 2 · Approval Required',
  [RiskTier.CRITICAL_RESTRICTED]: 'Tier 3 · Restricted',
};

export default function App() {
  const [darkMode, setDarkMode] = useState<boolean>(true);
  const [activeModule, setActiveModule] = useState<ActiveModule>('assistant');
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);

  // Platform & Preferences
  const capabilities = platformAdapter.getCapabilities();
  const [locale, setLocale] = useState<SupportedLocale>('en-US');
  const [reasoningMode, setReasoningMode] = useState<'chat' | 'reasoning'>('chat');
  const [voiceOutputEnabled, setVoiceOutputEnabled] = useState<boolean>(false);

  // System Diagnostics
  const [diagnostics, setDiagnostics] = useState<SystemDiagnosticsResponse | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState<boolean>(true);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);

  // Assistant Conversation State (No fabricated history or sample widgets)
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(undefined);
  const [promptInput, setPromptInput] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [hasFirstStreamChunk, setHasFirstStreamChunk] = useState<boolean>(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [persistenceNotice, setPersistenceNotice] = useState<string | null>(null);
  const [sessionAuditTrail, setSessionAuditTrail] = useState<
    Array<Omit<AuditLogRecord, 'id' | 'userId'>>
  >([]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Module Data State (Loaded on demand only when user opens the module)
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [memoriesPersistence, setMemoriesPersistence] =
    useState<PersistenceConfigurationStatus | null>(null);
  const [memoriesLoading, setMemoriesLoading] = useState<boolean>(false);
  const [memoriesError, setMemoriesError] = useState<string | null>(null);
  const [newMemoryCategory, setNewMemoryCategory] =
    useState<MemoryRecord['category']>('Personal Fact');
  const [newMemoryContent, setNewMemoryContent] = useState<string>('');
  const [newMemoryTags, setNewMemoryTags] = useState<string>('');

  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [tasksPersistence, setTasksPersistence] =
    useState<PersistenceConfigurationStatus | null>(null);
  const [tasksLoading, setTasksLoading] = useState<boolean>(false);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState<string>('');
  const [newTaskCategory, setNewTaskCategory] = useState<TaskRecord['category']>('Development');
  const [newTaskPriority, setNewTaskPriority] = useState<TaskRecord['priority']>('High');

  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);
  const [auditPersistence, setAuditPersistence] =
    useState<PersistenceConfigurationStatus | null>(null);
  const [auditLoading, setAuditLoading] = useState<boolean>(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  // Auth Token Input for testing verified Firebase ID tokens when Firebase is configured
  const [authTokenDraft, setAuthTokenDraft] = useState<string>('');

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [darkMode]);

  useEffect(() => {
    loadSystemDiagnostics();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, isGenerating]);

  // Load real module data only when user navigates to the specific module
  useEffect(() => {
    if (activeModule === 'memory') {
      loadMemories();
    } else if (activeModule === 'tasks') {
      loadTasks();
    } else if (activeModule === 'audit') {
      loadAuditLogs();
    } else if (activeModule === 'system') {
      loadSystemDiagnostics();
    }
  }, [activeModule]);

  function sanitizeUiErrorMessage(err: any, fallback: string): string {
    const raw = typeof err?.message === 'string' ? err.message.trim() : '';
    if (!raw) return fallback;
    if (
      raw.includes('Cannot read properties of null') ||
      raw.includes('Cannot read properties of undefined') ||
      raw.includes('is not an object') ||
      raw.includes('Unexpected token')
    ) {
      return 'Persistence not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in environment variables to enable Cloud Firestore storage.';
    }
    return raw;
  }

  async function loadSystemDiagnostics() {
    setDiagnosticsLoading(true);
    setDiagnosticsError(null);
    try {
      const status = await zyroApi.getSystemStatus();
      setDiagnostics(status);
    } catch (err: any) {
      setDiagnosticsError(
        sanitizeUiErrorMessage(err, 'Unable to reach ZYRO backend diagnostics endpoint.')
      );
    } finally {
      setDiagnosticsLoading(false);
    }
  }

  async function loadMemories() {
    setMemoriesLoading(true);
    setMemoriesError(null);
    try {
      const res = await zyroApi.listMemories();
      const safeMemories = Array.isArray(res?.memories) ? res.memories : [];
      setMemories(safeMemories);
      setMemoriesPersistence(res?.persistence || diagnostics?.persistence || null);
    } catch (err: any) {
      setMemories([]);
      if (err instanceof ZyroApiClientError && err.code === 'PERSISTENCE_NOT_CONFIGURED') {
        setMemoriesError(null);
      } else {
        setMemoriesError(sanitizeUiErrorMessage(err, 'Unable to load memories.'));
      }
    } finally {
      setMemoriesLoading(false);
    }
  }

  async function loadTasks() {
    setTasksLoading(true);
    setTasksError(null);
    try {
      const res = await zyroApi.listTasks();
      const safeTasks = Array.isArray(res?.tasks) ? res.tasks : [];
      setTasks(safeTasks);
      setTasksPersistence(res?.persistence || diagnostics?.persistence || null);
    } catch (err: any) {
      setTasks([]);
      if (err instanceof ZyroApiClientError && err.code === 'PERSISTENCE_NOT_CONFIGURED') {
        setTasksError(null);
      } else {
        setTasksError(sanitizeUiErrorMessage(err, 'Unable to load tasks.'));
      }
    } finally {
      setTasksLoading(false);
    }
  }

  async function loadAuditLogs() {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const res = await zyroApi.listAuditLogs();
      const safeAuditLogs = Array.isArray(res?.auditLogs) ? res.auditLogs : [];
      setAuditLogs(safeAuditLogs);
      setAuditPersistence(res?.persistence || diagnostics?.persistence || null);
    } catch (err: any) {
      setAuditLogs([]);
      if (err instanceof ZyroApiClientError && err.code === 'PERSISTENCE_NOT_CONFIGURED') {
        setAuditError(null);
      } else {
        setAuditError(sanitizeUiErrorMessage(err, 'Unable to load persistent audit logs.'));
      }
    } finally {
      setAuditLoading(false);
    }
  }

  function handleCancelGeneration() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsGenerating(false);
    setHasFirstStreamChunk(false);
  }

  async function handleSendPrompt(e: React.FormEvent) {
    e.preventDefault();
    const message = promptInput.trim();
    if (!message || isGenerating) return;

    const nowLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const userTurnId = `turn-user-${Date.now()}`;
    const streamingModelTurnId = `turn-model-${Date.now() + 1}`;

    const userTurn: ConversationTurn = {
      id: userTurnId,
      role: 'user',
      content: message,
      timestamp: nowLabel,
    };

    const historyPayload = turns
      .filter((t) => !t.isStreaming && t.content.trim())
      .map((t) => ({ role: t.role, content: t.content }));

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setTurns((prev) => [...prev, userTurn]);
    setPromptInput('');
    setIsGenerating(true);
    setHasFirstStreamChunk(false);
    setChatError(null);

    try {
      let streamedContent = '';
      const response = await zyroApi.streamChatMessage(
        {
          message,
          conversationId: activeConversationId,
          history: historyPayload,
          locale,
          platform: capabilities.platform,
          mode: reasoningMode,
        },
        (deltaText, modelUsed) => {
          streamedContent += deltaText;
          setHasFirstStreamChunk(true);
          setTurns((prev) => {
            const exists = prev.some((t) => t.id === streamingModelTurnId);
            if (!exists) {
              return [
                ...prev,
                {
                  id: streamingModelTurnId,
                  role: 'model',
                  content: streamedContent,
                  timestamp: nowLabel,
                  modelUsed,
                  isStreaming: true,
                },
              ];
            }
            return prev.map((t) =>
              t.id === streamingModelTurnId
                ? { ...t, content: streamedContent, modelUsed, isStreaming: true }
                : t
            );
          });
        },
        controller.signal
      );

      if (response.conversationId) {
        setActiveConversationId(response.conversationId);
      }

      if (response.persistenceNotice) {
        setPersistenceNotice(response.persistenceNotice);
      } else {
        setPersistenceNotice(null);
      }

      if (response.auditEntry) {
        setSessionAuditTrail((prev) => [response.auditEntry, ...prev]);
      }

      const finalTurn: ConversationTurn = {
        id: streamingModelTurnId,
        role: 'model',
        content: response.reply,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        modelUsed: response.modelUsed,
        latencyMs: response.latencyMs,
        tokenUsage: response.tokenUsage,
        persisted: response.persisted,
        isStreaming: false,
      };

      setTurns((prev) => {
        const exists = prev.some((t) => t.id === streamingModelTurnId);
        if (!exists) return [...prev, finalTurn];
        return prev.map((t) => (t.id === streamingModelTurnId ? finalTurn : t));
      });

      if (voiceOutputEnabled) {
        platformAdapter.speakText(response.reply, locale);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || controller.signal.aborted) {
        return;
      }
      const messageText =
        err instanceof ZyroApiClientError
          ? `${err.message}`
          : err?.message || 'Failed to communicate with ZYRO backend.';
      setChatError(messageText);
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsGenerating(false);
      setHasFirstStreamChunk(false);
    }
  }

  async function handleCreateMemory(e: React.FormEvent) {
    e.preventDefault();
    if (!newMemoryContent.trim()) return;
    setMemoriesError(null);
    try {
      const tags = newMemoryTags
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      const res = await zyroApi.createMemory({
        category: newMemoryCategory,
        content: newMemoryContent.trim(),
        tags,
      });
      if (res?.memory) {
        setMemories((prev) => [res.memory, ...prev]);
      }
      setNewMemoryContent('');
      setNewMemoryTags('');
    } catch (err: any) {
      setMemoriesError(sanitizeUiErrorMessage(err, 'Failed to store memory.'));
    }
  }

  async function handleDeleteMemory(memoryId: string) {
    setMemoriesError(null);
    try {
      await zyroApi.deleteMemory(memoryId);
      setMemories((prev) => prev.filter((m) => m.id !== memoryId));
    } catch (err: any) {
      setMemoriesError(sanitizeUiErrorMessage(err, 'Failed to delete memory.'));
    }
  }

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;
    setTasksError(null);
    try {
      const res = await zyroApi.createTask({
        title: newTaskTitle.trim(),
        category: newTaskCategory,
        priority: newTaskPriority,
      });
      if (res?.task) {
        setTasks((prev) => [res.task, ...prev]);
      }
      setNewTaskTitle('');
    } catch (err: any) {
      setTasksError(sanitizeUiErrorMessage(err, 'Failed to create task.'));
    }
  }

  async function handleToggleTaskStatus(task: TaskRecord) {
    setTasksError(null);
    const nextStatus: TaskRecord['status'] =
      task.status === 'completed' ? 'pending' : 'completed';
    try {
      const res = await zyroApi.updateTaskStatus(task.id, nextStatus);
      if (res?.task) {
        setTasks((prev) => prev.map((t) => (t.id === res.task.id ? res.task : t)));
      }
    } catch (err: any) {
      setTasksError(sanitizeUiErrorMessage(err, 'Failed to update task status.'));
    }
  }

  async function handleDeleteTask(taskId: string) {
    setTasksError(null);
    try {
      await zyroApi.deleteTask(taskId);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
    } catch (err: any) {
      setTasksError(sanitizeUiErrorMessage(err, 'Failed to delete task.'));
    }
  }

  function selectModule(mod: ActiveModule) {
    setActiveModule(mod);
    setMobileMenuOpen(false);
  }

  function renderPersistenceUnconfiguredBanner(status: PersistenceConfigurationStatus | null) {
    const effective: PersistenceConfigurationStatus = status ||
      diagnostics?.persistence || {
        provider: 'firebase-firestore',
        configured: false,
        projectId: null,
        databaseId: '(default)',
        missingEnvVars: ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'],
        message:
          'Persistence not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in environment variables to enable Cloud Firestore storage.',
      };
    if (effective.configured) return null;

    const missingVars = Array.isArray(effective.missingEnvVars) ? effective.missingEnvVars : [];

    return (
      <div className="p-4 rounded-xl border border-amber-300 dark:border-amber-900/80 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 text-xs space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>Persistence not configured</span>
          </div>
          <span className="font-mono">Cloud Firestore</span>
        </div>
        <p className="leading-relaxed">
          {effective.message} ZYRO does not fabricate sample records or store user data in temporary
          in-memory arrays.
        </p>
        {missingVars.length > 0 && (
          <p className="font-mono text-amber-800 dark:text-amber-300">
            Required environment variables: {missingVars.join(', ')}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Top Bar Contract: Zone 1 Brand | Zone 2 Navigation | Zone 3 Primary Action */}
      <header className="flex items-center justify-between gap-8 px-4 sm:px-6 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 sticky top-0 z-30">
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-label="Toggle navigation menu"
            className="lg:hidden p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <a
            href="#assistant"
            onClick={(e) => {
              e.preventDefault();
              selectModule('assistant');
            }}
            className="text-lg font-bold tracking-tight text-slate-900 dark:text-white font-display whitespace-nowrap shrink-0"
          >
            ZYRO
          </a>
        </div>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-400">
          <button
            type="button"
            onClick={() => selectModule('assistant')}
            className={`hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeModule === 'assistant'
                ? 'text-sky-600 dark:text-sky-400 underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Assistant
          </button>
          <button
            type="button"
            onClick={() => selectModule('memory')}
            className={`hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeModule === 'memory'
                ? 'text-sky-600 dark:text-sky-400 underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Memory
          </button>
          <button
            type="button"
            onClick={() => selectModule('tasks')}
            className={`hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeModule === 'tasks'
                ? 'text-sky-600 dark:text-sky-400 underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Tasks
          </button>
          <button
            type="button"
            onClick={() => selectModule('audit')}
            className={`hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeModule === 'audit'
                ? 'text-sky-600 dark:text-sky-400 underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Permissions & Audit
          </button>
          <button
            type="button"
            onClick={() => selectModule('system')}
            className={`hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeModule === 'system'
                ? 'text-sky-600 dark:text-sky-400 underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Configuration
          </button>
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => {
              setTurns([]);
              setActiveConversationId(undefined);
              setChatError(null);
              selectModule('assistant');
            }}
            className="px-4 py-2 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            New Session
          </button>
        </div>
      </header>

      {/* Responsive Workspace Container */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Mobile/Tablet Backdrop Overlay */}
        {mobileMenuOpen && (
          <div
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
            className="fixed inset-0 bg-slate-950/60 z-30 lg:hidden"
          />
        )}

        {/* Sidebar Navigation (Desktop persistent, Mobile/Tablet slide-over drawer) */}
        <aside
          className={`${
            mobileMenuOpen
              ? 'fixed inset-y-0 left-0 z-40 flex w-64 shadow-xl'
              : 'hidden lg:flex lg:w-64'
          } shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex-col justify-between p-4 overflow-y-auto`}
        >
          <div className="space-y-6">
            <div>
              <p className="px-3 text-xs font-medium text-slate-400 dark:text-slate-500 mb-2">
                Workspace Modules
              </p>
              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => selectModule('assistant')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                    activeModule === 'assistant'
                      ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <span className="flex items-center gap-2.5 whitespace-nowrap">
                    <MessageSquare className="w-4 h-4 shrink-0" />
                    <span>Assistant Conversation</span>
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => selectModule('memory')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                    activeModule === 'memory'
                      ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <span className="flex items-center gap-2.5 whitespace-nowrap">
                    <Brain className="w-4 h-4 shrink-0" />
                    <span>Long-Term Memory</span>
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => selectModule('tasks')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                    activeModule === 'tasks'
                      ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <span className="flex items-center gap-2.5 whitespace-nowrap">
                    <CheckSquare className="w-4 h-4 shrink-0" />
                    <span>Tasks</span>
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => selectModule('audit')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                    activeModule === 'audit'
                      ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <span className="flex items-center gap-2.5 whitespace-nowrap">
                    <ShieldCheck className="w-4 h-4 shrink-0" />
                    <span>Permission & Audit Log</span>
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => selectModule('system')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                    activeModule === 'system'
                      ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <span className="flex items-center gap-2.5 whitespace-nowrap">
                    <Settings className="w-4 h-4 shrink-0" />
                    <span>System & Persistence</span>
                  </span>
                </button>
              </div>
            </div>

            {/* Session Preferences (Platform-Independent Core) */}
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 px-3 space-y-3">
              <p className="text-xs font-medium text-slate-400 dark:text-slate-500">
                Language & Model Tier
              </p>

              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                  Conversation Locale
                </label>
                <select
                  value={locale}
                  onChange={(e) => setLocale(e.target.value as SupportedLocale)}
                  className="w-full px-2.5 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white"
                >
                  <option value="en-US">English (en-US)</option>
                  <option value="hi-IN">Hindi · हिन्दी (hi-IN)</option>
                  <option value="te-IN">Telugu · తెలుగు (te-IN)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                  AI Model Route
                </label>
                <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setReasoningMode('chat')}
                    className={`py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      reasoningMode === 'chat'
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    Fast Chat
                  </button>
                  <button
                    type="button"
                    onClick={() => setReasoningMode('reasoning')}
                    className={`py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      reasoningMode === 'reasoning'
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    Deep Reasoning
                  </button>
                </div>
              </div>

              {capabilities.supportsSpeechSynthesis && (
                <button
                  type="button"
                  onClick={() => {
                    const next = !voiceOutputEnabled;
                    setVoiceOutputEnabled(next);
                    if (!next) platformAdapter.stopSpeaking();
                  }}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors cursor-pointer"
                >
                  <span className="flex items-center gap-2 whitespace-nowrap">
                    {voiceOutputEnabled ? (
                      <Volume2 className="w-4 h-4 text-sky-500" />
                    ) : (
                      <VolumeX className="w-4 h-4 text-slate-400" />
                    )}
                    <span>Spoken Output</span>
                  </span>
                  <span className="font-mono">{voiceOutputEnabled ? 'On' : 'Off'}</span>
                </button>
              )}
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 px-3 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <div>
              <p className="font-medium text-slate-800 dark:text-slate-200">ZYRO Core</p>
              <p className="capitalize">
                Adapter: {capabilities.platform} · {capabilities.formFactor}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDarkMode((d) => !d)}
              aria-label="Toggle color theme"
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </aside>

        {/* Main Viewport */}
        <main className="flex-1 overflow-y-auto flex flex-col">
          {/* Focused Assistant Conversation View */}
          {activeModule === 'assistant' && (
            <div className="flex-1 flex flex-col max-w-4xl w-full mx-auto px-4 sm:px-6 py-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-slate-200 dark:border-slate-800">
                <div>
                  <h1 className="text-lg font-semibold text-slate-900 dark:text-white">
                    Assistant Conversation
                  </h1>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Locale: {LOCALE_LABELS[locale]} · Mode:{' '}
                    {reasoningMode === 'reasoning'
                      ? `Deep Reasoning (${
                          diagnostics?.ai.models.reasoning.configuredId || 'gemini-3.5-flash'
                        })`
                      : `Fast Chat (${
                          diagnostics?.ai.models.chat.configuredId || 'gemini-3.5-flash-lite'
                        })`}{' '}
                    · Persistence:{' '}
                    {diagnostics?.persistence.configured ? 'Cloud Firestore' : 'Not Configured'}
                  </p>
                </div>
              </div>

              {persistenceNotice && (
                <div className="mt-4 p-3.5 rounded-lg border border-amber-300 dark:border-amber-900/70 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-300 text-xs flex items-start justify-between gap-3">
                  <span>{persistenceNotice}</span>
                  <button
                    type="button"
                    onClick={() => selectModule('system')}
                    className="font-semibold underline whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    View Setup
                  </button>
                </div>
              )}

              {chatError && (
                <div className="mt-4 p-4 rounded-lg border border-red-300 dark:border-red-900/80 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-300 text-xs flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{chatError}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setChatError(null)}
                    className="font-semibold underline whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              <div className="flex-1 overflow-y-auto py-6 space-y-6 min-h-[380px]">
                {turns.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center py-16 px-4">
                    <h2 className="text-xl font-semibold text-slate-900 dark:text-white font-display">
                      ZYRO Personal AI Assistant
                    </h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mt-2 leading-relaxed">
                      Start a conversation in English, Hindi, or Telugu. Responses stream in real
                      time from the server-side Gemini orchestrator and are evaluated through the
                      ZYRO Permission Gateway.
                    </p>
                  </div>
                ) : (
                  turns.map((turn) => (
                    <div
                      key={turn.id}
                      className={`flex flex-col ${
                        turn.role === 'user' ? 'items-end' : 'items-start'
                      }`}
                    >
                      <div className="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500 mb-1.5">
                        <span className="font-medium text-slate-700 dark:text-slate-300">
                          {turn.role === 'user' ? 'You' : 'ZYRO'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">{turn.timestamp}</span>
                        {turn.modelUsed && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">{turn.modelUsed}</span>
                          </>
                        )}
                        {typeof turn.latencyMs === 'number' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">{turn.latencyMs}ms</span>
                          </>
                        )}
                        {turn.tokenUsage && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">
                              {turn.tokenUsage.promptTokens}p/{turn.tokenUsage.responseTokens}r tok
                            </span>
                          </>
                        )}
                      </div>
                      <div
                        className={`max-w-[90%] sm:max-w-[80%] rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                          turn.role === 'user'
                            ? 'bg-sky-600 text-white'
                            : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100'
                        }`}
                      >
                        {turn.content}
                      </div>
                    </div>
                  ))
                )}

                {isGenerating && !hasFirstStreamChunk && (
                  <div className="flex flex-col items-start">
                    <div className="text-xs text-slate-400 mb-1.5">ZYRO · Processing</div>
                    <div className="rounded-xl px-4 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-sm text-slate-500 dark:text-slate-400">
                      ZYRO is thinking…
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <form
                onSubmit={handleSendPrompt}
                className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center gap-2.5"
              >
                <input
                  type="text"
                  value={promptInput}
                  onChange={(e) => setPromptInput(e.target.value)}
                  placeholder={`Message ZYRO in ${LOCALE_LABELS[locale]}...`}
                  className="flex-1 px-4 py-3 text-sm rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:border-sky-500"
                />
                {isGenerating && (
                  <button
                    type="button"
                    onClick={handleCancelGeneration}
                    className="px-4 py-3 text-sm font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Stop
                  </button>
                )}
                <button
                  type="submit"
                  disabled={isGenerating || !promptInput.trim()}
                  className="px-5 py-3 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded-xl transition-colors flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Send className="w-4 h-4" />
                  <span>{isGenerating ? 'Thinking…' : 'Send'}</span>
                </button>
              </form>
            </div>
          )}

          {/* MODULE: LONG-TERM MEMORY */}
          {activeModule === 'memory' && (
            <div className="max-w-4xl w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-bold text-slate-900 dark:text-white">
                    Long-Term Memory
                  </h1>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                    User-scoped personal facts, preferences, and project context stored in Cloud
                    Firestore.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={loadMemories}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Refresh</span>
                </button>
              </div>

              {renderPersistenceUnconfiguredBanner(memoriesPersistence)}

              {memoriesError && (
                <div className="p-4 rounded-xl border border-red-300 dark:border-red-900/80 bg-red-50 dark:bg-red-950/30 text-red-900 dark:text-red-200 text-xs">
                  {memoriesError}
                </div>
              )}

              <form
                onSubmit={handleCreateMemory}
                className="p-5 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 space-y-4"
              >
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  Store User-Scoped Memory Record
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                      Category
                    </label>
                    <select
                      value={newMemoryCategory}
                      onChange={(e) =>
                        setNewMemoryCategory(e.target.value as MemoryRecord['category'])
                      }
                      className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white"
                    >
                      <option value="Personal Fact">Personal Fact</option>
                      <option value="Preference">Preference</option>
                      <option value="Project Context">Project Context</option>
                      <option value="System Rule">System Rule</option>
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                      Tags (comma-separated)
                    </label>
                    <input
                      type="text"
                      value={newMemoryTags}
                      onChange={(e) => setNewMemoryTags(e.target.value)}
                      placeholder="preference, workflow, language"
                      className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                    Memory Content
                  </label>
                  <textarea
                    rows={2}
                    value={newMemoryContent}
                    onChange={(e) => setNewMemoryContent(e.target.value)}
                    placeholder="Enter a fact or preference to persist to your Cloud Firestore profile..."
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!newMemoryContent.trim()}
                  className="px-4 py-2 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded-lg transition-colors flex items-center gap-2 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Save to Cloud Firestore</span>
                </button>
              </form>

              <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 divide-y divide-slate-200 dark:divide-slate-800">
                {memoriesLoading ? (
                  <div className="p-8 text-center text-sm text-slate-500">
                    Loading user-scoped memories from Cloud Firestore...
                  </div>
                ) : memories.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
                    No stored memories found. Configure Firebase Authentication and Cloud Firestore
                    to persist and retrieve user-scoped memories.
                  </div>
                ) : (
                  memories.map((mem) => (
                    <div
                      key={mem.id}
                      className="p-4 flex items-start justify-between gap-4 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span className="font-semibold text-slate-800 dark:text-slate-200">
                            {mem.category}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{mem.source}</span>
                          {mem.tags.length > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{mem.tags.join(', ')}</span>
                            </>
                          )}
                        </div>
                        <p className="text-sm text-slate-900 dark:text-slate-100">{mem.content}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteMemory(mem.id)}
                        className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* MODULE: TASKS */}
          {activeModule === 'tasks' && (
            <div className="max-w-4xl w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-bold text-slate-900 dark:text-white">
                    User-Scoped Tasks
                  </h1>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                    Personal task records persisted in Cloud Firestore under your authenticated
                    user ID.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={loadTasks}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Refresh</span>
                </button>
              </div>

              {renderPersistenceUnconfiguredBanner(tasksPersistence)}

              {tasksError && (
                <div className="p-4 rounded-xl border border-red-300 dark:border-red-900/80 bg-red-50 dark:bg-red-950/30 text-red-900 dark:text-red-200 text-xs">
                  {tasksError}
                </div>
              )}

              <form
                onSubmit={handleCreateTask}
                className="p-4 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 grid grid-cols-1 sm:grid-cols-12 gap-3"
              >
                <input
                  type="text"
                  value={newTaskTitle}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  placeholder="Enter task title..."
                  className="sm:col-span-6 px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white"
                />
                <select
                  value={newTaskCategory}
                  onChange={(e) => setNewTaskCategory(e.target.value as TaskRecord['category'])}
                  className="sm:col-span-3 px-2.5 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white"
                >
                  <option value="Development">Development</option>
                  <option value="Productivity">Productivity</option>
                  <option value="Research">Research</option>
                  <option value="Automation">Automation</option>
                </select>
                <select
                  value={newTaskPriority}
                  onChange={(e) => setNewTaskPriority(e.target.value as TaskRecord['priority'])}
                  className="sm:col-span-3 px-2.5 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white"
                >
                  <option value="High">High Priority</option>
                  <option value="Medium">Medium Priority</option>
                  <option value="Low">Low Priority</option>
                </select>
                <div className="sm:col-span-12 flex justify-end">
                  <button
                    type="submit"
                    disabled={!newTaskTitle.trim()}
                    className="px-4 py-2 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
                  >
                    Create Task
                  </button>
                </div>
              </form>

              <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 divide-y divide-slate-200 dark:divide-slate-800">
                {tasksLoading ? (
                  <div className="p-8 text-center text-sm text-slate-500">
                    Loading user-scoped tasks from Cloud Firestore...
                  </div>
                ) : tasks.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
                    No tasks found. Tasks are loaded strictly from real Cloud Firestore records
                    without fabricated sample data.
                  </div>
                ) : (
                  tasks.map((task) => (
                    <div
                      key={task.id}
                      className="px-5 py-3.5 flex items-center justify-between gap-4"
                    >
                      <div className="flex items-start gap-3">
                        <button
                          type="button"
                          onClick={() => handleToggleTaskStatus(task)}
                          className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center cursor-pointer ${
                            task.status === 'completed'
                              ? 'bg-emerald-600 border-emerald-600 text-white'
                              : 'border-slate-300 dark:border-slate-600'
                          }`}
                        >
                          {task.status === 'completed' && <Check className="w-3 h-3" />}
                        </button>
                        <div>
                          <p
                            className={`text-sm font-medium ${
                              task.status === 'completed'
                                ? 'line-through text-slate-400'
                                : 'text-slate-900 dark:text-white'
                            }`}
                          >
                            {task.title}
                          </p>
                          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            <span>{task.category}</span>
                            <span aria-hidden="true">·</span>
                            <span>{task.priority} Priority</span>
                            <span aria-hidden="true">·</span>
                            <span>Status: {task.status}</span>
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteTask(task.id)}
                        className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* MODULE: PERMISSIONS & AUDIT LOG */}
          {activeModule === 'audit' && (
            <div className="max-w-4xl w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
              <div>
                <h1 className="text-xl font-bold text-slate-900 dark:text-white">
                  Permission Gateway & Execution Audit Log
                </h1>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                  Every orchestrator action and data mutation is evaluated against ZYRO’s 4-Tier
                  Permission Gateway before execution.
                </p>
              </div>

              {renderPersistenceUnconfiguredBanner(auditPersistence)}

              {auditError && (
                <div className="p-4 rounded-xl border border-red-300 dark:border-red-900/80 bg-red-50 dark:bg-red-950/30 text-red-900 dark:text-red-200 text-xs">
                  {auditError}
                </div>
              )}

              <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                    Verified Action Evaluations (Current Session & Persistent Store)
                  </h2>
                  <span className="font-mono text-xs text-slate-500">
                    {auditLogs.length + sessionAuditTrail.length} entries
                  </span>
                </div>

                {auditLoading ? (
                  <div className="p-8 text-center text-sm text-slate-500">
                    Loading audit log entries...
                  </div>
                ) : auditLogs.length === 0 && sessionAuditTrail.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
                    No actions have been evaluated in this session yet. Send a message in the
                    Assistant module to observe live Permission Gateway auditing.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-200 dark:divide-slate-800">
                    {[...auditLogs, ...sessionAuditTrail].map((entry, idx) => (
                      <div key={idx} className="p-4 space-y-1 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-white">
                            <span className="font-mono">{entry.actionName}</span>
                            <span aria-hidden="true">·</span>
                            <span className="text-slate-500">{entry.module}</span>
                            <span aria-hidden="true">·</span>
                            <span className="text-sky-600 dark:text-sky-400">
                              {RISK_TIER_LABELS[entry.riskTier]}
                            </span>
                          </div>
                          <span className="font-mono text-slate-500">
                            Decision: {entry.decision} · Verification: {entry.verificationStatus}
                          </span>
                        </div>
                        <p className="text-slate-600 dark:text-slate-300">{entry.details}</p>
                        <p className="font-mono text-slate-400">
                          Platform: {entry.platform} · {entry.timestamp}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* MODULE: SYSTEM CONFIGURATION & PERSISTENCE DIAGNOSTICS */}
          {activeModule === 'system' && (
            <div className="max-w-4xl w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-bold text-slate-900 dark:text-white">
                    System Architecture, AI Models & Firebase Configuration
                  </h1>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                    Live verification of server-side Google AI models, Firebase Authentication,
                    Cloud Firestore persistence, and cross-platform adapters.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={loadSystemDiagnostics}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Re-check</span>
                </button>
              </div>

              {diagnosticsLoading ? (
                <div className="p-8 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 text-center text-sm text-slate-500">
                  Querying server diagnostics...
                </div>
              ) : diagnosticsError ? (
                <div className="p-4 border border-red-300 dark:border-red-900 rounded-xl bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300 text-sm">
                  {diagnosticsError}
                </div>
              ) : (
                diagnostics && (
                  <div className="space-y-6">
                    {/* 1. AI Model Configuration Table */}
                    <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 overflow-hidden">
                      <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                        <div>
                          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                            01. Server-Side Google AI Model Verification
                          </h2>
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            Configured via environment variables and validated against supported
                            Google AI models.
                          </p>
                        </div>
                        <span className="font-mono text-xs">
                          API Key:{' '}
                          {diagnostics.ai.apiKeyConfigured ? 'Configured' : 'Missing GEMINI_API_KEY'}
                        </span>
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead>
                            <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                              <th className="py-3 px-5 whitespace-nowrap">Role / Env Var</th>
                              <th className="py-3 px-5 whitespace-nowrap">Configured Model ID</th>
                              <th className="py-3 px-5 whitespace-nowrap">Live API Verification</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                            {Object.entries(diagnostics.ai.models).map(([role, info]) => (
                              <tr key={role}>
                                <td className="py-3 px-5 font-medium capitalize text-slate-900 dark:text-white whitespace-nowrap">
                                  {role}
                                </td>
                                <td className="py-3 px-5 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                                  {info.configuredId}
                                </td>
                                <td className="py-3 px-5 font-mono">
                                  {info.valid ? (
                                    <span className="text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                                      Verified (ai.models.get)
                                    </span>
                                  ) : (
                                    <span className="text-red-600 dark:text-red-400">
                                      {info.error}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* 2. Firebase & Cloud Firestore Persistence Status */}
                    <div className="p-5 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 space-y-4">
                      <div className="flex items-center justify-between">
                        <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                          02. Firebase Authentication & Cloud Firestore Persistence
                        </h2>
                        <span
                          className={`font-mono text-xs ${
                            diagnostics.persistence.configured
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          {diagnostics.persistence.configured
                            ? 'Configured'
                            : 'Persistence not configured'}
                        </span>
                      </div>

                      <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                        {diagnostics.persistence.message}
                      </p>

                      {diagnostics.persistence.missingEnvVars.length > 0 && (
                        <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs space-y-1.5">
                          <p className="font-semibold text-slate-800 dark:text-slate-200">
                            Required Environment Variables for Cloud Firestore Persistence:
                          </p>
                          <p className="font-mono text-slate-600 dark:text-slate-400">
                            {diagnostics.persistence.missingEnvVars.join(', ')}
                          </p>
                        </div>
                      )}

                      <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2">
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                          Firebase ID Bearer Token (Optional — for authenticating user-scoped API
                          calls when Firebase is configured)
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={authTokenDraft}
                            onChange={(e) => setAuthTokenDraft(e.target.value)}
                            placeholder="Paste Firebase ID JWT token..."
                            className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white font-mono"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              zyroApi.setAuthToken(authTokenDraft.trim() || null);
                              loadSystemDiagnostics();
                            }}
                            className="px-4 py-2 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                          >
                            Apply Token
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* 3. Cross-Platform Adapter Diagnostics */}
                    <div className="p-5 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 space-y-2 text-xs">
                      <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                        03. Active Cross-Platform Runtime Adapter
                      </h2>
                      <div className="flex flex-wrap items-center gap-2 text-slate-600 dark:text-slate-300 font-mono">
                        <span>Target: {capabilities.platform}</span>
                        <span aria-hidden="true">·</span>
                        <span>Form Factor: {capabilities.formFactor}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          Speech Synthesis:{' '}
                          {capabilities.supportsSpeechSynthesis ? 'Available' : 'Unavailable'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          Speech Recognition:{' '}
                          {capabilities.supportsSpeechRecognition ? 'Available' : 'Unavailable'}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
