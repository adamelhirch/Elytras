FROM python:3.12-slim

WORKDIR /app

# curl + Tesseract OCR (PDF scannés/images) + bubblewrap (bac à sable du code) + Node 22
# (blocs de code JavaScript/TypeScript — Node 22 exécute le TS nativement via strip-types).
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates bubblewrap tesseract-ocr tesseract-ocr-fra tesseract-ocr-eng \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY elytras/ ./elytras/
COPY skills/ ./skills/

ENV SKILLS_DIR=/app/skills

EXPOSE 8000
CMD ["uvicorn", "elytras.main:app", "--host", "0.0.0.0", "--port", "8000"]
