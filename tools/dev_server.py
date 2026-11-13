"""
开发用测试服务器：
  GET  /任意路径      → 从指定目录返回静态文件（方便页面用 fetch 读本地大文件）
  POST /result        → 把请求体追加写入结果文件

用途：无头浏览器里跑探针页面，把结果发回来。
"""
import http.server
import pathlib
import socketserver
import sys
import threading


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        with open(RESULT, "ab") as fh:
            fh.write(body + b"\n")
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    PORT = int(sys.argv[1])
    ROOT = sys.argv[2]
    RESULT = sys.argv[3]
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), Handler)
    timer = threading.Timer(60.0, httpd.shutdown)
    timer.daemon = True
    timer.start()
    httpd.serve_forever()
