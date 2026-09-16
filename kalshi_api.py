"""
Minimal client for the Kalshi public market-data API.

Only the *public* endpoints are used (series / events / markets). These require
no API key and no authentication, which is why nothing secret ever lands in
this repo. Standard library only -- urllib + json -- so there is nothing to pip
install.

Docs: https://trading-api.readme.io/reference/getting-started
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"
USER_AGENT = "kalshi-nfl-board/1.0 (CMU 15-113 coursework)"


class KalshiError(Exception):
    """Raised when the API is reachable but refuses or mangles a request."""


class KalshiUnavailable(KalshiError):
    """Raised when we cannot reach the API at all (offline, DNS, timeout)."""


def _request(path, params=None, timeout=20, retries=3):
    """GET one endpoint and decode the JSON body.

    Retries transient failures (429 rate limit, 5xx) with exponential backoff.
    Distinguishes 'network is gone' from 'server said no' so that callers can
    fall back to a cached snapshot in the first case and skip the series in the
    second.
    """
    url = f"{BASE_URL}{path}"
    if params:
        # Drop None values so callers can pass optional params unconditionally.
        clean = {k: v for k, v in params.items() if v is not None}
        url = f"{url}?{urllib.parse.urlencode(clean)}"

    last_error = None
    for attempt in range(retries):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))

        except urllib.error.HTTPError as exc:
            # 429 = rate limited, 5xx = Kalshi's problem. Both are worth a retry.
            if exc.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(2 ** attempt)
                last_error = exc
                continue
            raise KalshiError(f"HTTP {exc.code} for {url}") from exc

        except urllib.error.URLError as exc:
            # No route to host / DNS failure / connection refused -> offline.
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                last_error = exc
                continue
            raise KalshiUnavailable(f"Cannot reach Kalshi: {exc.reason}") from exc

        except json.JSONDecodeError as exc:
            raise KalshiError(f"Malformed JSON from {url}") from exc

        except TimeoutError as exc:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                last_error = exc
                continue
            raise KalshiUnavailable(f"Timed out talking to Kalshi: {url}") from exc

    raise KalshiUnavailable(f"Gave up on {url}: {last_error}")


def _paginate(path, params, collection_key, page_limit=200, max_pages=50):
    """Follow Kalshi's opaque `cursor` pagination until the results run out.

    Kalshi returns a `cursor` string alongside each page; an empty/missing
    cursor means 'that was the last page'. max_pages is a safety valve so a
    server-side bug can never spin this into an infinite request loop.
    """
    params = dict(params or {})
    params["limit"] = page_limit
    cursor = None
    out = []

    for _ in range(max_pages):
        if cursor:
            params["cursor"] = cursor
        payload = _request(path, params)
        page = payload.get(collection_key) or []
        out.extend(page)

        cursor = payload.get("cursor")
        if not cursor or not page:
            break
        time.sleep(0.1)  # be a polite API citizen

    return out


def list_series(category="Sports"):
    """All series (market families) in a category, e.g. 'Pro Football Spread'."""
    return _request("/series", {"category": category}).get("series", [])


def list_open_events(series_ticker, with_markets=True):
    """Every open event in one series, with its markets (and prices) inlined.

    `with_nested_markets=true` is the key parameter: it returns each event's
    child markets -- including live bid/ask -- in the same response, turning
    what would be hundreds of requests into one per series.
    """
    return _paginate(
        "/events",
        {
            "series_ticker": series_ticker,
            "status": "open",
            "with_nested_markets": "true" if with_markets else "false",
        },
        "events",
    )
