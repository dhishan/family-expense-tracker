# Production Dockerfile for Cloud Run
FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./app/

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PORT=8000

# Expose port (Cloud Run uses PORT env variable)
EXPOSE 8000

# Run the application - Use PORT env variable from Cloud Run
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
