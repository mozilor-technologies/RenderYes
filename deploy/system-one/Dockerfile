# The System One model server for RenderYes: `laya-serve` with the RenderYes
# fine-tune registered under the model name `renderyes`.
#
# The checkpoint is NOT in this image. Mount it at /models/renderyes (see
# README.md and docker-compose.yml). The image only knows how to serve it.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# A non-root user with a writable home: the Hugging Face libraries create a
# cache directory under $HOME even when they never download anything.
RUN useradd --system --create-home --uid 10001 --user-group laya

WORKDIR /app

# torch comes from the CPU wheel index: the default PyPI wheel on x86_64
# bundles CUDA and is several gigabytes larger for no gain on a CPU host.
# Everything else is pinned in requirements.txt.
COPY requirements.txt ./
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.14.1 \
 && pip install -r requirements.txt

COPY --chmod=0755 entrypoint.sh probe.py ./

# laya-serve configuration. Every LAYA_* variable can be overridden at run
# time; these are the defaults a CPU host wants.
#   LAYA_EXTRA_MODELS   registers the mounted checkpoint as `renderyes`
#   LAYA_MODELS         preload only that checkpoint (never the bundled ones)
#   LAYA_DEFAULT_MODEL  route a request with no `model` to it as well
#   HF_HUB_OFFLINE      never reach for the Hugging Face Hub
ENV LAYA_HOST=0.0.0.0 \
    LAYA_PORT=8000 \
    LAYA_DEVICE=cpu \
    LAYA_PRELOAD=1 \
    LAYA_MODELS=renderyes \
    LAYA_DEFAULT_MODEL=renderyes \
    LAYA_MAX_LOADED=1 \
    LAYA_EXTRA_MODELS='{"renderyes":"/models/renderyes"}' \
    HF_HOME=/home/laya/.cache/huggingface \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

USER laya

EXPOSE 8000

# Healthy only once a real classification request succeeds, which needs the
# checkpoint loaded and the first inference done. The start period covers a
# slow disk: a failed probe inside it does not count against the container.
HEALTHCHECK --interval=30s --timeout=15s --start-period=5m --retries=3 \
  CMD ["python", "/app/probe.py"]

ENTRYPOINT ["/app/entrypoint.sh"]
