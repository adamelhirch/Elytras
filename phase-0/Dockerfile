FROM python:3.12-slim

WORKDIR /app

# curl + Tesseract OCR (français/anglais) pour lire les PDF scannés / images / étiquettes.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl tesseract-ocr tesseract-ocr-fra tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY elytras/ ./elytras/
COPY skills/ ./skills/

ENV SKILLS_DIR=/app/skills

EXPOSE 8000
CMD ["uvicorn", "elytras.main:app", "--host", "0.0.0.0", "--port", "8000"]
