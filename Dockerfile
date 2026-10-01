FROM python:3.13-slim

WORKDIR /srv

# Dependencies first, so editing the app does not re-download them.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# config.yaml is bind-mounted in, not baked in, so editing it does not mean
# rebuilding the image.
ENV DASH_CONFIG=/srv/config.yaml

EXPOSE 3002
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3002", "--log-level", "warning"]
