#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "→ Killing any running instances..."
pkill -f "Electron" 2>/dev/null || true
pkill -f "electron-vite" 2>/dev/null || true
sleep 1

echo "→ Cleaning old build artifacts..."
rm -rf dist-electron

echo "→ Installing deps (including electron-rebuild)..."
npm install --legacy-peer-deps

echo "→ Rebuilding node-pty for Electron..."
npx electron-rebuild -f -w node-pty

echo "→ Starting dev server..."
bun run dev
