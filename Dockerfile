FROM node:22-bookworm-slim

# Install Python, PIP, and FFmpeg for spotdl and yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install python binaries globally
RUN pip3 install --no-cache-dir yt-dlp spotdl

WORKDIR /app

# Copy the directories
COPY client ./client
COPY server ./server

# Build the Frontend
WORKDIR /app/client
RUN npm install
RUN npm run build

# Setup the Backend
WORKDIR /app/server
RUN npm install

# Expose the API port
EXPOSE 3000

# Start the server in production mode
ENV NODE_ENV=production
CMD ["node", "index.js"]
