# NanoClaw Agent Container (Cursor Edition)
# Runs Cursor Agent CLI in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for browser automation
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install Cursor CLI and agent-browser globally
RUN curl https://cursor.com/install -fsS | bash \
    && npm install -g agent-browser

# Add Cursor CLI to PATH
ENV PATH="/root/.local/bin:$PATH"

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks

# Create entrypoint script
# Sources env from mounted /workspace/env-dir/env if it exists (workaround for Apple Container -i bug)
RUN printf '#!/bin/bash\nset -e\n[ -f /workspace/env-dir/env ] && export $(cat /workspace/env-dir/env | xargs)\ncat > /tmp/input.json\nnode /app/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Copy Cursor CLI to node user's path (copy entire .local including share with actual binaries)
RUN mkdir -p /home/node/.local \
    && cp -rL /root/.local/* /home/node/.local/ 2>/dev/null || true \
    && chmod -R +x /home/node/.local/bin/ \
    && chown -R node:node /workspace /home/node/.local

# Switch to non-root user
USER node

# Add Cursor CLI to node user's PATH (point directly to versions dir with node binary)
ENV PATH="/home/node/.local/share/cursor-agent/versions/2026.01.28-fd13201:/home/node/.local/bin:$PATH"

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
