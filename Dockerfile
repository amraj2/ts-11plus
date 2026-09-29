FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./
COPY data ./data
COPY static ./static
COPY templates ./templates

RUN useradd --create-home appuser
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT','8000'))"
CMD ["sh", "-c", "exec gunicorn app:app --workers 2 --threads 4 --timeout 30 --bind 0.0.0.0:${PORT} --access-logfile -"]
