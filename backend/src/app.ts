import fastify, { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { loadEnvironment } from './config/env.js';
import { authRoutes } from './routes/auth.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { documentRoutes } from './routes/document.routes.js';
import { inviteRoutes } from './routes/invite.routes.js';
import { accessRequestRoutes } from './routes/access-request.routes.js';
import { auditRoutes } from './routes/audit.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { suggestionsRoutes } from './routes/suggestions.routes.js';

loadEnvironment();

export interface AppOptions {
  enableLogging?: boolean;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = fastify({
    logger: options.enableLogging ?? false,
    trustProxy: process.env.TRUST_PROXY === 'true',
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  // 1. Security Headers (Helmet)
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: true,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    noSniff: true,
    xssFilter: true,
  });

  // 2. CORS locked to own origin
  const allowedOrigin = process.env.CORS_ORIGIN;
  if (!allowedOrigin) {
    throw new Error('CORS_ORIGIN must be configured');
  }
  const corsOrigins = allowedOrigin.split(',').map(o => o.trim());
  app.register(cors, {
    origin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  });

  // 3. HTTP-Only Cookie Support
  app.register(cookie, {
    parseOptions: {},
  });

  // 4. Rate Limiting (Hardening against brute-force)
  app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please slow down and try again later.',
    }),
  });

  // 5. Multipart file upload limits (15 MB maximum)
  app.register(multipart, {
    limits: {
      fileSize: 15 * 1024 * 1024,
      files: 1,
    },
  });

  // 6. Health Check Endpoint
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      service: 'trustvault-backend',
      timestamp: new Date().toISOString(),
    };
  });

  // 7. Application Routes
  app.register(authRoutes);
  app.register(adminRoutes);
  app.register(documentRoutes);
  app.register(inviteRoutes);
  app.register(accessRequestRoutes);
  app.register(auditRoutes);
  app.register(dashboardRoutes);
  app.register(suggestionsRoutes);

  // 8. Global Uniform Error Handler (Zero internal information disclosure)
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error.statusCode || 500;

    // Log the error internally
    if (statusCode >= 500) {
      app.log.error(error);
    }

    // Never leak stack traces, internal paths, or authorization error names to the client
    const responseBody = {
      error: statusCode === 404 ? 'Not Found' : (error.name || 'InternalServerError'),
      message: statusCode >= 500
        ? 'An unexpected server error occurred.'
        : (statusCode === 404 ? 'Resource not found or access denied.' : error.message),
    };

    reply.status(statusCode).send(responseBody);
  });

  // 7. Uniform 404 Handler
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({
      error: 'Not Found',
      message: 'Resource not found or access denied.',
    });
  });

  return app;
}
