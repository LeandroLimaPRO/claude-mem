import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { getCredential } from '../../shared/EnvManager.js';
import { paths } from '../../shared/paths.js';
import { estimateTokens } from '../../shared/timeline-formatting.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { withRetry, parseRetryAfterMs } from './retry.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import { RateLimitTracker } from './gemini/RateLimitTracker.js';
import { DynamicModelRegistry } from './gemini/DynamicModelRegistry.js';
import { GeminiStatusBroadcaster } from './gemini/GeminiStatusBroadcaster.js';
import { DEFAULT_MODEL_CASCADE } from './gemini/model-cascade.js';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TokenReservation } from './gemini/types.js';

// v1beta is required: the current Gemini 3.x models, Gemma models, and the Google-maintained
// `-latest` aliases are exposed under v1beta.
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Classify a Gemini fetch failure into ClassifiedProviderError. Called at
 * the boundary right after `fetch()` returns or throws. Provider-specific
 * because Gemini surfaces auth/quota/rate-limit signals via specific status
 * codes and body strings (e.g. "quota exceeded", "API key not valid").
 */
export function classifyGeminiError(input: {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
  requestId?: string;
}): ClassifiedProviderError {
  const status = input.status;
  const body = input.bodyText ?? '';
  const lower = body.toLowerCase();
  const headers = input.headers;
  const retryAfterMs = headers ? parseRetryAfterMs(headers.get('retry-after')) : undefined;
  const cause = status === undefined
    ? input.cause
    : new Error(`Gemini HTTP error (status ${status}${input.requestId ? `, request ${input.requestId}` : ''})`);

  // Distinguish daily/total quota from minute-level rate limits
  if (lower.includes('quota exceeded') || lower.includes('resource_exhausted')) {
    const minuteQuota = /per[ _]?minute|\brpm\b|\btpm\b/.test(lower);
    if (lower.includes('per day') || lower.includes('daily') || lower.includes('rpd') ||
        (lower.includes('quota exceeded') && !minuteQuota)) {
      return new ClassifiedProviderError(
        `Gemini daily quota exhausted${status !== undefined ? ` (status ${status})` : ''}`,
        { kind: 'quota_exhausted', cause },
      );
    }
    return new ClassifiedProviderError(
      'Gemini rate limit / quota exceeded',
      { kind: 'rate_limit', cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status === 429) {
    return new ClassifiedProviderError(
      'Gemini rate limit (429)',
      { kind: 'rate_limit', cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status === 401 || status === 403) {
    if (lower.includes('api key not valid') || lower.includes('api_key_invalid') || lower.includes('api key expired')) {
      return new ClassifiedProviderError(
        `Gemini auth invalid (status ${status})`,
        { kind: 'auth_invalid', cause },
      );
    }
    if (
      lower.includes('location is not supported') ||
      lower.includes('permission denied for models') ||
      lower.includes('not enabled for this model') ||
      lower.includes('restricted') ||
      lower.includes('waitlist')
    ) {
      return new ClassifiedProviderError(
        `Gemini model restricted (status ${status})`,
        { kind: 'model_restricted', cause },
      );
    }
    return new ClassifiedProviderError(
      `Gemini auth error (status ${status})`,
      { kind: 'auth_invalid', cause },
    );
  }

  if (status === 422 || lower.includes('unprocessable')) {
    return new ClassifiedProviderError(
      'Gemini unprocessable entity (422)',
      { kind: 'model_incompatible', cause },
    );
  }

  if (status === 400) {
    const category = categorizeGeminiBadRequest(body);
    const kind = category === 'model_unsupported'
      ? 'model_unsupported'
      : category === 'context_limit'
      ? 'context_limit'
      : 'unrecoverable';
    return new ClassifiedProviderError(
      `Gemini bad request: ${category}`,
      { kind, cause },
    );
  }

  if (lower.includes('overloaded')) {
    return new ClassifiedProviderError(
      `Gemini model overloaded (status ${status ?? 503})`,
      { kind: 'model_overloaded', cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ClassifiedProviderError(
      `Gemini upstream error (status ${status})`,
      { kind: 'transient', cause },
    );
  }

  if (status === undefined) {
    return new ClassifiedProviderError(
      `Gemini network error: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}`,
      { kind: 'transient', cause: input.cause },
    );
  }

  return new ClassifiedProviderError(
    `Gemini API error (status ${status})`,
    { kind: 'unrecoverable', cause },
  );
}

const GEMINI_EMPTY_HISTORY_FALLBACK = 'Continue the memory observation request.';

export type GeminiBadRequestCategory =
  | 'role_sequence'
  | 'context_limit'
  | 'model_unsupported'
  | 'api_key'
  | 'unknown_bad_request';

export function categorizeGeminiBadRequest(bodyText: string): GeminiBadRequestCategory {
  const lower = bodyText.toLowerCase();

  if (
    lower.includes('api key not valid') ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key expired') ||
    lower.includes('invalid api key')
  ) {
    return 'api_key';
  }

  if (
    lower.includes('please ensure that multiturn requests alternate') ||
    lower.includes('alternate between user and model') ||
    lower.includes('first content should be with role') ||
    (lower.includes('contents') && lower.includes('role') && (lower.includes('user') || lower.includes('model')))
  ) {
    return 'role_sequence';
  }

  if (
    lower.includes('context limit') ||
    lower.includes('context length') ||
    lower.includes('too many tokens') ||
    lower.includes('input is too long') ||
    lower.includes('prompt is too long') ||
    lower.includes('request payload size exceeds') ||
    (lower.includes('token') && (lower.includes('exceed') || lower.includes('maximum') || lower.includes('limit')))
  ) {
    return 'context_limit';
  }

  if (
    lower.includes('model not found') ||
    lower.includes('model_unsupported') ||
    lower.includes('unsupported model') ||
    lower.includes('not supported for generatecontent') ||
    lower.includes('not supported by this model') ||
    (lower.includes('model') && lower.includes('not supported')) ||
    (lower.includes('models/') && lower.includes('not found'))
  ) {
    return 'model_unsupported';
  }

  return 'unknown_bad_request';
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
  configuredModel?: string;
  rateLimitingEnabled: boolean;
  autoFallback: boolean;
}

export class GeminiProvider extends OpenAICompatibleProvider<GeminiConfig> {
  protected readonly providerName = 'Gemini';
  protected readonly syntheticIdPrefix = 'gemini';
  protected readonly forwardEmptyMessageResponse = false;
  private tracker: RateLimitTracker;
  private registry: DynamicModelRegistry;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
    this.tracker = RateLimitTracker.getInstance();
    this.registry = DynamicModelRegistry.getInstance();
  }

  protected getConfig(): GeminiConfig {
    return this.getGeminiConfig();
  }

  protected missingApiKeyError(): Error {
    return new Error('Gemini API key not configured. Set CLAUDE_MEM_GEMINI_API_KEY in settings or GEMINI_API_KEY environment variable.');
  }

  protected estimateTokens(text: string): number {
    return estimateTokens(text);
  }

  protected buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'] {
    return typeof result.inputTokens === 'number' && typeof result.outputTokens === 'number'
      ? { input: result.inputTokens, output: result.outputTokens }
      : null;
  }

  private conversationToGeminiContents(history: ConversationMessage[]): GeminiContent[] {
    const contents: GeminiContent[] = [];
    let newestNonEmptyContent: string | null = null;

    for (const msg of history) {
      const trimmed = msg.content.trim();
      if (trimmed.length > 0) {
        newestNonEmptyContent = trimmed;
      }
    }

    for (const msg of history) {
      if (!msg.content.trim()) {
        continue;
      }

      const role = msg.role === 'assistant' ? 'model' : 'user';

      if (contents.length === 0 && role === 'model') {
        continue;
      }

      const previous = contents[contents.length - 1];
      if (previous?.role === role) {
        previous.parts[0].text = `${previous.parts[0].text}\n\n${msg.content}`;
      } else {
        contents.push({
          role,
          parts: [{ text: msg.content }]
        });
      }
    }

    if (contents.length === 0) {
      return [{
        role: 'user',
        parts: [{ text: newestNonEmptyContent ?? GEMINI_EMPTY_HISTORY_FALLBACK }]
      }];
    }

    return contents;
  }

  protected async query(history: ConversationMessage[], config: GeminiConfig, signal?: AbortSignal): Promise<ProviderQueryResult> {
    const latest = this.getGeminiConfig();
    return this.executeWithDynamicCascade(history, {
      ...config,
      model: config.model === (config.configuredModel ?? config.model) ? latest.model : config.model,
      rateLimitingEnabled: latest.rateLimitingEnabled,
      autoFallback: latest.autoFallback,
    }, signal);
  }

  private fetchGenerateContent(
    url: string,
    contents: GeminiContent[],
    priorRequestId: string | null,
    attemptSignal: AbortSignal
  ): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(priorRequestId ? { 'x-claude-mem-prior-request-id': priorRequestId } : {}),
      },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
        },
      }),
      signal: attemptSignal,
    });
  }

  /**
   * Execute request with dynamic rate limiting, predictive demotion,
   * reactive fallback on 429, and automatic promotion when capacity frees up.
   */
  private async waitForReservation(preferredModel: string, estimatedTokens: number, signal?: AbortSignal): Promise<{
    modelId: string; reservation: TokenReservation;
  }> {
    let waiting = false;
    try {
      while (true) {
        signal?.throwIfAborted();
        const selection = this.tracker.selectBestAvailableModel(preferredModel, estimatedTokens);
        const admission = selection.waitMs > 0
          ? { reservation: undefined, waitMs: selection.waitMs, reason: selection.reason }
          : this.tracker.tryReserve(selection.selectedModel.id, estimatedTokens);
        if (admission.reservation) return { modelId: selection.selectedModel.id, reservation: admission.reservation };
        if (!Number.isFinite(admission.waitMs) || admission.waitMs <= 0) {
          throw new ClassifiedProviderError('No usable Gemini quota is available', { kind: 'unrecoverable', cause: null });
        }
        if (!waiting) {
          this.tracker.beginQuotaWait(admission.waitMs);
          waiting = true;
        } else {
          this.tracker.updateQueueState({ quotaWaitRemainingMs: admission.waitMs });
        }
        const waitMs = Math.min(60_000, admission.waitMs);
        GeminiStatusBroadcaster.getInstance().broadcastQueuePaused(Math.ceil(admission.waitMs / 1000), admission.reason ?? 'rate_limit');
        await sleep(waitMs, undefined, { signal });
      }
    } finally {
      if (waiting) {
        if (this.tracker.endQuotaWait()) GeminiStatusBroadcaster.getInstance().broadcastQueueResumed();
      }
    }
  }

  private async executeWithDynamicCascade(
    history: ConversationMessage[],
    config: GeminiConfig,
    signal?: AbortSignal
  ): Promise<ProviderQueryResult> {
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.max(100, Math.ceil(totalChars / 4));
    const contents = this.conversationToGeminiContents(history);

    const attemptedModels = new Set<string>();
    let currentModelId = config.model;
    let targetModelId = currentModelId;
      let priorRequestId: string | null = null;
    while (true) {
      signal?.throwIfAborted();
      let reservation: TokenReservation | undefined;
      try {
        const data = await withRetry<GeminiResponse>(async (attemptSignal) => {
          let sent = false;
          let parsed: GeminiResponse | undefined;
          try {
          let response: Response;
          try {
            if (!config.rateLimitingEnabled) {
              targetModelId = currentModelId === 'auto' ? this.registry.getCascade()[0]?.id ?? '' : currentModelId;
              if (!this.registry.getModel(targetModelId)) {
                throw new ClassifiedProviderError(`Unknown Gemini model: ${targetModelId}`, { kind: 'unrecoverable', cause: null });
              }
            }
            // With rate limiting enabled, targetModelId comes from waitForReservation's
            // live admission check (cooldowns/unsupported set), so a model that clears
            // its cooldown is legitimately retryable even if it's in attemptedModels.
            // Without rate limiting there's no admission wait, so repeating a rejected
            // model here would just spin without backoff.
            if (!config.rateLimitingEnabled && attemptedModels.has(targetModelId)) {
              throw new ClassifiedProviderError('Gemini cascade repeated a rejected model', { kind: 'unrecoverable', cause: null });
            }
            const url = `${GEMINI_API_URL}/${encodeURIComponent(targetModelId)}:generateContent?key=${config.apiKey}`;
            attemptSignal.throwIfAborted();
            sent = true;
            response = await this.fetchGenerateContent(url, contents, priorRequestId, attemptSignal);
          } catch (networkError: unknown) {
            if (networkError instanceof ClassifiedProviderError) throw networkError;
            if (attemptSignal.aborted) throw networkError;
            const err = networkError instanceof Error ? networkError : new Error(String(networkError));
            throw classifyGeminiError({ cause: err });
          }

          const requestId = response.headers.get('x-goog-request-id') ?? response.headers.get('x-request-id');
          if (requestId) {
            priorRequestId = requestId;
          }

          if (!response.ok) {
            const errorBody = await response.text();
            const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));

            const classified = classifyGeminiError({
              status: response.status,
              bodyText: errorBody,
              headers: response.headers,
              cause: new Error(`Gemini API error (status ${response.status})`),
              ...(requestId ? { requestId } : {}),
            });

            const errorLower = errorBody.toLowerCase();
            const badReqCategory = response.status === 400 ? categorizeGeminiBadRequest(errorBody) : null;
            const isModelSpecific403 = response.status === 403 &&
              (errorLower.includes('location is not supported') ||
                errorLower.includes('permission denied for models') ||
                errorLower.includes('not enabled for this model') ||
                errorLower.includes('restricted') ||
                errorLower.includes('waitlist'));

            const isCascadeTrigger =
              response.status === 429 ||
              response.status === 404 ||
              response.status === 422 ||
              response.status === 503 ||
              errorLower.includes('model is overloaded') ||
              (response.status === 400 && (badReqCategory === 'model_unsupported' || badReqCategory === 'context_limit')) ||
              isModelSpecific403;

            // If a fallback model is available, error is a cascade trigger, and auto-fallback is enabled, signal fallback
            if (config.autoFallback && isCascadeTrigger) {
              const failureAnalysis = this.tracker.recordRequestFailure(
                targetModelId,
                response.status,
                errorBody,
                retryAfterMs
              );

              if (failureAnalysis.fallbackRecommended && failureAnalysis.nextModel) {
                const fallbackErr = new ClassifiedProviderError(`FALLBACK_TO_${failureAnalysis.nextModel.id}`, {
                  kind: 'model_fallback', cause: classified,
                });
                (fallbackErr as any).isFallback = true;
                (fallbackErr as any).nextModelId = failureAnalysis.nextModel.id;
                (fallbackErr as any).reason = failureAnalysis.reason ?? 'Cascaded to next model';
                (fallbackErr as any).lastError = classified;
                throw fallbackErr;
              }
            }

            throw classified;
          }

          parsed = await response.json() as GeminiResponse;
          return parsed;
          } finally {
            if (reservation) {
              this.tracker.reconcileReservation(reservation, parsed?.usageMetadata?.promptTokenCount, sent, !!parsed);
              reservation = undefined;
            }
          }
        }, {
          label: `Gemini ${targetModelId}`,
          abortSignal: signal,
          ...(signal ? { maxRetries: 0 } : {}),
          beforeAttempt: config.rateLimitingEnabled ? async waitSignal => {
            const admission = await this.waitForReservation(currentModelId, estimatedTokens, waitSignal);
            targetModelId = admission.modelId;
            reservation = admission.reservation;
          } : undefined,
        });

        const finishReason = (data as any)?.candidates?.[0]?.finishReason;
        const promptFeedback = (data as any)?.promptFeedback;
        const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const isSafetyBlocked = (finishReason === 'SAFETY' || promptFeedback?.blockReason === 'SAFETY') && !textContent;

        if (config.autoFallback && isSafetyBlocked) {
          const failureAnalysis = this.tracker.recordRequestFailure(
            targetModelId,
            200,
            'Blocked by safety filters'
          );
          if (failureAnalysis.fallbackRecommended && failureAnalysis.nextModel) {
            const fallbackErr = new Error(`FALLBACK_TO_${failureAnalysis.nextModel.id}`);
            (fallbackErr as any).isFallback = true;
            (fallbackErr as any).nextModelId = failureAnalysis.nextModel.id;
            (fallbackErr as any).reason = 'Blocked by safety filters';
            (fallbackErr as any).lastError = new ClassifiedProviderError(
              `Gemini output blocked by safety filters on ${targetModelId}`,
              { kind: 'unrecoverable', cause: new Error('Safety block') }
            );
            throw fallbackErr;
          }
        }

        const content = textContent;
        const tokensUsed = data.usageMetadata?.totalTokenCount ?? estimatedTokens;

        return {
          content,
          tokensUsed,
          inputTokens: data.usageMetadata?.promptTokenCount,
          outputTokens: data.usageMetadata?.candidatesTokenCount,
          servedModel: targetModelId,
        };
      } catch (err: unknown) {
        const lastErr = (err as any)?.lastError ?? err;
        // Reactive fallback trigger
        if ((err as any)?.isFallback && (err as any)?.nextModelId) {
          const nextModel = (err as any).nextModelId;
          const fallbackReason = (err as any)?.reason ?? 'Rate limit exceeded (429)';
          logger.info('SDK', `Reactive cascade switch: ${targetModelId} -> ${nextModel} (${fallbackReason})`);
          GeminiStatusBroadcaster.getInstance().broadcastModelSwitched(
            targetModelId,
            nextModel,
            fallbackReason
          );
          currentModelId = nextModel;
          attemptedModels.add(targetModelId);
          // Same distinction as above: only bail out here when there's no admission
          // wait to fall back on. With rate limiting enabled, looping back lets
          // waitForReservation wait out the cooldown instead of giving up early.
          if (!config.rateLimitingEnabled && attemptedModels.has(nextModel)) {
            throw lastErr;
          }
          continue; // Retry with next model
        }

        throw lastErr;
      }
    }

  }

  private getGeminiConfig(): GeminiConfig {
    const settingsPath = paths.settings();
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY') || '';
    const defaultModel = 'auto';
    const configuredModel = settings.CLAUDE_MEM_GEMINI_MODEL || defaultModel;

    // Trigger non-blocking dynamic discovery if key is present and not in test environment.
    // Also fires for a fixed configured model the in-RAM catalog doesn't know about
    // (e.g. a discovered model picked from the panel before a worker restart wiped
    // the catalog back to DEFAULT_MODEL_CASCADE) so it self-heals instead of
    // permanently rejecting it as "Unknown Gemini model".
    if (apiKey && process.env.NODE_ENV !== 'test' && !process.env.BUN_TEST &&
        (configuredModel === 'auto' || !this.registry.getModel(configuredModel))) {
      void this.registry.discoverModels(apiKey).catch(() => {});
    }

    const rateLimitingEnabled = settings.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED !== 'false';
    const autoFallback = (settings as any).CLAUDE_MEM_GEMINI_AUTO_FALLBACK !== 'false';

    this.tracker.setAutoFallback(autoFallback);

    return { apiKey, model: configuredModel, configuredModel, rateLimitingEnabled, autoFallback };
  }
}

export function isGeminiAvailable(): boolean {
  const settingsPath = paths.settings();
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY'));
}

export function isGeminiSelected(): boolean {
  const settingsPath = paths.settings();
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'gemini';
}
