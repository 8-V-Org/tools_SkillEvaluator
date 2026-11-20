FROM python:3.13-slim

ENV PIP_NO_INPUT=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git curl \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/8-V-Org/tools_SkillEvaluator.git /opt/skillevaluator \
  && python -m pip install --no-cache-dir --upgrade pip \
  && python -m pip install --no-cache-dir "/opt/skillevaluator[tier2,security]" \
  && skillevaluator --help >/dev/null

COPY --from=docker.io/cloudflare/sandbox:1.0.1 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

WORKDIR /workspace
