FROM oven/bun:1.4.4 AS build

WORKDIR /app

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

COPY . .

RUN bun run build


FROM oven/bun:1.4.4 AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build --chown=bun:bun /app/package.json ./
COPY --from=build --chown=bun:bun /app/bun.lock ./
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/src ./src
COPY --from=build --chown=bun:bun /app/tsconfig.json ./

USER bun

EXPOSE 3000

STOPSIGNAL SIGTERM

CMD ["bun", "dist/main.js"]