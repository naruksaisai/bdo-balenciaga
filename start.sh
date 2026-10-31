#!/bin/bash
echo "Starting BDO Raid Helper..."

if [ ! -f ".env" ]; then
  echo "ERROR: .env file not found."
  echo "Please copy .env.example to .env and fill in your values."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies for the first time..."
  npm install || { echo "ERROR: npm install failed. Make sure Node.js is installed."; exit 1; }
fi

while true; do
  node src/main.js
  echo "Bot stopped. Restarting in 5 seconds... (Press Ctrl+C to quit)"
  sleep 5
done
