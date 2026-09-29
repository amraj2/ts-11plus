"""Tiny Spark - 11+ Examinator web application."""

import hashlib
import json
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, url_for
from flask_compress import Compress

BASE_DIR = Path(__file__).resolve().parent

# Everything the pages need is same-origin: no third-party scripts, fonts, analytics or trackers.
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    "connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'"
)


def _digest(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()[:10]


def create_app():
    app = Flask(__name__)
    app.config["COMPRESS_MIMETYPES"] = ["text/html", "text/css", "text/javascript", "application/javascript", "application/json", "application/manifest+json", "image/svg+xml"]
    Compress(app)

    raw = (BASE_DIR / "data" / "questions.json").read_bytes()
    question_bank = json.loads(raw)
    bank_js = ("window.QUESTION_BANK=" + json.dumps(question_bank, ensure_ascii=False, separators=(",", ":")) + ";").encode("utf-8")
    bank_version = _digest(bank_js)

    static_versions = {}

    def static_v(filename):
        """URL for a static file with a content hash, so browsers can cache it for a long time safely."""
        if filename not in static_versions:
            static_versions[filename] = _digest((BASE_DIR / "static" / filename).read_bytes())
        return url_for("static", filename=filename, v=static_versions[filename])

    @app.context_processor
    def inject():
        return {"static_v": static_v, "bank_version": bank_version}

    @app.after_request
    def secure(resp):
        resp.headers.setdefault("Content-Security-Policy", CSP)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        resp.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()")
        if resp.mimetype == "text/html":
            resp.headers.setdefault("Cache-Control", "no-cache")
        return resp

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/stumble")
    def stumble():
        return render_template("stumble.html")

    @app.get("/privacy")
    def privacy():
        return render_template("privacy.html")

    @app.get("/questions.js")
    def questions_js():
        resp = Response(bank_js, mimetype="text/javascript")
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp

    @app.get("/sw.js")
    def service_worker():
        precache = [
            url_for("index"), url_for("stumble"), url_for("privacy"), url_for("questions_js", v=bank_version),
            static_v("style.css"), static_v("practice.js"), static_v("stumble.css"), static_v("stumble.js"),
            url_for("manifest"), url_for("static", filename="icons/icon-192.png"),
        ]
        cache_name = "spark-" + _digest((bank_version + "".join(precache)).encode())
        body = render_template("sw.js", cache_name=cache_name, precache=json.dumps(precache))
        resp = Response(body, mimetype="text/javascript")
        resp.headers["Cache-Control"] = "no-cache"
        resp.headers["Service-Worker-Allowed"] = "/"
        return resp

    @app.get("/manifest.webmanifest")
    def manifest():
        data = {
            "name": "Tiny Spark 11+ Examinator", "short_name": "Tiny Spark", "start_url": "/stumble", "scope": "/",
            "display": "standalone", "orientation": "any", "background_color": "#5b2bd6", "theme_color": "#5b2bd6",
            "description": "Short, friendly 11+ practice in English, maths, verbal and non-verbal reasoning, plus the Spark Stumble race game.",
            "icons": [
                {"src": url_for("static", filename="icons/icon-192.png"), "sizes": "192x192", "type": "image/png", "purpose": "any"},
                {"src": url_for("static", filename="icons/icon-512.png"), "sizes": "512x512", "type": "image/png", "purpose": "any"},
                {"src": url_for("static", filename="icons/maskable-512.png"), "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
            ],
        }
        resp = Response(json.dumps(data), mimetype="application/manifest+json")
        resp.headers["Cache-Control"] = "public, max-age=3600"
        return resp

    @app.get("/healthz")
    def healthz():
        return jsonify(status="ok", questions={k: len(v["questions"]) for k, v in question_bank.items()}, version=bank_version)

    return app


app = create_app()


if __name__ == "__main__":
    app.run(debug=True)
