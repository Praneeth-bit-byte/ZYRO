import { Request, Response, NextFunction } from 'express';
import { ApiErrorPayload } from '../../shared/contracts';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ApiErrorPayload['error']['code'];
  public readonly missingEnvVars?: string[];
  public readonly details?: Record<string, unknown>;

  constructor(params: {
    statusCode: number;
    code: ApiErrorPayload['error']['code'];
    message: string;
    missingEnvVars?: string[];
    details?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = 'AppError';
    this.statusCode = params.statusCode;
    this.code = params.code;
    this.missingEnvVars = params.missingEnvVars;
    this.details = params.details;
  }
}

export class PersistenceNotConfiguredError extends AppError {
  constructor(missingEnvVars: string[]) {
    super({
      statusCode: 422,
      code: 'PERSISTENCE_NOT_CONFIGURED',
      message: `Persistence not configured. Cloud Firestore requires environment variables: ${missingEnvVars.join(
        ', '
      )}. ZYRO does not store user records in temporary in-memory arrays or local files.`,
      missingEnvVars,
    });
    this.name = 'PersistenceNotConfiguredError';
  }
}

export class AuthenticationRequiredError extends AppError {
  constructor(
    message = 'Valid Firebase Authentication Bearer token is required for user-scoped data access.'
  ) {
    super({
      statusCode: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message,
    });
    this.name = 'AuthenticationRequiredError';
  }
}

export class ModelConfigurationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      statusCode: 422,
      code: 'MODEL_NOT_AVAILABLE',
      message,
      details,
    });
    this.name = 'ModelConfigurationError';
  }
}

export class AIConfigurationError extends AppError {
  constructor(message: string, missingEnvVars?: string[], details?: Record<string, unknown>) {
    super({
      statusCode: 422,
      code: 'AI_CONFIGURATION_ERROR',
      message,
      missingEnvVars,
      details,
    });
    this.name = 'AIConfigurationError';
  }
}

export class PermissionDeniedError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      message,
      details,
    });
    this.name = 'PermissionDeniedError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message,
      details,
    });
    this.name = 'ValidationError';
  }
}

export function errorHandlerMiddleware(
  err: unknown,
  _req: Request,
  res: Response<ApiErrorPayload>,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        missingEnvVars: err.missingEnvVars,
        details: err.details,
      },
    });
    return;
  }

  const message =
    err instanceof Error ? err.message : 'An unexpected internal server error occurred.';
  console.error('[ZYRO ErrorBoundary]:', err);

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message,
    },
  });
}
