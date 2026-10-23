import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole, verifyCsrf } from '../middleware/auth.js';
import { AccessRequestService } from '../services/access-request.service.js';

const submitAccessRequestSchema = z.object({
  targetPermission: z.enum(['read', 'edit']).default('read'),
});

const reviewAccessRequestSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  permission: z.enum(['read', 'edit']).default('read'),
  expiresAt: z.string().datetime().nullable().optional(),
  reviewerNotes: z.string().max(500).nullable().optional(),
});

export async function accessRequestRoutes(app: FastifyInstance) {
  // 1. Submit neutral access request for a document (Zero existence leak)
  app.post(
    '/api/documents/:id/access-requests',
    { preHandler: [authenticate, verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;
      const { id: documentId } = request.params as { id: string };

      const parsed = submitAccessRequestSchema.safeParse(request.body || {});
      const targetPermission = parsed.success ? parsed.data.targetPermission : 'read';

      const result = await AccessRequestService.submitRequest(
        user,
        documentId,
        targetPermission,
        request.ip,
        request.headers['user-agent'] || null
      );

      return reply.status(200).send(result);
    }
  );

  // 2. List pending access requests for documents owned by caller (Owner-only)
  app.get(
    '/api/access-requests',
    { preHandler: [authenticate, requireRole('owner')] },
    async (request, reply) => {
      const user = request.user!;
      const requests = await AccessRequestService.listPendingRequestsForOwner(user);
      return reply.status(200).send({ requests });
    }
  );

  // 3. Review (approve/deny) access request (Owner-only)
  app.post(
    '/api/access-requests/:id/review',
    { preHandler: [authenticate, requireRole('owner'), verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;
      const { id: requestId } = request.params as { id: string };

      const parsed = reviewAccessRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: parsed.error.errors[0]?.message || 'Invalid review data',
        });
      }

      const { decision, permission, expiresAt, reviewerNotes } = parsed.data;

      const result = await AccessRequestService.reviewRequest(
        user,
        requestId,
        decision,
        permission,
        expiresAt ? new Date(expiresAt) : null,
        reviewerNotes || null,
        request.ip,
        request.headers['user-agent'] || null
      );

      return reply.status(200).send(result);
    }
  );
}
