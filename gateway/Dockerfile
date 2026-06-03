FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY elytras_gateway ./elytras_gateway
EXPOSE 8088
# Derrière un reverse proxy TLS (Caddy). 0.0.0.0 = interface du conteneur (mappée en 127.0.0.1 côté hôte).
CMD ["uvicorn", "elytras_gateway.main:app", "--host", "0.0.0.0", "--port", "8088"]
