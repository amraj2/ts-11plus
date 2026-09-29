"""Smoke tests for the web app: routes, caching, security headers, PWA files."""

import json
import re

import pytest

from app import create_app


@pytest.fixture(scope="module")
def client():
    return create_app().test_client()


@pytest.mark.parametrize("path", ["/", "/stumble", "/privacy"])
def test_pages_render(client, path):
    r = client.get(path)
    assert r.status_code == 200
    assert "text/html" in r.content_type
    assert b"QUESTION_BANK" not in r.data          # the bank is served separately, not inlined


def test_health(client):
    body = client.get("/healthz").get_json()
    assert body["status"] == "ok"
    assert sum(body["questions"].values()) > 1500


def test_question_bank_is_cacheable_javascript(client):
    r = client.get("/questions.js")
    assert r.status_code == 200
    assert "immutable" in r.headers["Cache-Control"]
    assert r.data.startswith(b"window.QUESTION_BANK=")
    data = json.loads(r.data[len(b"window.QUESTION_BANK="):-1])
    assert set(data) == {"Maths", "English", "Verbal reasoning", "Non-verbal reasoning"}


def test_pages_reference_versioned_assets(client):
    html = client.get("/stumble").get_data(as_text=True)
    for asset in re.findall(r'(?:src|href)="(/static/[^"]+\.(?:js|css)\?v=[0-9a-f]{10})"', html):
        assert client.get(asset).status_code == 200
    assert "/questions.js?v=" in html


def test_security_headers(client):
    r = client.get("/")
    assert "script-src 'self'" in r.headers["Content-Security-Policy"]
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["Referrer-Policy"] == "no-referrer"


def test_no_third_party_requests_in_pages(client):
    for path in ("/", "/stumble", "/privacy"):
        html = client.get(path).get_data(as_text=True)
        assert not re.findall(r'(?:src|href)="https?://', html), path


def test_manifest_and_icons(client):
    m = client.get("/manifest.webmanifest").get_json()
    assert m["display"] == "standalone"
    for icon in m["icons"]:
        assert client.get(icon["src"]).status_code == 200


def test_service_worker(client):
    r = client.get("/sw.js")
    assert r.status_code == 200
    assert r.headers["Service-Worker-Allowed"] == "/"
    body = r.get_data(as_text=True)
    assert 'const CACHE = "spark-' in body
    for path in json.loads(re.search(r"const PRECACHE = (\[.*\]);", body).group(1)):
        assert client.get(path).status_code == 200, path


def test_unknown_route_is_404(client):
    assert client.get("/nope").status_code == 404
