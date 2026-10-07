FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends xvfb && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
ENV SAHBI_PROFILE_DIR=/data/profile
EXPOSE 8080
CMD ["npm","start"]
