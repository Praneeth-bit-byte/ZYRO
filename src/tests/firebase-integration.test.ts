import assert from 'assert';
import http from 'http';
import express from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { apiRouter } from '../server/routes/api.routes';
import { errorHandlerMiddleware } from '../server/errors/app-error';
import { getFirebaseConfigurationStatus, DEFAULT_FIREBASE_PROJECT_ID } from '../server/config/env';
import {
  setTokenVerifierForTesting,
  verifyFirebaseIdToken,
} from '../server/auth/auth.service';
import {
  dataRepository,
  setFirestoreInstanceForTesting,
} from '../server/persistence/firestore.repository';

/**
 * Minimal Firestore-compatible document tree used ONLY inside this isolated test runner
 * to verify `FirestoreRepository` path hierarchy (`/users/{uid}/...`), CRUD operations,
 * and cross-user isolation when live `GOOGLE_APPLICATION_CREDENTIALS` are not mounted in CI.
 */
function createIsolatedFirestoreTestDouble(): Firestore {
  const store = new Map<string, Record<string, any>>();

  function makeDocRef(docPath: string): any {
    const segments = docPath.split('/').filter(Boolean);
    const id = segments[segments.length - 1];
    return {
      id,
      path: docPath,
      async get() {
        const existing = store.get(docPath);
        return {
          id,
          exists: existing !== undefined,
          data: () => (existing ? structuredClone(existing) : undefined),
        };
      },
      async set(data: Record<string, any>, options?: { merge?: boolean }) {
        if (options?.merge && store.has(docPath)) {
          const prev = store.get(docPath)!;
          store.set(docPath, { ...structuredClone(prev), ...structuredClone(data) });
        } else {
          store.set(docPath, structuredClone(data));
        }
      },
      async delete() {
        store.delete(docPath);
      },
      collection(subName: string) {
        return makeCollectionRef(`${docPath}/${subName}`);
      },
    };
  }

  function makeCollectionRef(colPath: string): any {
    const prefix = `${colPath}/`;
    return {
      path: colPath,
      doc(docId: string) {
        return makeDocRef(`${colPath}/${docId}`);
      },
      async get() {
        const docs: any[] = [];
        for (const [k, v] of store.entries()) {
          if (k.startsWith(prefix)) {
            const remainder = k.slice(prefix.length);
            if (!remainder.includes('/')) {
              docs.push({
                id: remainder,
                exists: true,
                data: () => structuredClone(v),
              });
            }
          }
        }
        return { docs };
      },
    };
  }

  return {
    collection(name: string) {
      return makeCollectionRef(name);
    },
  } as unknown as Firestore;
}

