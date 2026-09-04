#!/usr/bin/env bash
set -o errexit

# 1. Install dependencies
npm install

# 2. Define the persistent cache directory
PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
mkdir -p $PUPPETEER_CACHE_DIR

# 3. Download Chrome
npx puppeteer browsers install chrome

# 4. Move Chrome to the persistent cache
if [[ ! -d $PUPPETEER_CACHE_DIR ]]; then 
  cp -R /opt/render/project/src/.cache/puppeteer/chrome/ $PUPPETEER_CACHE_DIR
else 
  cp -R $PUPPETEER_CACHE_DIR /opt/render/project/src/.cache/puppeteer/chrome/
fi
