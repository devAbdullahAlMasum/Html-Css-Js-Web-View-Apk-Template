#!/usr/bin/env python3
import argparse
import os
import sys
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description="Wait for a remote build or test. No work runs locally.")
parser.add_argument("server")
parser.add_argument("job", choices=["build", "test"])
args = parser.parse_args()
if urllib.parse.urlparse(args.server).scheme != "https":
    parser.error("The remote server must use HTTPS")
token = os.environ.get("ORBIT_CLOUD_TOKEN")
if not token:
    parser.error("Set ORBIT_CLOUD_TOKEN in the environment")
request = urllib.request.Request(args.server.rstrip("/") + "/" + args.job, headers={"X-Orbit-Token": token})
result = None
with urllib.request.urlopen(request, timeout=2400) as response:
    for raw in response:
        line = raw.decode("utf-8", errors="replace")
        sys.stdout.write(line)
        sys.stdout.flush()
        if line.startswith("ORBIT_JOB_EXIT="):
            result = int(line.split("=", 1)[1].strip())
sys.exit(result if result is not None else 1)
