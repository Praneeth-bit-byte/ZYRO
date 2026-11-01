import { AuditLogRecord, PlatformTarget, RiskTier } from '../../shared/contracts';
import { PermissionDeniedError } from '../errors/app-error';
import { dataRepository } from '../persistence/firestore.repository';

export interface PermissionEvaluationInput {
  userId: string | null;
  actionName: string;
  module: string;
  riskTier: RiskTier;
  platform: PlatformTarget;
  userApproved?: boolean;
  details: string;
}

export interface PermissionEvaluationResult {
  allowed: boolean;
  decision: AuditLogRecord['decision'];
  auditEntry: Omit<AuditLogRecord, 'id' | 'userId'>;
}

/**
 * Redacts credentials, tokens, API keys, private keys, and secrets from audit log strings
 * so sensitive values are never written to audit records or returned to clients.
 */
export function redactSensitiveAuditDetails(raw: string): string {
  if (!raw) return '';
  return raw
    // Redact Bearer tokens and JWTs
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]')
    // Redact Google API keys (AIza...)
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_API_KEY]')
    // Redact PEM private keys
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    // Redact key=value or key: value patterns for secret/password/token/apiKey/privateKey
    .replace(
      /((?:api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|authorization)\s*[:=]\s*)(['"]?)[^\s"',;]+(\2)/gi,
      '$1$2[REDACTED]$3'
    );
}

/**
 * ZYRO 4-Tier Permission Gateway & Audit Logger
 *
 * Tier 0 (READ_ONLY): Auto-allowed.
 * Tier 1 (INTERNAL_WRITE): Auto-allowed for authenticated user-scoped writes.
 * Tier 2 (EXTERNAL_OR_DEVICE): Requires explicit server-verified `userApproved === true`;
 *   throws `PermissionDeniedError` if unapproved when enforced.
 * Tier 3 (CRITICAL_RESTRICTED): Denied unconditionally by default.
 */
export class PermissionGateway {
  public async evaluateAndAudit(
    input: PermissionEvaluationInput
  ): Promise<PermissionEvaluationResult> {
    let decision: AuditLogRecord['decision'] = 'allowed';

    if (input.riskTier === RiskTier.CRITICAL_RESTRICTED) {
      decision = 'denied';
    } else if (input.riskTier === RiskTier.EXTERNAL_OR_DEVICE && input.userApproved !== true) {
      decision = 'requires_approval';
    }

    const sanitizedDetails = redactSensitiveAuditDetails(input.details);

    const auditEntry: Omit<AuditLogRecord, 'id' | 'userId'> = {
      actionName: input.actionName,
      module: input.module,
      riskTier: input.riskTier,
      decision,
      verificationStatus: decision === 'allowed' ? 'verified' : 'not_applicable',
      platform: input.platform,
      details: sanitizedDetails,
      timestamp: new Date().toISOString(),
    };

    // Persist redacted audit log to Firestore if configured and userId is authenticated
    if (input.userId && dataRepository.isConfigured()) {
      try {
        await dataRepository.appendAuditLog(input.userId, {
          actionName: auditEntry.actionName,
          module: auditEntry.module,
          riskTier: auditEntry.riskTier,
          decision: auditEntry.decision,
          verificationStatus: auditEntry.verificationStatus,
          platform: auditEntry.platform,
          details: auditEntry.details,
        });
      } catch (err) {
        console.warn('[ZYRO AuditService] Failed to persist audit record:', err);
      }
    }

    if (decision === 'denied') {
      throw new PermissionDeniedError(
        `Action "${input.actionName}" is classified as Risk Tier 3 (Restricted) and is blocked by the ZYRO Permission Gateway.`,
        { actionName: input.actionName, riskTier: input.riskTier, decision }
      );
    }

    if (decision === 'requires_approval') {
      throw new PermissionDeniedError(
        `Action "${input.actionName}" is classified as Risk Tier 2 (Sensitive External/Device Action) and requires explicit user approval before execution.`,
        { actionName: input.actionName, riskTier: input.riskTier, decision }
      );
    }

    return {
      allowed: true,
      decision,
      auditEntry,
    };
  }
}

export const permissionGateway = new PermissionGateway();
