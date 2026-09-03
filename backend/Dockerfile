FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# 애플리케이션은 일반 사용자로 돌린다.
RUN useradd --create-home --uid 10001 promptshield \
    && chown -R promptshield:promptshield /app
USER promptshield

EXPOSE 8000

# curl 이 없는 slim 이미지라 파이썬 표준 라이브러리로 확인한다.
HEALTHCHECK --interval=10s --timeout=3s --retries=10 --start-period=15s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2).status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
