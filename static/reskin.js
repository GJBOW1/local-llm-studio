/* Local LLM Studio — reskin wiring (glass UI -> real backend).
   Drives the new /v2 structure with live data: health, curated model picker +
   auto-download, sessions sidebar, and real /api/chat streaming. The pure-UI
   interactions (theme/accent/panels/tabs/settings) live in the inline script. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var MODEL_COLORS = ["#9bb5e8", "#e25ad0", "#b9e84a", "#4dd6e6", "#ff8a6b", "#b69ef0", "#67d68a", "#f0c674"];
  function colorFor(name) { var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; return MODEL_COLORS[h % MODEL_COLORS.length]; }

  var state = { model: "", models: [], cloud: {}, convos: [], activeId: null, messages: [], streaming: false, controller: null };
  var LS_MODEL = "lls.model.v2", LS_CONVOS = "lls.conversations";

  // ---------- markdown (minimal, safe) ----------
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function renderMd(text) {
    var out = "", parts = text.split(/```/);
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var seg = parts[i], nl = seg.indexOf("\n"), lang = nl > 0 ? seg.slice(0, nl).trim() : "", body = nl >= 0 ? seg.slice(nl + 1) : seg;
        out += '<div class="codeblock"><div class="cbar"><span class="clang">' + esc(lang || "code") + '</span><button class="ccopy">Copy</button></div><pre>' + esc(body.replace(/\n$/, "")) + "</pre></div>";
      } else {
        var t = esc(parts[i]);
        t = t.replace(/`([^`]+)`/g, '<code class="inl">$1</code>').replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        t = t.split(/\n{2,}/).map(function (p) { return p.trim() ? "<p>" + p.replace(/\n/g, "<br>") + "</p>" : ""; }).join("");
        out += t;
      }
    }
    return out;
  }

  // ---------- health ----------
  function loadHealth() {
    fetch("/api/health").then(function (r) { return r.json(); }).then(function (d) {
      var up = d && (d.ok || d.status === "ok" || d.reachable);
      var s = document.querySelector(".topttl .stxt");
      var dot = document.querySelector(".topttl .statusdot");
      if (s) s.textContent = up ? "Ollama connected · 127.0.0.1:5050" : "Ollama offline";
      if (dot) dot.style.background = up ? "var(--green)" : "var(--rose)";
    }).catch(function () {});
  }

  // ---------- models ----------
  function loadModels() {
    return Promise.all([
      fetch("/api/models").then(function (r) { return r.json(); }).catch(function () { return { models: [] }; }),
      fetch("/api/providers").then(function (r) { return r.json(); }).catch(function () { return {}; })
    ]).then(function (res) {
      state.models = (res[0].models || []);
      state.cloud = res[1] || {};
      var saved = localStorage.getItem(LS_MODEL);
      var installed = state.models.filter(function (m) { return m.installed; });
      if (saved && state.models.some(function (m) { return m.name === saved && m.installed; })) state.model = saved;
      else if (installed.length) state.model = installed[0].name;
      else if (state.models.length) state.model = state.models[0].name;
      renderModelMenu(); updateModelBtn();
    });
  }
  function updateModelBtn() {
    var btn = $("modelMenuBtn");
    if (!btn) return;
    btn.querySelector(".mname").textContent = state.model || "select a model";
    btn.querySelector(".dotmod").style.background = colorFor(state.model || "");
  }
  function renderModelMenu() {
    var menu = $("modelMenu"); if (!menu) return;
    menu.innerHTML = "";
    var groups = {};
    state.models.forEach(function (m) { (groups[m.group || "Local"] = groups[m.group || "Local"] || []).push(m); });
    Object.keys(groups).forEach(function (g) {
      menu.appendChild(sec(g));
      groups[g].forEach(function (m) { menu.appendChild(row(m.name, m.installed ? m.size : "⬇ download", m.installed, !m.installed)); });
    });
    var cloudNames = [];
    Object.keys(state.cloud).forEach(function (p) { (state.cloud[p].models || []).forEach(function (id) { cloudNames.push(id); }); });
    if (cloudNames.length) {
      menu.appendChild(sec("Cloud"));
      cloudNames.forEach(function (id) { menu.appendChild(row(id, "", true, false)); });
    }
    function sec(t) { var d = document.createElement("div"); d.className = "mp-sec"; d.textContent = t; return d; }
    function row(name, size, installed, dl) {
      var r = document.createElement("div"); r.className = "mp-row" + (name === state.model ? " cur" : "");
      var dot = document.createElement("span"); dot.className = "mp-dot"; dot.style.background = colorFor(name);
      var n = document.createElement("span"); n.className = "mp-n"; n.textContent = name;
      var sz = document.createElement("span"); sz.className = "mp-sz"; sz.textContent = size; if (dl) sz.style.color = "var(--accent)";
      r.appendChild(dot); r.appendChild(n); r.appendChild(sz);
      if (name === state.model) { var c = document.createElement("span"); c.innerHTML = '<svg class="mp-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m5 13 4 4L19 7"/></svg>'; r.appendChild(c.firstChild); }
      r.addEventListener("click", function () {
        var wrap = $("modelMenuWrap") || document.querySelector(".mp"); if (wrap) { wrap.classList.remove("open"); }
        $("modelMenu").hidden = true;
        if (dl) { startPull(name); return; }
        state.model = name; localStorage.setItem(LS_MODEL, name); updateModelBtn(); renderModelMenu();
      });
      return r;
    }
  }

  // ---------- auto-download ----------
  function startPull(model) {
    var back = $("pullBack"); if (!back) { return; }
    $("pullName").textContent = model;
    $("pullStat").textContent = "starting…";
    $("pullFill").style.width = "0%";
    back.hidden = false;
    fetch("/api/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: model }) })
      .then(function (res) {
        if (!res.ok || !res.body) { $("pullStat").textContent = "download failed"; return; }
        var reader = res.body.getReader(), dec = new TextDecoder(), buf = "", done = false;
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { finish(); return; }
            buf += dec.decode(r.value, { stream: true });
            var lines = buf.split("\n"); buf = lines.pop();
            lines.forEach(function (line) {
              if (!line.trim()) return; var o; try { o = JSON.parse(line); } catch (e) { return; }
              if (o.error) { $("pullStat").textContent = o.error; return; }
              var st = o.status || "downloading";
              if (o.total && o.completed != null) { var pct = o.completed / o.total * 100; $("pullFill").style.width = pct + "%"; $("pullStat").textContent = st + " · " + (o.completed / 1e9).toFixed(1) + " / " + (o.total / 1e9).toFixed(1) + " GB"; }
              else $("pullStat").textContent = st + "…";
              if (st === "success") done = true;
            });
            return pump();
          });
        }
        function finish() {
          if (done) { $("pullStat").textContent = "✓ ready"; $("pullFill").style.width = "100%"; loadModels().then(function () { state.model = model; localStorage.setItem(LS_MODEL, model); updateModelBtn(); renderModelMenu(); }); setTimeout(function () { back.hidden = true; }, 1400); }
        }
        return pump();
      }).catch(function () { $("pullStat").textContent = "download failed"; });
  }

  // ---------- sessions sidebar ----------
  function loadConvos() { try { var a = JSON.parse(localStorage.getItem(LS_CONVOS) || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function saveConvos(l) { try { localStorage.setItem(LS_CONVOS, JSON.stringify(l)); } catch (e) {} }
  function relTime(ts) { var d = (Date.now() - ts) / 1000; if (d < 3600) return Math.max(1, Math.round(d / 60)) + "m ago"; if (d < 86400) return Math.round(d / 3600) + "h ago"; return Math.round(d / 86400) + "d ago"; }
  function dayBucket(ts) { var d = (Date.now() - ts) / 86400000; if (d < 1) return "Today"; if (d < 2) return "Yesterday"; if (d < 7) return "Previous 7 days"; return "Older"; }
  function renderConvos() {
    var list = $("convoList"); if (!list) return;
    var all = state.convos.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    var q = ($("convoSearch") && $("convoSearch").value || "").toLowerCase();
    if (q) all = all.filter(function (c) { return (c.title || "").toLowerCase().indexOf(q) >= 0; });
    list.innerHTML = "";
    var lastBucket = "";
    all.forEach(function (c) {
      var b = dayBucket(c.updatedAt);
      if (b !== lastBucket) { lastBucket = b; var dg = document.createElement("div"); dg.className = "daygroup"; dg.textContent = b; list.appendChild(dg); }
      var row = document.createElement("div"); row.className = "convo" + (c.id === state.activeId ? " on" : "");
      row.innerHTML = '<span class="ci"></span><div class="cmain"><div class="ctitle"></div></div><button class="cdel" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12"/></svg></button>';
      row.querySelector(".ctitle").textContent = c.title || "New chat";
      row.querySelector(".ci").style.background = colorFor(c.model || state.model);
      row.addEventListener("click", function (e) { if (e.target.closest(".cdel")) { e.stopPropagation(); deleteConvo(c.id); return; } openConvo(c.id); });
      list.appendChild(row);
    });
  }
  function deleteConvo(id) { state.convos = state.convos.filter(function (c) { return c.id !== id; }); saveConvos(state.convos); fetch("/api/sessions/" + encodeURIComponent(id), { method: "DELETE" }).catch(function () {}); if (id === state.activeId) newChat(); else renderConvos(); }
  function backfillSessions() {
    return fetch("/api/sessions").then(function (r) { return r.json(); }).then(function (d) {
      var server = d.sessions || []; var byId = {}; state.convos.forEach(function (c) { byId[c.id] = c; });
      server.forEach(function (s) { if (s && s.id && (!byId[s.id] || (s.updatedAt || 0) > (byId[s.id].updatedAt || 0))) byId[s.id] = s; });
      state.convos = Object.keys(byId).map(function (k) { return byId[k]; }); saveConvos(state.convos);
    }).catch(function () {});
  }

  // ---------- chat ----------
  function transcriptEl() { return $("transcript"); }
  function showEmpty(show) {
    var t = transcriptEl(); if (!t) return;
    if (show) {
      t.innerHTML = '<div class="empty"><div class="orb"></div><h1>A private mind,<br>on your machine.</h1><p>Every token here is generated locally by Ollama. Nothing leaves this computer.</p></div>';
    }
  }
  function addBubble(role, model) {
    var t = transcriptEl();
    var msg = document.createElement("div"); msg.className = "msg " + (role === "user" ? "user" : "bot");
    var av = document.createElement("div"); av.className = "av " + (role === "user" ? "me" : "bot");
    if (role === "user") av.textContent = "You"; else av.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M9 8h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-6l-4 3v-3H9a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z" fill="#0a1020" transform="scale(.8) translate(2 2)"/></svg>';
    var wrap = document.createElement("div"); wrap.className = "bubble-wrap";
    var bub = document.createElement("div"); bub.className = "bubble";
    if (role !== "user") { var br = document.createElement("div"); br.className = "brole"; br.textContent = (model || state.model).split(":")[0] + " · local"; bub.appendChild(br); }
    var body = document.createElement("div"); body.className = "mbody"; bub.appendChild(body);
    wrap.appendChild(bub); msg.appendChild(av); msg.appendChild(wrap); t.appendChild(msg);
    t.scrollTop = t.scrollHeight;
    return body;
  }
  function persist() {
    if (!state.messages.length) return;
    var c = { id: state.activeId || ("c" + Date.now().toString(36)), title: (state.messages[0].content || "New chat").slice(0, 48), model: state.model, messages: state.messages, updatedAt: Date.now() };
    state.activeId = c.id;
    var i = state.convos.findIndex(function (x) { return x.id === c.id; });
    if (i >= 0) state.convos[i] = c; else state.convos.push(c);
    saveConvos(state.convos); renderConvos();
    fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) }).catch(function () {});
  }
  function openConvo(id) {
    var c = state.convos.find(function (x) { return x.id === id; }); if (!c) return;
    state.activeId = id; state.messages = (c.messages || []).map(function (m) { return { role: m.role, content: m.content }; });
    if (c.model) { state.model = c.model; updateModelBtn(); }
    var t = transcriptEl(); t.innerHTML = "";
    state.messages.forEach(function (m) { var b = addBubble(m.role, c.model); b.innerHTML = renderMd(m.content); });
    var tt = document.querySelector(".topttl .t"); if (tt) tt.textContent = c.title || "Chat";
    renderConvos();
  }
  function newChat() { if (state.streaming && state.controller) state.controller.abort(); state.activeId = null; state.messages = []; showEmpty(true); var tt = document.querySelector(".topttl .t"); if (tt) tt.textContent = "New chat"; renderConvos(); }

  function send() {
    var input = $("input"); var text = (input.value || "").trim(); if (!text || state.streaming) return;
    if (!state.model) { window.showToast && window.showToast("Pick a model first"); return; }
    if (!state.messages.length) transcriptEl().innerHTML = "";
    state.messages.push({ role: "user", content: text });
    addBubble("user").textContent = text;
    input.value = ""; input.style.height = "";
    var body = addBubble("assistant"); body.parentElement.classList.add("cursor");
    var tt = document.querySelector(".topttl .t"); if (tt) tt.textContent = text.slice(0, 48);
    setStreaming(true);
    state.controller = new AbortController();
    var acc = "";
    fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: state.model, messages: state.messages, options: { temperature: parseFloat(($("tempSlider") || {}).value || "0.7") } }), signal: state.controller.signal })
      .then(function (res) {
        var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { finishStream(); return; }
            buf += dec.decode(r.value, { stream: true });
            var lines = buf.split("\n"); buf = lines.pop();
            lines.forEach(function (line) {
              if (!line.trim()) return; var o; try { o = JSON.parse(line); } catch (e) { return; }
              if (o.error) { acc += "\n\n_" + o.error + "_"; }
              var msg = o.message || {};
              if (msg.content) { acc += msg.content; body.innerHTML = renderMd(acc); transcriptEl().scrollTop = transcriptEl().scrollHeight; }
            });
            return pump();
          });
        }
        function finishStream() { body.parentElement.classList.remove("cursor"); state.messages.push({ role: "assistant", content: acc }); setStreaming(false); persist(); }
        return pump();
      }).catch(function (e) { body.parentElement.classList.remove("cursor"); if (e.name !== "AbortError") body.innerHTML = renderMd(acc + "\n\n_stream failed_"); setStreaming(false); });
  }
  function setStreaming(on) {
    state.streaming = on;
    var send = $("send");
    if (on) { send.classList.add("stop"); send.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'; }
    else { send.classList.remove("stop"); send.innerHTML = '<svg viewBox="0 0 24 24" fill="#0a1020"><path d="M3.4 20.4 21 12 3.4 3.6 3.39 10.2 15 12l-11.61 1.8z"/></svg>'; }
  }

  // ---------- init ----------
  function init() {
    var inputEl = $("input"), sendBtn = $("send");
    if (sendBtn) sendBtn.addEventListener("click", function () { if (state.streaming && state.controller) { state.controller.abort(); setStreaming(false); } else send(); });
    if (inputEl) {
      inputEl.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
      inputEl.addEventListener("input", function (e) { e.target.style.height = ""; if (e.target.value) e.target.style.height = Math.min(e.target.scrollHeight, 180) + "px"; });
    }
    if ($("newChat")) $("newChat").addEventListener("click", newChat);
    if ($("convoSearch")) $("convoSearch").addEventListener("input", renderConvos);

    state.convos = loadConvos();
    loadHealth(); setInterval(loadHealth, 8000);
    loadModels();
    backfillSessions().then(function () {
      renderConvos();
      var recent = state.convos.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; })[0];
      if (recent) openConvo(recent.id); else showEmpty(true);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
