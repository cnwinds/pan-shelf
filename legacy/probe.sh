#!/bin/bash
# 每小时探测 2468c.com，解封后自动跑 ps5watch 完整管线（crawl+transfer+normalize）
D=/c/Users/lvan/tools/ps5watch/state
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
CJ=$D/site_cookies.txt
n=0
for round in $(seq 1 48); do
  curl -s --max-time 30 -A "$UA" -b "$CJ" -c "$CJ" -L "https://2468c.com/" -o "$D/probe.html"
  n=$(wc -c < "$D/probe.html" 2>/dev/null || echo 0)
  echo "round=$round size=$n $(date +%H:%M:%S)"
  if [ "$n" -gt 5000 ]; then echo "UNBLOCKED"; break; fi
  sleep 3600
done
if [ "$n" -gt 5000 ]; then
  cd /c/Users/lvan/tools/ps5watch && node ps5watch.mjs run
else
  echo "STILL_BLOCKED_AFTER_48H"
fi
