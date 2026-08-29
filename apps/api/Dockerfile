FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w @tavi/api --include=dev

COPY apps/api apps/api
RUN npx prisma generate --schema apps/api/prisma/schema.prisma

ENV NODE_ENV=production
ENV UPLOAD_DIR=/data/attachments
EXPOSE 3457

# Pending migrations are applied automatically on boot
CMD ["sh", "-c", "npx prisma migrate deploy --schema apps/api/prisma/schema.prisma && npm run start -w @tavi/api"]
