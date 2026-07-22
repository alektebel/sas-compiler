FROM node:22-bookworm-slim AS frontend

WORKDIR /app/sas-schema-explorer
COPY sas-schema-explorer/package.json sas-schema-explorer/package-lock.json ./
RUN npm ci
COPY sas-schema-explorer/ ./
RUN npm run build

FROM python:3.12-slim

WORKDIR /app
ENV REGLLM_PATH=/opt/regllm \
    GGUF_MODELS_DIR=/models \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt backend/requirements-gguf.txt ./backend/
RUN pip install --no-cache-dir -r backend/requirements-gguf.txt
COPY backend/ ./backend/
COPY --from=frontend /app/sas-schema-explorer/dist ./sas-schema-explorer/dist

EXPOSE 8000
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
