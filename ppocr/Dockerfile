# PP-OCRv5 mobile + VietOCR service for the k-ocr bill page (CPU).
#   docker build -t k-ocr-ppocr ppocr && docker run -d --name k-ocr-ppocr --restart unless-stopped -p 127.0.0.1:8866:8866 k-ocr-ppocr
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir paddlepaddle==3.2.2 paddleocr==3.7.0
# VietOCR's gdown still imports pkg_resources, which setuptools 81 dropped.
RUN pip install --no-cache-dir torch==2.14.1 torchvision==0.29.1 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir vietocr==0.3.13 "setuptools<81"
ENV PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
WORKDIR /app
COPY server.py textmerge.py .
# Download the models at build time so the container starts offline.
RUN python -c "import server"
EXPOSE 8866
CMD ["python", "server.py"]
