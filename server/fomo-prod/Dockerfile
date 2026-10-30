FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FOMO_API_BASE=https://prod-api.fomo.family \
    FOMO_AUTH_TOKEN_FILE=/credentials/access_token \
    FOMO_REFRESH_TOKEN_FILE=/credentials/refresh_token \
    PORT=8080

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY request_guard.py ./
COPY bridge.py ./

EXPOSE 8080
CMD ["python", "/app/bridge.py"]
