import { Request, Response, NextFunction } from 'express';
import {
  DEFAULT_FIREBASE_PROJECT_ID,
  getFirebaseConfigurationStatus,
  getServerConfig,
} from '../config/env';
import { AuthenticationRequiredError, PersistenceNotConfiguredError } from '../errors/app-error';
import { getFirebaseAdminAuth, isFirebaseAdminConfigured } from '../persistence/firebase-admin.client';
import { dataRepository } from '../persistence/firestore.repository';

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

export type TokenVerifierFn = (idToken: string) => Promise<AuthenticatedUserContext>;

let customTokenVerifierForTesting: TokenVerifierFn | null = null;

/**
 * Allows automated integration tests to supply a deterministic token verifier
 * without altering production Firebase Admin verification behavior.
 */
export function setTokenVerifierForTesting(verifier: TokenVerifierFn | null): void {
  customTokenVerifierForTesting = verifier;
}

/**
 * Performs fast structural and claim validation on a JWT before invoking remote/cryptographic checks.
 * Ensures malformed, expired, or wrong-project tokens are immediately rejected with 401.
 */
function validateJwtClaimsPrecheck(idToken: string, expectedProjectId: string): {
  uid: string;
  email: string | null;
  emailVerified: boolean;
} {
  const trimmed = (idToken || '').trim();
  const parts = trimmed.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new AuthenticationRequiredError('Invalid or malformed Firebase ID token.');
  }

  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!header || header.alg !== 'RS256') {
      throw new AuthenticationRequiredError('Invalid Firebase ID token signature algorithm.');
    }

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const nowSec = Math.floor(Date.now() / 1000);

    if (!payload || typeof payload !== 'object') {
      throw new AuthenticationRequiredError('Invalid Firebase ID token payload.');
    }
    if (payload.aud !== expectedProjectId) {
      throw new AuthenticationRequiredError(
        `Firebase ID token audience mismatch. Expected project "${expectedProjectId}".`
      );
    }
    if (payload.iss !== `https://securetoken.google.com/${expectedProjectId}`) {
      throw new AuthenticationRequiredError(
        `Firebase ID token issuer mismatch for project "${expectedProjectId}".`
      );
    }
    if (!payload.sub || typeof payload.sub !== 'string' || payload.sub.length > 128) {
      throw new AuthenticationRequiredError('Firebase ID token is missing a valid subject UID.');
    }
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
      throw new AuthenticationRequiredError('Firebase ID token has expired.');
    }

    return {
      uid: payload.sub,
      email: payload.email ? String(payload.email) : null,
      emailVerified: Boolean(payload.email_verified),
    };
  } catch (err) {
    if (err instanceof AuthenticationRequiredError) {
      throw err;
    }
    throw new AuthenticationRequiredError('Failed to decode Firebase ID token.');
  }
}

/**
 * Verifies a Firebase ID Token using the server-side Firebase Admin SDK (`admin.auth().verifyIdToken`).
 * Never exposes service account credentials to the client.
 */
export async function verifyFirebaseIdToken(idToken: string): Promise<AuthenticatedUserContext> {
  if (customTokenVerifierForTesting) {
    return customTokenVerifierForTesting(idToken);
  }

  const cfg = getServerConfig().firebase;
  const projectId = cfg.projectId || DEFAULT_FIREBASE_PROJECT_ID;

  // 1. Validate JWT structure, audience (`zyro-a3482`), issuer, and expiration first
  validateJwtClaimsPrecheck(idToken, projectId);

  // 2. Cryptographic verification via Firebase Admin SDK when credentials are configured
  if (isFirebaseAdminConfigured()) {
    try {
      const adminAuth = getFirebaseAdminAuth();
      const decoded = await adminAuth.verifyIdToken(idToken, true);
      if (!decoded || !decoded.uid) {
        throw new AuthenticationRequiredError('Firebase Admin token verification returned no UID.');
      }
      return {
        uid: decoded.uid,
        email: decoded.email || null,
        emailVerified: Boolean(decoded.email_verified),
        mode: 'verified_token',
      };
    } catch (err: any) {
      if (err instanceof AuthenticationRequiredError) {
        throw err;
      }
      throw new AuthenticationRequiredError(
        `Firebase ID token verification failed: ${err?.message || 'Unauthorized token.'}`
      );
    }
  }

  // 3. Optional fallback to Identity Toolkit lookup if VITE_FIREBASE_API_KEY is set
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

  // 4. If neither Firebase Admin credentials nor Web API key are configured, we cannot cryptographically
  // verify the signature; throw PersistenceNotConfiguredError so the caller knows server credentials are required.
  const fbStatus = getFirebaseConfigurationStatus();
  throw new PersistenceNotConfiguredError(fbStatus.missingEnvVars);
}

/**
 * Middleware that attaches `req.userContext` if a valid Bearer token is present.
 * Never blocks public/read endpoints when Firebase is unconfigured or no token is sent.
 */
export async function optionalAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const isConfigured = dataRepository.isConfigured() || Boolean(customTokenVerifierForTesting);
    if (!isConfigured) {
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
 * Strict Middleware for Protected User-Scoped Data Endpoints.
 * 1. Rejects missing or malformed Authorization headers with 401.
 * 2. Verifies the Firebase ID token (rejecting invalid, expired, or wrong-project tokens with 401).
 * 3. Ensures Firestore persistence is configured before allowing data mutations/reads.
 */
export async function requireUserScopedAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthenticationRequiredError(
        'Authentication required. Provide a valid Firebase ID token in the Authorization: Bearer <token> header.'
      );
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      throw new AuthenticationRequiredError('Bearer token cannot be empty.');
    }

    // Verify token claims & cryptographic signature (throws 401 on invalid/malformed/expired token)
    const verifiedUser = await verifyFirebaseIdToken(token);

    // Ensure persistence is configured before executing protected repository operations
    if (!dataRepository.isConfigured()) {
      const fbStatus = getFirebaseConfigurationStatus();
      throw new PersistenceNotConfiguredError(fbStatus.missingEnvVars);
    }

    req.userContext = verifiedUser;
    next();
  } catch (err) {
    next(err);
  }
}
