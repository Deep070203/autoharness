#!/bin/bash
# Start Xvfb virtual display and lightweight window manager
# Resolution: 1280x1024, 24-bit color
Xvfb :99 -screen 0 1280x1024x24 &
export DISPLAY=:99

# Wait for Xvfb to start
for i in {1..10}; do
    if xdpyinfo -display :99 >/dev/null 2>&1; then
        echo "[Desktop] Xvfb started successfully."
        break
    fi
    sleep 0.5
done

# Start Fluxbox window manager (background)
fluxbox &
sleep 1

echo "[Desktop] Virtual desktop ready on :99"
