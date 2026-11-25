"""Servidor local dos arquivos do frontend sem expor a pasta privada da API."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit


class FrontendHandler(SimpleHTTPRequestHandler):
    def _is_private_path(self):
        parts = PurePosixPath(unquote(urlsplit(self.path).path)).parts
        return any(part == "api" or part.startswith(".env") for part in parts)

    def do_GET(self):
        if self._is_private_path():
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if self._is_private_path():
            self.send_error(404)
            return
        super().do_HEAD()


if __name__ == "__main__":
    address = ("0.0.0.0", 5500)
    print(f"Frontend disponível na rede local na porta {address[1]}.")
    print(f"Neste computador: http://localhost:{address[1]}/login.html")
    print("No celular, use http://IP-DESTE-COMPUTADOR:5500/login.html")
    ThreadingHTTPServer(address, FrontendHandler).serve_forever()
