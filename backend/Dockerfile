FROM node:20-alpine

WORKDIR /usr/src/app

# Install build tools for native modules (better-sqlite3, serialport)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --production

COPY . .

# Default env values (override via docker-compose or docker run -e)
ENV PORT=8080
ENV DATA_DIR=/data
ENV P1_SERIAL_PORT=/dev/ttyUSB0
ENV P1_BAUD_RATE=115200
ENV STORAGE_INTERVAL_MS=60000

EXPOSE 8080

# Volume for persistent SQLite database + Firebase credentials
VOLUME ["/data"]

CMD ["node", "src/server.js"]
