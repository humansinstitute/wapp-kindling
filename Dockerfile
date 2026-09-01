FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN bun run build
ENV NODE_ENV=production
ENV PORT=80
EXPOSE 80
USER bun
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD bun -e "const response = await fetch('http://127.0.0.1:' + (process.env.PORT || '80') + '/api/health'); if (!response.ok) process.exit(1)"
CMD ["bun", "src/saas-server.ts"]
