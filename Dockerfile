FROM node:22-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/backend
WORKDIR /app
COPY requirements.txt requirements-production.txt ./
RUN pip install --no-cache-dir -r requirements-production.txt
COPY manage.py ./
COPY backend/ ./backend/
COPY --from=frontend /build/backend/static/frontend/ ./backend/static/frontend/
RUN DB_ENGINE=sqlite python manage.py collectstatic --noinput \
    && useradd --create-home crm \
    && mkdir -p /data/media /app/tmp \
    && chown -R crm:crm /app /data
ENV DJANGO_SETTINGS_MODULE=crm_project.production
USER crm
EXPOSE 8000
CMD ["sh", "-c", "exec gunicorn crm_project.wsgi:application --bind 0.0.0.0:${PORT:-8000} --workers ${WEB_CONCURRENCY:-2} --timeout 120 --access-logfile - --error-logfile -"]
