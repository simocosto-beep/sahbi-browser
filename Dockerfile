FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
ENV SAHBI_PROFILE_DIR=/data/profile
EXPOSE 8080
CMD ["xvfb-run","-a","npm","start"]
