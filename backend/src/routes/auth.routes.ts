import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthService } from '../services/auth.service.js';
import { authenticate, verifyCsrf, SESSION_COOKIE_NAME } from '../middleware/auth.js';

const loginSchema = z.object({
  email: z.string().trim().email('Invalid email address format'),
  password: z.string().min(1, 'Password is required'),
});

export async function authRoutes(app: FastifyInstance) {
  // 1. Login Endpoint
  app.post('/api/auth/login', async (request, reply) => {
    const parseResult = loginSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: parseResult.error.errors[0]?.message || 'Invalid input',
      });
    }

    const { email, password } = parseResult.data;

    try {
      const { user, sessionToken, csrfToken, expiresAt } = await AuthService.login(
        email,
        password,
        request.ip,
        request.headers['user-agent'] || null
      );

      // Set hardened session cookie
      reply.setCookie(SESSION_COOKIE_NAME, sessionToken, {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.COOKIE_SAME_SITE === 'none' ? 'none' : 'strict',
        expires: expiresAt,
      });

      return reply.status(200).send({
        user,
        csrfToken,
      });
    } catch (err: any) {
      const statusCode = err.statusCode || 401;
      return reply.status(statusCode).send({
        error: statusCode === 423 ? 'Locked' : 'Unauthorized',
        message: err.message || 'Invalid email or password.',
      });
    }
  });

  // 2. Logout Endpoint
  app.post(
    '/api/auth/logout',
    { preHandler: [authenticate, verifyCsrf] },
    async (request, reply) => {
      const sessionToken = request.cookies[SESSION_COOKIE_NAME];
      if (sessionToken && request.user) {
        await AuthService.logout(
          sessionToken,
          request.user,
          request.ip,
          request.headers['user-agent'] || null
        );
      }

      reply.clearCookie(SESSION_COOKIE_NAME, {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.COOKIE_SAME_SITE === 'none' ? 'none' : 'strict',
      });

      return reply.status(200).send({
        status: 'success',
        message: 'Logged out successfully.',
      });
    }
  );

  // 3. Current User Context & CSRF token retrieval
  app.get('/api/auth/me', { preHandler: [authenticate] }, async (request) => {
    return {
      user: request.user,
      csrfToken: request.csrfToken,
    };
  });
}
