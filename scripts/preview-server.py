#!/usr/bin/env python3
"""Serve the unbundled web app with the byte ranges required for audio seeking."""
import argparse
import email.utils
import http.server
import os
import re
from functools import partial
from pathlib import Path


class PreviewHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):
        self.byte_range = None
        path = self.translate_path(self.path)
        requested = self.headers.get("Range", "")
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested)
        if not match or not any(match.groups()) or not os.path.isfile(path):
            return super().send_head()

        try:
            source = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None
        info = os.fstat(source.fileno())
        if_range = self.headers.get("If-Range")
        if if_range:
            try:
                modified_since = email.utils.parsedate_to_datetime(if_range).timestamp()
                unchanged = int(info.st_mtime) <= modified_since
            except (TypeError, ValueError, OverflowError):
                unchanged = False
            if not unchanged:
                source.close()
                return super().send_head()

        start_text, end_text = match.groups()
        try:
            if start_text:
                start = int(start_text)
                end = int(end_text) if end_text else info.st_size - 1
            else:
                suffix = int(end_text)
                start = max(0, info.st_size - suffix)
                end = info.st_size - 1 if suffix else -1
        except ValueError:
            source.close()
            return super().send_head()
        if start >= info.st_size or end < start:
            source.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{info.st_size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None

        end = min(end, info.st_size - 1)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{info.st_size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Last-Modified", self.date_time_string(info.st_mtime))
        self.end_headers()
        source.seek(start)
        self.byte_range = (start, end)
        return source

    def copyfile(self, source, outputfile):
        try:
            if self.byte_range is None:
                return super().copyfile(source, outputfile)
            remaining = self.byte_range[1] - self.byte_range[0] + 1
            while remaining:
                data = source.read(min(65536, remaining))
                if not data:
                    break
                outputfile.write(data)
                remaining -= len(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("port", nargs="?", type=int, default=8080)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--directory", default=str(Path(__file__).resolve().parents[1] / "app"))
    args = parser.parse_args()
    handler = partial(PreviewHandler, directory=args.directory)
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as server:
        print(f"Serving ORBIT at http://{args.bind}:{args.port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
