# 文件：deploy/docker/web.Dockerfile
# 作用：构建 Next.js 前端镜像，两阶段：第一阶段安装依赖并构建，
#   第二阶段只带构建产物（standalone）运行，
# 镜像小、以非 root 用户 node 运行。NEXT_PUBLIC_* 在构建阶段写进前端代码。

# Builds the Next.js front end: docker build -f deploy/docker/web.Dockerfile ...
# The NEXT_PUBLIC_* addresses are read by the browser, so they are fixed at build time.
FROM node:20-slim AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ARG NEXT_PUBLIC_OIDC_AUTHORITY=http://localhost:8080/realms/starit
ARG NEXT_PUBLIC_OIDC_CLIENT_ID=starit-web
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_OIDC_AUTHORITY=$NEXT_PUBLIC_OIDC_AUTHORITY \
    NEXT_PUBLIC_OIDC_CLIENT_ID=$NEXT_PUBLIC_OIDC_CLIENT_ID \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
