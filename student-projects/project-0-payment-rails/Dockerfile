FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY simulator/ ./simulator/
COPY web/ ./web/
COPY data/ ./data/
COPY start.py ./start.py
RUN useradd --create-home --uid 10001 demo
USER demo
EXPOSE 8010
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8010/healthz', timeout=3)"
ENTRYPOINT ["python", "start.py", "--host", "0.0.0.0", "--port", "8010", "--no-browser"]
