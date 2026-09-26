/* Ask the Board: frontend for the gridiron-ask Flask backend on Render.
 *
 * The page never talks to Claude directly. It sends the question to the
 * backend, which holds the API key, and renders the JSON that comes back.
 *
 * Testing locally: run the backend (python app.py) and open
 *   http://localhost:8000/ask.html?api=http://127.0.0.1:5000
 * The ?api= override means the deployed URL below never has to be edited
 * and then remembered to be put back.
 */
(function () {
  "use strict";

  const DEFAULT_API = "https://gridiron-ask.onrender.com";
  const API = (new URLSearchParams(location.search).get("api") || DEFAULT_API).replace(/\/+$/, "");
  const WAKE_TIMEOUT_MS = 75000;   // Render's free tier can take ~50 s to wake
  const ASK_TIMEOUT_MS = 75000;
  const MAX_QUESTION = 300;

  const EXAMPLES = {
    nfl: ["Who wins the Super Bowl?", "Josh Allen MVP odds", "Chiefs vs Dolphins total points"],
    ncaaf: ["Who wins the national championship?", "Texas vs Tennessee spread"],
    mlb: ["Who will win the World Series?", "Yankees vs Red Sox series"],
    nba: ["Who wins the NBA Finals?", "Eastern Conference favourite"],
    nhl: ["Stanley Cup favourite", "Who wins the Western Conference?"],
    wnba: ["Who wins the WNBA title?", "Finals MVP odds"],
    atp: ["Who is favoured this week?"],
    wta: ["Who is favoured this week?"],
  };

  const $ = (id) => document.getElementById(id);
  const form = $("askForm"), input = $("question"), sport = $("sport"),
        btn = $("askBtn"), result = $("result"), formError = $("formError"),
        statusText = $("statusText"), statusDot = document.querySelector("#status .dot");

  /* fetch with a timeout, and one error type the UI knows how to explain. */
  async function call(path, options, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(API + path, { ...options, signal: ctrl.signal });
    } catch (err) {
      throw new Error(err.name === "AbortError"
        ? "The server took too long to respond. It may still be waking up, so try again in a moment."
        : "Could not reach the server. It may be down, or your connection may be offline.");
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try { body = await res.json(); } catch (_) { /* non-JSON error page */ }
    if (!res.ok) {
      throw new Error((body && body.error) || `The server returned an error (HTTP ${res.status}).`);
    }
    if (!body) throw new Error("The server sent a response this page could not read.");
    return body;
  }

  function setStatus(text, ok) {
    statusText.textContent = text;
    statusDot.classList.toggle("stale", !ok);
  }

  /* Ping /health on load so the free-tier server starts waking while the
     user is still typing, then fill the sport list from /sports. */
  async function wake() {
    const slow = setTimeout(() => setStatus("Waking the server (free tier, up to a minute)…", false), 2500);
    try {
      const h = await call("/health", {}, WAKE_TIMEOUT_MS);
      setStatus(h.ai ? "Server ready" : "Server ready · AI summary off", true);
    } catch (err) {
      setStatus("Server unreachable", false);
    } finally {
      clearTimeout(slow);
    }
    try {
      const data = await call("/sports", {}, 20000);
      const current = sport.value;
      sport.innerHTML = "";
      for (const s of data.sports) {
        const opt = document.createElement("option");
        opt.value = s.key;
        opt.textContent = s.label;
        sport.appendChild(opt);
      }
      sport.value = data.sports.some((s) => s.key === current) ? current : data.sports[0].key;
    } catch (_) { /* keep the built-in list */ }
    renderChips();
  }

  function renderChips() {
    const chips = $("chips");
    chips.innerHTML = "";
    for (const q of EXAMPLES[sport.value] || []) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.textContent = q;
      b.addEventListener("click", () => { input.value = q; form.requestSubmit(); });
      chips.appendChild(b);
    }
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;   // textContent: never inject HTML
    return node;
  }

  function cents(v) { return v == null ? "–" : v + "¢"; }

  function renderAnswer(data) {
    result.innerHTML = "";

    const card = el("div", "answer-card");
    card.appendChild(el("h2", null, "Answer"));
    if (data.warning) card.appendChild(el("p", "notice warn", data.warning));
    if (data.answer) card.appendChild(el("p", "answer", data.answer));
    else if (!data.warning) card.appendChild(el("p", "answer", "No answer came back, but the markets are below."));
    const when = data.snapshotAt ? new Date(data.snapshotAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "?";
    card.appendChild(el("p", "meta",
      (data.live ? "Prices re-fetched live from Kalshi just now." : `Live prices unavailable; using the board snapshot from ${when}.`) +
      (data.model ? ` Answer by ${data.model}.` : "")));
    result.appendChild(card);

    if (!data.markets || !data.markets.length) return;
    const mk = el("div", "markets-card");
    mk.appendChild(el("h2", null, `Markets used (${data.markets.length})`));
    const wrap = el("div", "table-scroll");
    const table = el("table", "mk-table");
    const head = table.createTHead().insertRow();
    [["Market", ""], ["Bid", "num hide-sm"], ["Ask", "num hide-sm"], ["Implied", "num"], ["Volume", "num hide-sm"]]
      .forEach(([t, c]) => head.appendChild(el("th", c, t)));
    const tbody = table.createTBody();
    for (const m of data.markets) {
      const row = tbody.insertRow();
      const name = row.insertCell();
      name.appendChild(el("div", null, `${m.type ? m.type + ": " : ""}${m.label}`));
      name.appendChild(el("div", "mk-group", m.group + (m.date ? " · " + m.date : "")));
      row.appendChild(el("td", "num hide-sm", cents(m.bid)));
      row.appendChild(el("td", "num hide-sm", cents(m.ask)));
      const implied = m.last != null ? m.last : m.ask;
      const td = el("td", "num");
      td.appendChild(el("span", "pct", implied == null ? "–" : implied + "%"));
      row.appendChild(td);
      row.appendChild(el("td", "num hide-sm", (m.volume || 0).toLocaleString()));
    }
    wrap.appendChild(table);
    mk.appendChild(wrap);
    result.appendChild(mk);
  }

  function showFormError(msg) {
    formError.textContent = msg;
    formError.hidden = !msg;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const question = input.value.trim();
    showFormError("");
    if (!question) { showFormError("Please type a question first."); input.focus(); return; }
    if (question.length > MAX_QUESTION) { showFormError(`Keep questions under ${MAX_QUESTION} characters.`); return; }

    btn.disabled = true;
    btn.textContent = "Asking…";
    result.innerHTML = "";
    const thinking = el("div", "answer-card thinking");
    thinking.appendChild(el("span", "spinner"));
    const thinkingText = el("span", null, "Finding markets and asking Claude…");
    thinking.appendChild(thinkingText);
    result.appendChild(thinking);
    const slow = setTimeout(() => { thinkingText.textContent = "Still working. The server may be waking up, which can take up to a minute…"; }, 8000);

    try {
      const data = await call("/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, sport: sport.value }),
      }, ASK_TIMEOUT_MS);
      renderAnswer(data);
      setStatus(data.answer ? "Server ready" : "Server ready · AI summary off", true);
    } catch (err) {
      result.innerHTML = "";
      const card = el("div", "answer-card");
      card.appendChild(el("p", "notice error", err.message));
      result.appendChild(card);
    } finally {
      clearTimeout(slow);
      btn.disabled = false;
      btn.textContent = "Ask";
    }
  });

  sport.addEventListener("change", renderChips);
  renderChips();
  wake();
})();
