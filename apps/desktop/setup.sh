#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "Installing the locked npm dependency graph..."
npm ci

echo "Rebuilding native modules for Electron..."
npm run rebuild

echo "Starting CodeSurf..."
exec npm run dev
