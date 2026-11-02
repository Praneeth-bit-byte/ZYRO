import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { Auth, getAuth } from 'firebase-admin/auth';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { getFirebaseConfigurationStatus, getServerConfig } from '../config/env';
import { AppError, PersistenceNotConfiguredError } from '../errors/app-error';

/**
 * Server-Side Firebase Admin SDK Client (`zyro-a3482`)
 *
 * Initializes `firebase-admin` strictly on the backend using credentials resolved from:
 * 1. `GOOGLE_APPLICATION_CREDENTIALS` (file path to service account JSON)
 * 2. `FIREBASE_SERVICE_ACCOUNT_JSON` (inline JSON secret in hosting environments)
 * 3. `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` (discrete server env vars)
 *
 * Never imported by frontend code. Never exposes private keys or credentials.
 */

const ZYRO_ADMIN_APP_NAME = 'zyro-firebase-admin';

interface CachedAdminContext {
  fingerprint: string;
  app: App;
  auth: Auth;
  firestore: Firestore;
}

let cachedContext: CachedAdminContext | null = null;

export function isFirebaseAdminConfigured(): boolean {
  return getFirebaseConfigurationStatus().configured;
}

export function getFirebaseAdminContext(): CachedAdminContext {
  const status = getFirebaseConfigurationStatus();
  if (!status.configured) {
    throw new PersistenceNotConfiguredError(status.missingEnvVars);
  }

  const fb = getServerConfig().firebase;
  const fingerprint = `${fb.projectId}:${fb.databaseId}:${fb.clientEmail}:${fb.source}`;

  if (cachedContext && cachedContext.fingerprint === fingerprint) {
    return cachedContext;
  }

  try {
    const existingApp = getApps().find((a) => a.name === ZYRO_ADMIN_APP_NAME);
    const app =
      existingApp ||
      initializeApp(
        {
          credential: cert({
            projectId: fb.projectId,
            clientEmail: fb.clientEmail,
            privateKey: fb.privateKey,
          }),
          projectId: fb.projectId,
        },
        ZYRO_ADMIN_APP_NAME
      );

    const auth = getAuth(app);
    const firestore =
      fb.databaseId && fb.databaseId !== '(default)'
        ? getFirestore(app, fb.databaseId)
        : getFirestore(app);

    // Ensure undefined properties in optional fields (e.g., description, dueDate) are ignored cleanly by Firestore
    try {
      firestore.settings({ ignoreUndefinedProperties: true });
    } catch {
      // Firestore settings may already be locked if initialized previously in the same process
    }

    cachedContext = {
      fingerprint,
      app,
      auth,
      firestore,
    };

    return cachedContext;
  } catch (err: any) {
    throw new AppError({
      statusCode: 503,
      code: 'PERSISTENCE_NOT_CONFIGURED',
      message: `Failed to initialize Firebase Admin SDK for project "${fb.projectId}": ${
        err?.message || 'Invalid service account credentials.'
      }`,
    });
  }
}

export function getFirebaseAdminAuth(): Auth {
  return getFirebaseAdminContext().auth;
}

export function getFirebaseAdminFirestore(): Firestore {
  return getFirebaseAdminContext().firestore;
}
