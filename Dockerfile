FROM oven/bun:1.3.14

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY . .

# ACT: 保留工作区与依赖以兼容运行时动态加载；需要缩减镜像时再拆分构建阶段。
RUN bun install --frozen-lockfile

RUN bun run build:server \
    && mkdir -p data/workspaces/myProject \
    && chown -R bun:bun data

ENV NODE_ENV=production
ENV TOONFLOW_DATA_DIR=/app/data

# 服务器镜像默认启用管理员认证（桌面端不经过本入口，行为不变）。
# 管理员密码等凭据只允许运行时注入（TOONFLOW_ADMIN_PASSWORD），任何密钥不写入镜像层或 ENV 默认值。
ENV TOONFLOW_AUTH=1

USER bun
EXPOSE 3000

CMD ["bun", "build/server/index.js"]
