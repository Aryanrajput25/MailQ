FROM node:20-slim
RUN npm install -g pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# NEXT_PUBLIC_* values are baked in at build time. On Railway, set this variable BEFORE deploying.
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
RUN test -n "$NEXT_PUBLIC_API_BASE_URL" || (echo "ERROR: set NEXT_PUBLIC_API_BASE_URL (your backend's public https URL) before building" && exit 1)
RUN pnpm build
ENV NODE_ENV=production
# Railway provides $PORT; next start honours it. Bind all interfaces.
CMD ["sh", "-c", "pnpm exec next start -H 0.0.0.0 -p ${PORT:-3000}"]
