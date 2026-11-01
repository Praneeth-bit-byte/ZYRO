import { Request, Response, NextFunction } from 'express';
import { getFirebaseConfigurationStatus, getServerConfig } from '../config/env';
import { AuthenticationRequiredError, PersistenceNotConfiguredError } from '../errors/app-error';

export interface AuthenticatedUserContext {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  mode: 'verified_token' | 'unconfigured_guest';
}

declare global {
  namespace Express {
    interface Request {
      userContext?: AuthenticatedUserContext;
    }
  }
}

/**
 * Verifies a Firebase ID Token using Google Identity Toolkit REST endpoint
 * or decodes and validates token issuer/audience against `FIREBASE_PROJECT_ID`.
 */
export async function verifyFirebaseIdToken(idToken: string): Promise<AuthenticatedUserContext> {
  const cfg = getServerConfig().firebase;
  if (!cfg.projectId) {
    throw new PersistenceNotConfiguredError(['FIREBASE_PROJECT_ID']);
  }

  // If Web API key is configured, verify via Identity Toolkit accounts:lookup
  if (cfg.webApiKey) {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(
        cfg.webApiKey
      )}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!res.ok) {
      throw new AuthenticationRequiredError('Firebase ID token verification failed.');
    }
    const data = (await res.json()) as {
      users?: Array<{ localId: string; email?: string; emailVerified?: boolean }>;
    };
    const user = data.users?.[0];
    if (!user?.localId) {
      throw new AuthenticationRequiredError('Invalid Firebase user record in token lookup.');
    }
    return {
      uid: user.localId,
      email: user.email || null,
      emailVerified: Boolean(user.emailVerified),
      mode: 'verified_token',
    };
  }

  // Fallback JWT structural claim check when only server-side project ID is present
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new AuthenticationRequiredError('Malformed Bearer token.');
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      payload.aud !== cfg.projectId ||
      payload.iss !== `https://securetoken.google.com/${cfg.projectId}` ||
      !payload.sub ||
      (payload.exp && payload.exp < nowSec)
    ) {
      throw new AuthenticationRequiredError('Firebase token claims failed validation.');
    }
    return {
      uid: String(payload.sub),
      email: payload.email ? String(payload.email) : null,
      emailVerified: Boolean(payload.email_verified),
      mode: 'verified_token',
    };
  } catch (err) {
    if (err instanceof AuthenticationRequiredError) throw err;
    throw new AuthenticationRequiredError('Unable to parse Firebase Authentication token.');
  }
}

/**
 * Middleware that attaches `req.userContext` if a valid Bearer token is present.
 */
export async function optionalAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const fbStatus = getFirebaseConfigurationStatus();
    if (!fbStatus.configured) {
      req.userContext = undefined;
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice('Bearer '.length).trim();
      if (token) {
        req.userContext = await verifyFirebaseIdToken(token);
      }
    }
    next();
  } catch {
    // On optional-auth routes, invalid or expired tokens fall back to unauthenticated guest context
    req.userContext = undefined;
    next();
  }
}

/**
 * Strict Middleware for User-Scoped Data Endpoints.
 * Requires Firebase Persistence to be configured and a verified `req.userContext`.
 */
export async function requireUserScopedAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const fbStatus = getFirebaseConfigurationStatus();
    if (!fbStatus.configured) {
      throw new PersistenceNotConfiguredError(fbStatus.missingEnvVars);
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthenticationRequiredError(
        'Authentication required. Sign in with Firebase Authentication to access user-scoped data.'
      );
    }

    const token = authHeader.slice('Bearer '.length).trim();
    req.userContext = await verifyFirebaseIdToken(token);
    next();
  } catch (err) {
    next(err);
  }
}
