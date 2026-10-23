FROM node:22-alpine AS builder

WORKDIR /app

# Copy package definitions
COPY package*.json ./
COPY backend/package*.json ./backend/

# Install dependencies
RUN npm ci
RUN cd backend && npm ci

# Copy source code and database migrations
COPY backend ./backend
COPY db ./db
COPY tsconfig.json ./

# Compile TypeScript
RUN cd backend && npm run build

# Production runtime stage
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Install curl for healthcheck if needed
RUN apk add --no-cache curl

# Copy dependencies and built code
COPY package*.json ./
COPY backend/package*.json ./backend/
RUN npm ci --omit=dev
RUN cd backend && npm ci --omit=dev

COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/db ./db

# Create uploads directory and set permissions for non-root node user
RUN mkdir -p /app/uploads && chown -R node:node /app

USER node

EXPOSE 4000

CMD ["sh", "-c", "node backend/dist/db/migrate.js && node backend/dist/backend/src/server.js"]
