import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole, verifyCsrf } from '../middleware/auth.js';
import { AuthorizationService } from '../services/authorization.service.js';
import { SuggestionsService } from '../services/suggestions.service.js';
import { AuditService } from '../services/audit.service.js';

/**
 * AI Sharing Suggestions Routes — P8
 *
 * Two endpoints:
 *  POST /api/documents/:id/suggestions
 *    → Generates suggestions via Claude or rule-based fallback.
 *    → Owner-only. Audits the suggestion event (inputs + candidate IDs returned).
 *    → Returns suggestions as PROPOSALS only — no grant is created.
 *
 *  POST /api/documents/:id/suggestions/confirm
 *    → Human confirms a specific suggestion, which writes the actual grant.
 *    → Audits the human decision (accepted / rejected / modified).
 *
 * Security invariants:
 *   - No grant is ever written by the AI path (SuggestionsService never calls GrantService).
 *   - File contents are never passed to the AI.
 *   - Both the suggestion and the human decision are audited.
 *   - The confirm endpoint calls authorize('manage_grants') so only owners can confirm.
 */
export async function suggestionsRoutes(app: FastifyInstance) {

  // 1. Generate AI sharing suggestions (owner-only)
  app.post(
    '/api/documents/:id/suggestions',
    { preHandler: [authenticate, requireRole('owner'), verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;
      const { id: documentId } = request.params as { id: string };

      // Authorization check: only the owner of this document can request suggestions
      await AuthorizationService.authorize(user, documentId, 'manage_grants', {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || null,
      });

      const result = await SuggestionsService.generateSuggestions(
        documentId,
        user.organizationId,
        user.id
      );

      // Audit: log the suggestion event (inputs + user IDs suggested — NOT file contents)
      await AuditService.log({
        eventType: 'AI_SUGGESTION',
        action: 'AI_SUGGESTIONS_GENERATED',
        status: 'INFO',
        actorId: user.id,
        actorEmail: user.email,
        organizationId: user.organizationId,
        targetType: 'DOCUMENT',
        targetId: documentId,
        reason: `AI suggestions generated via provider: ${result.provider}`,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || null,
        payload: {
          provider: result.provider,
          inputSummary: result.inputSummary,
          suggestedUserIds: result.suggestions.map((s) => s.userId),
          suggestionCount: result.suggestions.length,
          // NEVER log file contents or the full prompt
        },
      });

      return reply.status(200).send({
        suggestions: result.suggestions,
        provider: result.provider,
        note: 'These are PROPOSALS only. No access has been granted. A human must confirm each suggestion.',
      });
    }
  );

  // 2. Human confirms a suggestion (writes the grant, audited separately)
  const confirmSchema = z.object({
    userId: z.string().uuid('userId must be a valid UUID'),
    suggestedPermission: z.enum(['read', 'edit']),
    // The human may modify the suggested permission before confirming
    confirmedPermission: z.enum(['read', 'edit']),
    expiresAt: z.string().datetime().nullable().optional(),
    // Was the suggestion accepted, rejected, or modified?
    decision: z.enum(['accepted', 'rejected', 'modified']),
    // The rationale the AI gave (logged for traceability — not acted upon)
    aiRationale: z.string().max(500).optional(),
  });

  app.post(
    '/api/documents/:id/suggestions/confirm',
    { preHandler: [authenticate, requireRole('owner'), verifyCsrf] },
    async (request, reply) => {
      const user = request.user!;
      const { id: documentId } = request.params as { id: string };

      const parsed = confirmSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: parsed.error.errors[0]?.message || 'Invalid confirmation data',
        });
      }

      const { userId, suggestedPermission, confirmedPermission, expiresAt, decision, aiRationale } = parsed.data;

      // Authorization check: must be the document owner
      await AuthorizationService.authorize(user, documentId, 'manage_grants', {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || null,
      });

      // Audit the human decision FIRST (before potentially writing the grant)
      await AuditService.log({
        eventType: 'AI_SUGGESTION',
        action: 'AI_SUGGESTION_HUMAN_DECISION',
        status: 'ALLOWED',
        actorId: user.id,
        actorEmail: user.email,
        organizationId: user.organizationId,
        targetType: 'DOCUMENT',
        targetId: documentId,
        reason: `Human decision on AI suggestion: ${decision}`,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || null,
        payload: {
          targetUserId: userId,
          suggestedPermission,
          confirmedPermission,
          decision,
          aiRationale: aiRationale || null,
          expiresAt: expiresAt || null,
        },
      });

      if (decision === 'rejected') {
        return reply.status(200).send({
          decision: 'rejected',
          message: 'Suggestion rejected. No access has been granted.',
        });
      }

      // Only if accepted or modified do we actually create the grant.
      // Import GrantService here (not at top of file) to make it obvious
      // that the AI suggestion flow is the ONLY caller of grant creation here.
      const { GrantService } = await import('../services/grant.service.js');

      const grant = await GrantService.issueGrant(
        user,
        documentId,
        userId,
        confirmedPermission,
        expiresAt ? new Date(expiresAt) : null,
        request.ip,
        request.headers['user-agent'] || null
      );

      return reply.status(201).send({
        decision,
        grant,
        message: `Grant ${decision === 'accepted' ? 'accepted as suggested' : 'created with modified permission'}.`,
      });
    }
  );
}
