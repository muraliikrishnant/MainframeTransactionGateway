FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      gnucobol3 \
      python3 \
      python3-pip \
      python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY txnengine.cob .
COPY interest.cob .
COPY bridge.py .

RUN cobc -x -o txnengine txnengine.cob && \
    cobc -x -o interest interest.cob

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir flask gunicorn

EXPOSE 9001
CMD ["gunicorn", "-b", "0.0.0.0:9001", "--workers", "2", "bridge:app"]
