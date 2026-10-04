# Adds the command-line tools Dots use to edit code and run projects to the
# pinned OpenBot computer image. Build computer-image before this one.
ARG BASE_IMAGE=opendots-computer:b6932d3
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ripgrep jq less nano \
      python3 python3-pip python3-venv build-essential \
  && rm -rf /var/lib/apt/lists/*
RUN git config --system init.defaultBranch main \
  && git config --system --add safe.directory '*'
