FROM node:22-alpine

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY src ./src

EXPOSE 8080
CMD ["sh", "-c", "sleep 5 && node src/seed.js && node src/index.js"]
