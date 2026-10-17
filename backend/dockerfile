FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && test -f dist/server.js && test -f dist/worker.js
ENV NODE_ENV=production
# start.js: checks env vars -> prisma migrate deploy -> runs API + email worker together.
CMD ["node", "scripts/start.js"]