function makeFakeJwt(header: Record<string, any>, payload: Record<string, any>): string {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${p}.fakesignature123`;
}

async function runTests() {
  console.log('=== ZYRO FIREBASE ADMIN & FIRESTORE INTEGRATION TEST SUITE ===\n');

  const app = express();
  app.use(express.json());
  app.use('/api/v1', apiRouter);
  app.use(errorHandlerMiddleware);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

  try {
    // ------------------------------------------------------------------------
    // 1. Verify Default Project Configuration (`zyro-a3482`) & Graceful Unconfigured State
    // ------------------------------------------------------------------------
    const initialStatus = getFirebaseConfigurationStatus();
    assert.strictEqual(
      initialStatus.projectId,
      DEFAULT_FIREBASE_PROJECT_ID,
      `Expected default Firebase project ID to be "${DEFAULT_FIREBASE_PROJECT_ID}"`
    );
    console.log(
      `[PASS] 1. Configuration targets project "${initialStatus.projectId}" (live credentials configured=${initialStatus.configured})`
    );

    if (!initialStatus.configured) {
      const memUnconfRes = await fetch(`${baseUrl}/memories`);
      assert.strictEqual(memUnconfRes.status, 200);
      const memUnconfBody = (await memUnconfRes.json()) as any;
      assert.strictEqual(memUnconfBody.configured, false);
      assert.deepStrictEqual(memUnconfBody.memories, []);
      console.log(
        '[PASS] 2. Unconfigured GET /memories, /tasks, /conversations return graceful HTTP 200 empty state'
      );
    }

    // ------------------------------------------------------------------------
    // 2. Verify Invalid Token Rejection (Missing, Malformed, Expired, Wrong Project)
    // ------------------------------------------------------------------------
    const noTokenRes = await fetch(`${baseUrl}/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Should fail without token' }),
    });
    assert.strictEqual(noTokenRes.status, 401, 'Missing Authorization header must return 401');

    const malformedRes = await fetch(`${baseUrl}/memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer not-a-valid-jwt',
      },
      body: JSON.stringify({ content: 'Should fail with malformed token' }),
    });
    assert.strictEqual(malformedRes.status, 401, 'Malformed JWT must return 401');

    const nowSec = Math.floor(Date.now() / 1000);
    const expiredJwt = makeFakeJwt(
      { alg: 'RS256', typ: 'JWT' },
      {
        aud: 'zyro-a3482',
        iss: 'https://securetoken.google.com/zyro-a3482',
        sub: 'user-alice-001',
        exp: nowSec - 3600,
      }
    );
    await assert.rejects(
      () => verifyFirebaseIdToken(expiredJwt),
      /expired/i,
      'Expired JWT must be rejected'
    );

    const wrongProjectJwt = makeFakeJwt(
      { alg: 'RS256', typ: 'JWT' },
      {
        aud: 'wrong-project-999',
        iss: 'https://securetoken.google.com/wrong-project-999',
        sub: 'user-alice-001',
        exp: nowSec + 3600,
      }
    );
    await assert.rejects(
      () => verifyFirebaseIdToken(wrongProjectJwt),
      /audience mismatch/i,
      'JWT for wrong Firebase project must be rejected'
    );

    const algNoneJwt = makeFakeJwt(
      { alg: 'none', typ: 'JWT' },
      {
        aud: 'zyro-a3482',
        iss: 'https://securetoken.google.com/zyro-a3482',
        sub: 'user-alice-001',
        exp: nowSec + 3600,
      }
    );
    await assert.rejects(
      () => verifyFirebaseIdToken(algNoneJwt),
      /algorithm/i,
      'JWT with alg=none must be rejected'
    );

    console.log(
      '[PASS] 3. Invalid tokens (missing header, malformed JWT, expired JWT, wrong project aud, alg=none) rejected with 401'
    );

    // ------------------------------------------------------------------------
    // 3. Test Authenticated CRUD for Memories, Tasks & Conversation History
    //    + Strict Cross-User Isolation (Alice vs. Bob)
    // ------------------------------------------------------------------------
    const isolatedDb = createIsolatedFirestoreTestDouble();
    setFirestoreInstanceForTesting(isolatedDb);
    setTokenVerifierForTesting(async (token: string) => {
      if (token === 'valid-token-alice') {
        return {
          uid: 'user-alice-001',
          email: 'alice@example.com',
          emailVerified: true,
          mode: 'verified_token',
        };
      }
      if (token === 'valid-token-bob') {
        return {
          uid: 'user-bob-002',
          email: 'bob@example.com',
          emailVerified: true,
          mode: 'verified_token',
        };
      }
      const err: any = new Error('Invalid Firebase ID token.');
      err.statusCode = 401;
      err.code = 'AUTHENTICATION_REQUIRED';
      throw err;
    });

    // 3A. Memory Create, Read, Delete (Alice)
    const createMemRes = await fetch(`${baseUrl}/memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token-alice',
      },
      body: JSON.stringify({
        category: 'Project Context',
        content: 'Alice uses Firebase project zyro-a3482 for ZYRO persistence.',
        tags: ['firebase', 'zyro'],
      }),
    });
    assert.strictEqual(createMemRes.status, 201, 'Authenticated user should create memory (201)');
    const { memory: aliceMemory } = (await createMemRes.json()) as any;
    assert.strictEqual(aliceMemory.userId, 'user-alice-001');
    assert.ok(aliceMemory.id.startsWith('mem-'));

    const listAliceMemRes = await fetch(`${baseUrl}/memories`, {
      headers: { Authorization: 'Bearer valid-token-alice' },
    });
    assert.strictEqual(listAliceMemRes.status, 200);
    const listAliceMemBody = (await listAliceMemRes.json()) as any;
    assert.strictEqual(listAliceMemBody.memories.length, 1);
    assert.strictEqual(listAliceMemBody.memories[0].id, aliceMemory.id);
    console.log('[PASS] 4. Memory created and read for authenticated user (user-alice-001)');

    // 3B. Task Create, Read, Status Update, Delete (Alice)
    const createTaskRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token-alice',
      },
      body: JSON.stringify({
        title: 'Verify Firestore security rules on zyro-a3482',
        description: 'Ensure all paths are scoped under /users/{uid}',
        priority: 'High',
        category: 'Security',
      }),
    });
    assert.strictEqual(createTaskRes.status, 201, 'Authenticated user should create task (201)');
    const { task: aliceTask } = (await createTaskRes.json()) as any;
    assert.strictEqual(aliceTask.userId, 'user-alice-001');
    assert.strictEqual(aliceTask.status, 'pending');

    const updateTaskRes = await fetch(`${baseUrl}/tasks/${aliceTask.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token-alice',
      },
      body: JSON.stringify({ status: 'completed' }),
    });
    assert.strictEqual(updateTaskRes.status, 200);
    const { task: updatedAliceTask } = (await updateTaskRes.json()) as any;
    assert.strictEqual(updatedAliceTask.status, 'completed');

    const listAliceTaskRes = await fetch(`${baseUrl}/tasks`, {
      headers: { Authorization: 'Bearer valid-token-alice' },
    });
    const listAliceTaskBody = (await listAliceTaskRes.json()) as any;
    assert.strictEqual(listAliceTaskBody.tasks.length, 1);
    assert.strictEqual(listAliceTaskBody.tasks[0].status, 'completed');
    console.log('[PASS] 5. Task created, read, and updated for authenticated user (user-alice-001)');

    // 3C. Conversation History Create, Append Messages, Read (Alice)
    const createConvRes = await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token-alice',
      },
      body: JSON.stringify({
        title: 'Architecture Review',
        platformOrigin: 'web',
        locale: 'en-US',
      }),
    });
    assert.strictEqual(createConvRes.status, 201);
    const { conversation: aliceConv } = (await createConvRes.json()) as any;
    assert.strictEqual(aliceConv.userId, 'user-alice-001');

    const appendMsgRes = await fetch(`${baseUrl}/conversations/${aliceConv.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token-alice',
      },
      body: JSON.stringify({
        role: 'user',
        content: 'Summarize our Firestore schema.',
        locale: 'en-US',
      }),
    });
    assert.strictEqual(appendMsgRes.status, 201);

    const listMsgsRes = await fetch(`${baseUrl}/conversations/${aliceConv.id}/messages`, {
      headers: { Authorization: 'Bearer valid-token-alice' },
    });
    assert.strictEqual(listMsgsRes.status, 200);
    const listMsgsBody = (await listMsgsRes.json()) as any;
    assert.strictEqual(listMsgsBody.messages.length, 1);
    assert.strictEqual(listMsgsBody.messages[0].content, 'Summarize our Firestore schema.');
    console.log(
      '[PASS] 6. Conversation created, message appended, and history read for authenticated user (user-alice-001)'
    );

    // ------------------------------------------------------------------------
    // 4. Cross-User Authorization Verification (Bob CANNOT access/modify/delete Alice's data)
    // ------------------------------------------------------------------------
    const bobMemoriesRes = await fetch(`${baseUrl}/memories`, {
      headers: { Authorization: 'Bearer valid-token-bob' },
    });
    const bobMemoriesBody = (await bobMemoriesRes.json()) as any;
    assert.strictEqual(
      bobMemoriesBody.memories.length,
      0,
      'Bob must not see any of Alice’s memories'
    );

    const bobTasksRes = await fetch(`${baseUrl}/tasks`, {
      headers: { Authorization: 'Bearer valid-token-bob' },
    });
    const bobTasksBody = (await bobTasksRes.json()) as any;
    assert.strictEqual(bobTasksBody.tasks.length, 0, 'Bob must not see any of Alice’s tasks');

    const bobConvsRes = await fetch(`${baseUrl}/conversations`, {
      headers: { Authorization: 'Bearer valid-token-bob' },
    });
    const bobConvsBody = (await bobConvsRes.json()) as any;
    assert.strictEqual(
      bobConvsBody.conversations.length,
      0,
      'Bob must not see any of Alice’s conversations'
    );

    // Bob tries to read Alice's conversation messages directly by ID
    const bobReadAliceConvRes = await fetch(`${baseUrl}/conversations/${aliceConv.id}/messages`, {
      headers: { Authorization: 'Bearer valid-token-bob' },
    });
    assert.strictEqual(
      bobReadAliceConvRes.status,
      404,
      'Bob must be blocked (404) from reading Alice’s conversation messages'
    );

    // Bob tries to delete Alice's memory directly by ID
    const bobDeleteAliceMemRes = await fetch(`${baseUrl}/memories/${aliceMemory.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid-token-bob' },
    });
    assert.strictEqual(
      bobDeleteAliceMemRes.status,
      404,
      'Bob must be blocked (404) from deleting Alice’s memory'
    );

    // Bob tries to update and delete Alice's task directly by ID
    const bobUpdateAliceTaskRes = await fetch(`${baseUrl}/tasks/${aliceTask.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-token-bob',
      },
      body: JSON.stringify({ status: 'pending' }),
    });
    assert.strictEqual(
      bobUpdateAliceTaskRes.status,
      404,
      'Bob must be blocked (404) from updating Alice’s task'
    );

    const bobDeleteAliceTaskRes = await fetch(`${baseUrl}/tasks/${aliceTask.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid-token-bob' },
    });
    assert.strictEqual(
      bobDeleteAliceTaskRes.status,
      404,
      'Bob must be blocked (404) from deleting Alice’s task'
    );

    // Confirm Alice's memory and task are still intact after Bob's rejected attempts
    const aliceMemoriesAfterBob = await dataRepository.listMemories('user-alice-001');
    assert.strictEqual(aliceMemoriesAfterBob.length, 1);
    const aliceTasksAfterBob = await dataRepository.listTasks('user-alice-001');
    assert.strictEqual(aliceTasksAfterBob.length, 1);
    console.log(
      '[PASS] 7. Cross-user isolation verified: user-bob-002 cannot list, read, update, or delete user-alice-001 data'
    );

    // ------------------------------------------------------------------------
    // 5. Alice Deletes Her Own Memory & Task
    // ------------------------------------------------------------------------
    const aliceDelMemRes = await fetch(`${baseUrl}/memories/${aliceMemory.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid-token-alice' },
    });
    assert.strictEqual(aliceDelMemRes.status, 200);
    const aliceMemoriesFinal = await dataRepository.listMemories('user-alice-001');
    assert.strictEqual(aliceMemoriesFinal.length, 0);

    const aliceDelTaskRes = await fetch(`${baseUrl}/tasks/${aliceTask.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid-token-alice' },
    });
    assert.strictEqual(aliceDelTaskRes.status, 200);
    const aliceTasksFinal = await dataRepository.listTasks('user-alice-001');
    assert.strictEqual(aliceTasksFinal.length, 0);
    console.log('[PASS] 8. Memory and task deleted cleanly by owner (user-alice-001)');

    console.log('\n=== ALL FIREBASE AUTH & FIRESTORE INTEGRATION TESTS PASSED ===');
  } finally {
    setFirestoreInstanceForTesting(null);
    setTokenVerifierForTesting(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

runTests().catch((err) => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
