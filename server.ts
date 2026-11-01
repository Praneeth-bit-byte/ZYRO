import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { getServerConfig } from './src/server/config/env';
import { errorHandlerMiddleware } from './src/server/errors/app-error';
import { apiRouter } from './src/server/routes/api.routes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const { port } = getServerConfig();

  app.use(express.json({ limit: '2mb' }));

  // Prevent browser/iframe caching of API responses and transformed dev modules when HMR is disabled
  app.use((req, res, next) => {
    if (
      req.path.startsWith('/api') ||
      req.path.startsWith('/src') ||
      req.path === '/' ||
      req.path.endsWith('.html')
    ) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });

  // Mount Modular ZYRO v1 API
  app.use('/api/v1', apiRouter);

  // Explicit JSON 404 for unmatched /api/* routes so Vite SPA fallback never returns HTML for API calls
  app.use('/api', (req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `API endpoint ${req.method} ${req.originalUrl} not found.`,
      },
    });
  });

  // Centralized API Error Boundary
  app.use(errorHandlerMiddleware);

  // Frontend Serving (Vite Dev Middleware or Production Static Bundle)
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`[ZYRO] Modular Backend & Workspace listening on http://0.0.0.0:${port}`);
  });
}

startServer();
