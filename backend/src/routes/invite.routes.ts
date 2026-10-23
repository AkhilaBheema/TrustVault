import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole, verifyCsrf } from '../middleware/auth.js';
import { InviteService } from '../services/invite.service.js';

const createInviteSchema = z.object({
  recipientEmail: z.string().trim().email('Invalid email address'),
  permission: z.enum(['read', 'edit']),
  expiresInHours: z.number().int().min(1).max(720).default(72), // Default 72 hours, max 30 days
});

const acceptInviteSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});

export async function inviteRoutes(app: FastifyInstance) {
  // 1. Create external share invite (Owner-only)
  app.post(
    '/api/documents/:id/invites',
    { preHandler: [authenticate, requireRole('owner'), verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;
      const { id: documentId } = request.params as { id: string };

      const parsed = createInviteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: parsed.error.errors[0]?.message || 'Invalid invite data',
        });
      }

      const { recipientEmail, permission, expiresInHours } = parsed.data;

      const result = await InviteService.createInvite(
        user,
        documentId,
        recipientEmail,
        permission,
        expiresInHours,
        request.ip,
        request.headers['user-agent'] || null
      );

      return reply.status(201).send(result);
    }
  );

  // 2. List invites for a document (Owner-only)
  app.get(
    '/api/documents/:id/invites',
    { preHandler: [authenticate, requireRole('owner')] },
    async (request, reply) => {
      const user = request.user!;
      const { id: documentId } = request.params as { id: string };

      const invites = await InviteService.listInvites(
        user,
        documentId,
        request.ip,
        request.headers['user-agent'] || null
      );

      return reply.status(200).send({ invites });
    }
  );

  // 3. Revoke share invite immediately (Owner-only)
  app.delete(
    '/api/documents/:id/invites/:inviteId',
    { preHandler: [authenticate, requireRole('owner'), verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;
      const { id: documentId, inviteId } = request.params as { id: string; inviteId: string };

      await InviteService.revokeInvite(
        user,
        documentId,
        inviteId,
        request.ip,
        request.headers['user-agent'] || null
      );

      return reply.status(200).send({
        message: 'Share invite successfully revoked.',
      });
    }
  );

  // 4. Accept/redeem share invite
  app.post(
    '/api/invites/accept',
    { preHandler: [authenticate, verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;

      const parsed = acceptInviteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: parsed.error.errors[0]?.message || 'Invite token is required',
        });
      }

      const result = await InviteService.acceptInvite(
        parsed.data.token,
        user,
        request.ip,
        request.headers['user-agent'] || null
      );

      return reply.status(200).send(result);
    }
  );
}
