#!/usr/bin/env python3
import os
import sys
import subprocess
import random
import re
import string
from urllib.parse import urlparse

REPLACEX = re.compile(r"[^-_a-zA-Z0-9]")

TIME_LIMIT = float(
    os.environ.get("TIMEOUT", 300.0)
)  # seconds (5 minutes, per seed-crawl)


def main(argv):
    if len(argv) < 3:
        print(f"usage: {argv[0]} SCRIPT URL1 [URL2 [...]]")
        exit(2)

    script_name = argv[1]
    for url in argv[2:]:
        cmd_argv = [
            "node",
            script_name,
            url,
        ]
        cmd_options = {
            "cwd": os.path.dirname(__file__),
            "stdout": sys.stdout,
            "stderr": sys.stderr,
            "check": True,
            "timeout": TIME_LIMIT,
        }
        try:
            subprocess.run(cmd_argv, **cmd_options)
        except subprocess.TimeoutExpired:
            print("TIMEOUT", flush=True, file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv)
