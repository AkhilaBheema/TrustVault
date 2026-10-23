export type UserRole = 'admin' | 'owner' | 'viewer';

export interface UserContext {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  organizationId: string;
  isDisabled: boolean;
}

export interface SessionData {
  id: string;
  userId: string;
  sessionTokenHash: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  expiresAt: Date;
}

export interface AuthenticatedUser extends UserContext {
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    csrfToken?: string;
  }
}
