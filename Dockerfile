FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN bun run build && mkdir -p /data && chown -R bun:bun /data
ENV NODE_ENV=production
ENV PORT=80
ENV CHAT_WAPP_DB_PATH=/data/kindling-fe.sqlite
EXPOSE 80
VOLUME ["/data"]
USER bun
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD bun -e "const response = await fetch('http://127.0.0.1:' + (process.env.PORT || '80') + '/api/health'); if (!response.ok) process.exit(1)"
CMD ["bun", "src/server.ts"]
