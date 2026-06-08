/* Local LLM Studio — reskin wiring (glass UI -> real backend).
   Drives the new /v2 structure with live data: health, curated model picker +
   auto-download, sessions sidebar, and real /api/chat streaming. The pure-UI
   interactions (theme/accent/panels/tabs/settings) live in the inline script. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var MODEL_COLORS = ["#9bb5e8", "#e25ad0", "#b9e84a", "#4dd6e6", "#ff8a6b", "#b69ef0", "#67d68a", "#f0c674"];
  var PROV_META = {
    anthropic: { name: "Anthropic", sub: "Claude", logo: "C", color: "#d97757", ph: "sk-ant-…" },
    openai: { name: "OpenAI", sub: "GPT", logo: "◎", color: "#10a37f", ph: "sk-…" },
    gemini: { name: "Google", sub: "Gemini", logo: "G", color: "#4285f4", ph: "AIza…" },
    grok: { name: "xAI", sub: "Grok", logo: "x", color: "#0b0b0b", ph: "xai-…" }
  };
  function colorFor(name) { var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; return MODEL_COLORS[h % MODEL_COLORS.length]; }

  var state = { model: "", models: [], cloud: {}, convos: [], activeId: null, messages: [], streaming: false, controller: null };
  var LS_MODEL = "lls.model.v2", LS_CONVOS = "lls.conversations";

  // ---------- markdown (minimal, safe) ----------
  var ARTIFACT_TYPES = { mermaid: 1, chart: 1, svg: 1, html: 1, embed: 1 };
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function renderMd(text) {
    var out = "", parts = text.split(/```/);
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var seg = parts[i], nl = seg.indexOf("\n"), lang = (nl >= 0 ? seg.slice(0, nl).trim() : "").toLowerCase(), body = (nl >= 0 ? seg.slice(nl + 1) : seg).replace(/\n$/, "");
        if (ARTIFACT_TYPES[lang]) {
          // A fenced diagram/chart/svg/html block. Emit an unrendered artifact holder;
          // renderArtifacts() builds the live view once the message is complete.
          out += '<div class="artifact" data-type="' + lang + '" data-rendered="0"><pre class="artifact-src">' + esc(body) + '</pre></div>';
        } else {
          out += '<div class="codeblock"><div class="cbar"><span class="clang">' + esc(lang || "code") + '</span><button class="ccopy">Copy</button></div><pre>' + esc(body) + "</pre></div>";
        }
      } else {
        var t = esc(parts[i]);
        t = t.replace(/`([^`]+)`/g, '<code class="inl">$1</code>').replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        t = t.split(/\n{2,}/).map(function (p) { return p.trim() ? "<p>" + p.replace(/\n/g, "<br>") + "</p>" : ""; }).join("");
        out += t;
      }
    }
    return out;
  }

  // ---------- artifacts (mermaid / chart / svg / html / embed) ----------
  var _mermaidInit = false;
  function buildArtifactView(type, source) {
    var view = document.createElement("div"); view.className = "artifact-view";
    if (type === "mermaid") {
      if (typeof window.mermaid === "undefined") { view.textContent = source; return Promise.resolve(view); }
      if (!_mermaidInit) { try { window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" }); } catch (e) {} _mermaidInit = true; }
      state._artSeq = (state._artSeq || 0) + 1;
      var id = "mmd-" + state._artSeq;
      return window.mermaid.render(id, source).then(function (out) { view.innerHTML = out.svg; return view; }).catch(function (err) { view.className = "artifact-view artifact-error"; view.textContent = "Diagram error: " + (err && err.message ? err.message : String(err)); return view; });
    }
    if (type === "chart") {
      var config;
      try { config = JSON.parse(source); } catch (e) { view.className = "artifact-view artifact-error"; view.textContent = "Chart config isn't valid JSON: " + e.message; return Promise.resolve(view); }
      if (typeof window.Chart === "undefined") { view.textContent = source; return Promise.resolve(view); }
      config.options = Object.assign({ responsive: true, maintainAspectRatio: false }, config.options || {});
      var wrap = document.createElement("div"); wrap.className = "chart-wrap"; var canvas = document.createElement("canvas"); wrap.appendChild(canvas); view.appendChild(wrap);
      requestAnimationFrame(function () { try { new window.Chart(canvas.getContext("2d"), config); } catch (err) { view.className = "artifact-view artifact-error"; view.textContent = "Chart error: " + err.message; } });
      return Promise.resolve(view);
    }
    if (type === "embed") {
      var src = source.trim().split("\n")[0].trim();
      var isPath = !/^https?:\/\//i.test(src) && src.charAt(0) !== "/";
      var url = isPath ? "/local?path=" + encodeURIComponent(src) : src;
      var low = src.toLowerCase().split("?")[0], node;
      if (/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/.test(low)) { node = document.createElement("img"); node.className = "embed-media"; node.src = url; node.alt = src; }
      else if (/\.(mp4|webm|ogg|mov|m4v)$/.test(low)) { node = document.createElement("video"); node.className = "embed-media"; node.controls = true; node.src = url; }
      else if (/\.(mp3|wav|m4a|aac|oga|opus|flac)$/.test(low)) { node = document.createElement("audio"); node.className = "embed-media"; node.controls = true; node.src = url; }
      else { node = document.createElement("iframe"); node.className = "artifact-frame"; node.src = url; node.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms"); }
      view.appendChild(node); return Promise.resolve(view);
    }
    var frame = document.createElement("iframe"); frame.className = "artifact-frame";
    if (type === "svg") { frame.setAttribute("sandbox", ""); frame.srcdoc = '<!doctype html><meta charset="utf-8"><body style="margin:0;display:flex;justify-content:center;align-items:flex-start;background:#fff">' + source + "</body>"; }
    else { frame.setAttribute("sandbox", "allow-scripts"); frame.srcdoc = source; }
    view.appendChild(frame); return Promise.resolve(view);
  }
  function renderArtifacts(container) {
    if (!container) return;
    container.querySelectorAll('.artifact[data-rendered="0"]').forEach(function (block) {
      block.dataset.rendered = "1";
      var type = block.dataset.type, srcEl = block.querySelector(".artifact-src"), source = srcEl ? srcEl.textContent : "";
      if (!source.trim()) return;
      var bar = document.createElement("div"); bar.className = "artifact-bar";
      bar.innerHTML = '<span class="art-type">' + esc(type) + '</span><button class="art-toggle" type="button">&lt;/&gt; source</button>';
      Promise.resolve(buildArtifactView(type, source)).then(function (viewEl) {
        block.insertBefore(viewEl, srcEl); block.insertBefore(bar, viewEl);
        srcEl.classList.add("artifact-src-hidden");
        bar.querySelector(".art-toggle").addEventListener("click", function () { srcEl.classList.toggle("artifact-src-hidden"); });
      });
    });
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
      state.modelProvider = {};
      Object.keys(state.cloud).forEach(function (p) { (state.cloud[p].models || []).forEach(function (id) { state.modelProvider[id] = p; }); });
      var saved = localStorage.getItem(LS_MODEL);
      var installed = state.models.filter(function (m) { return m.installed; });
      if (saved && state.models.some(function (m) { return m.name === saved && m.installed; })) state.model = saved;
      else if (installed.length) state.model = installed[0].name;
      else if (state.models.length) state.model = state.models[0].name;
      renderModelMenu(); updateModelBtn(); renderCloud(); renderArenaPicker();
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

  // ---------- cloud providers (settings) ----------
  function renderCloud() {
    var box = $("cloudProviders"); if (!box) return;
    box.innerHTML = "";
    var order = ["anthropic", "openai", "gemini", "grok"];
    order.forEach(function (p) {
      var info = state.cloud[p]; if (!info && !PROV_META[p]) return;
      var meta = PROV_META[p] || { name: p, sub: "", logo: p[0].toUpperCase(), color: "#666", ph: "API key…" };
      var connected = info && info.connected;
      var card = document.createElement("div"); card.className = "cloudp";
      card.innerHTML =
        '<div class="cloudp-top"><span class="cloudp-lg" style="background:' + meta.color + '">' + meta.logo + '</span>' +
        '<span class="cloudp-name">' + meta.name + '<small>' + meta.sub + '</small></span>' +
        '<span class="cloudp-stat' + (connected ? ' connected' : '') + '">' + (connected ? 'connected' : 'not connected') + '</span></div>' +
        '<div class="cloudp-row"><input type="password" placeholder="' + meta.ph + '"><button class="cloudp-btn">' + (connected ? 'Disconnect' : 'Connect') + '</button></div>';
      var input = card.querySelector("input"), btn = card.querySelector(".cloudp-btn");
      btn.addEventListener("click", function () {
        if (connected) {
          fetch("/api/providers/disconnect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: p }) })
            .then(function () { window.showToast && window.showToast(meta.name + " disconnected"); loadModels(); }).catch(function () {});
        } else {
          var key = (input.value || "").trim(); if (!key) { input.focus(); return; }
          btn.textContent = "…"; btn.disabled = true;
          fetch("/api/providers/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: p, key: key }) })
            .then(function (r) { return r.json(); }).then(function (d) {
              if (d && d.ok) { window.showToast && window.showToast(meta.name + " connected"); loadModels(); }
              else { window.showToast && window.showToast((d && d.error) || "Invalid key"); btn.textContent = "Connect"; btn.disabled = false; }
            }).catch(function () { btn.textContent = "Connect"; btn.disabled = false; });
        }
      });
      box.appendChild(card);
    });
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
      row.innerHTML = '<span class="ci"></span><div class="cmain"><div class="ctitle" title="Double-click to rename"></div></div><button class="cren" title="Rename"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button><button class="cdel" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12"/></svg></button>';
      var titleEl = row.querySelector(".ctitle");
      titleEl.textContent = c.title || "New chat";
      row.querySelector(".ci").style.background = colorFor(c.model || state.model);
      titleEl.addEventListener("dblclick", function (e) { e.stopPropagation(); editTitle(titleEl, c.id); });
      row.querySelector(".cren").addEventListener("click", function (e) { e.stopPropagation(); editTitle(titleEl, c.id); });
      row.addEventListener("click", function (e) { if (e.target.closest(".cdel")) { e.stopPropagation(); deleteConvo(c.id); return; } if (e.target.closest(".cren") || titleEl.isContentEditable) return; openConvo(c.id); });
      list.appendChild(row);
    });
  }
  function deleteConvo(id) { state.convos = state.convos.filter(function (c) { return c.id !== id; }); saveConvos(state.convos); fetch("/api/sessions/" + encodeURIComponent(id), { method: "DELETE" }).catch(function () {}); if (id === state.activeId) newChat(); else renderConvos(); }
  function editTitle(el, id) {
    var orig = el.textContent;
    el.contentEditable = "true"; el.classList.add("editing"); el.focus();
    var r = document.createRange(); r.selectNodeContents(el); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    function done(save) { el.removeEventListener("keydown", onKey); el.removeEventListener("blur", onBlur); el.contentEditable = "false"; el.classList.remove("editing"); if (save) renameConvo(id, el.textContent); else el.textContent = orig; }
    function onKey(e) { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.preventDefault(); done(false); } }
    function onBlur() { done(true); }
    el.addEventListener("keydown", onKey); el.addEventListener("blur", onBlur);
  }
  function renameConvo(id, title) {
    title = (title || "").replace(/\s+/g, " ").trim(); if (!title) { renderConvos(); return; }
    var c = state.convos.find(function (x) { return x.id === id; }); if (!c) return;
    c.title = title; saveConvos(state.convos); renderConvos();
    if (id === state.activeId) { var tt = document.querySelector(".topttl .t"); if (tt) tt.textContent = title; }
    fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) }).catch(function () {});
    window.showToast && window.showToast("Chat renamed");
  }
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
    if (role !== "user") { var mdl = model || state.model; var br = document.createElement("div"); br.className = "brole"; br.textContent = mdl.split(":")[0] + " · " + ((state.modelProvider || {})[mdl] ? "cloud" : "local"); bub.appendChild(br); }
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
    state.messages.forEach(function (m) { var b = addBubble(m.role, c.model); b.innerHTML = renderMd(m.content); if (m.role !== "user") renderArtifacts(b); });
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
    var acc = "", _t0 = Date.now(), _tFirst = 0, _tLast = 0;
    var payload = { model: state.model, messages: state.messages, options: { temperature: parseFloat(($("tempSlider") || {}).value || "0.7") } };
    var prov = (state.modelProvider || {})[state.model];
    if (prov) payload.provider = prov; // route cloud models to their provider, not Ollama
    fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: state.controller.signal })
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
              if (msg.content) { if (!_tFirst) _tFirst = Date.now(); _tLast = Date.now(); acc += msg.content; body.innerHTML = renderMd(acc); transcriptEl().scrollTop = transcriptEl().scrollHeight; if (_tLast > _tFirst) { var _m = $("tps"); if (_m) _m.textContent = Math.round(acc.trim().split(/\s+/).length / ((_tLast - _tFirst) / 1000)) + " w/s"; } }
            });
            return pump();
          });
        }
        function finishStream() { body.parentElement.classList.remove("cursor"); body.innerHTML = renderMd(acc); renderArtifacts(body); state.messages.push({ role: "assistant", content: acc }); setStreaming(false); persist(); recordTps(acc.trim() ? acc.trim().split(/\s+/).length : 0, _tFirst ? Math.max(_tLast - _tFirst, 100) : 0); }
        return pump();
      }).catch(function (e) { body.parentElement.classList.remove("cursor"); if (e.name !== "AbortError") body.innerHTML = renderMd(acc + "\n\n_stream failed_"); setStreaming(false); });
  }
  function setStreaming(on) {
    state.streaming = on;
    var send = $("send");
    if (on) { send.classList.add("stop"); send.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'; }
    else { send.classList.remove("stop"); send.innerHTML = '<svg viewBox="0 0 24 24" fill="#0a1020"><path d="M3.4 20.4 21 12 3.4 3.6 3.39 10.2 15 12l-11.61 1.8z"/></svg>'; }
  }

  // ---------- files / agent panel ----------
  var filesLoaded = false;
  function fileIcon(dir) { return dir ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>'; }
  function loadFiles() {
    var panel = $("filesPanel"); if (!panel) return;
    fetch("/api/project").then(function (r) { return r.json(); }).then(function (p) { var rt = panel.querySelector(".fp-root"); if (rt) rt.textContent = p.name || "project"; }).catch(function () {});
    fetch("/api/fs/tree").then(function (r) { return r.json(); }).then(function (d) {
      var box = panel.querySelector(".ftree-box"); if (!box) return; box.innerHTML = "";
      (d.entries || []).slice(0, 100).forEach(function (e) {
        var depth = e.path.split("/").length - 1;
        var row = document.createElement("div"); row.className = "fnode" + (e.type === "file" ? " file" : "");
        row.style.paddingLeft = (8 + depth * 14) + "px";
        row.innerHTML = '<span class="fn-ic">' + fileIcon(e.type === "dir") + '</span><span class="fn-name"></span>';
        row.querySelector(".fn-name").textContent = e.path.split("/").pop();
        box.appendChild(row);
      });
      if (!(d.entries || []).length) box.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:6px">Empty project. Use the model with agent edits on to create files.</div>';
    }).catch(function () {});
    fetch("/api/agent/writes").then(function (r) { return r.json(); }).then(function (d) { var t = $("tgWrites"); if (t) t.classList.toggle("on", !!d.enabled); }).catch(function () {});
    fetch("/api/agent/approval").then(function (r) { return r.json(); }).then(function (d) { var t = $("tgApprove"); if (t) t.classList.toggle("on", !!d.required); }).catch(function () {});
    loadChanges();
  }
  function loadChanges() {
    var panel = $("filesPanel"); if (!panel) return;
    fetch("/api/fs/changes").then(function (r) { return r.json(); }).then(function (d) {
      var head = panel.querySelector(".changes-head"); if (!head) return;
      panel.querySelectorAll(".diffcard, .changes-empty").forEach(function (x) { x.remove(); });
      var changes = (d.changes || []);
      if (!changes.length) { var e = document.createElement("div"); e.className = "changes-empty"; e.style.cssText = "font-size:12px;color:var(--muted);padding:2px 2px 8px"; e.textContent = "No changes yet."; head.after(e); return; }
      var verb = { create: "＋", update: "✎", mkdir: "📁＋", move: "→", delete: "🗑" };
      var frag = document.createDocumentFragment();
      changes.slice(0, 10).forEach(function (c) {
        var card = document.createElement("div"); card.className = "diffcard" + (c.undone ? " resolved" : ""); card.style.marginBottom = "8px";
        var top = document.createElement("div"); top.className = "diff-top";
        top.innerHTML = '<span class="diff-dot"></span><span style="flex:1;overflow:hidden;text-overflow:ellipsis"></span>';
        top.querySelector("span:last-child").textContent = (verb[c.op] || c.op) + " " + c.path + (c.to ? " → " + c.to : "");
        card.appendChild(top);
        var act = document.createElement("div"); act.className = "diff-act";
        if (c.undone) act.innerHTML = '<span class="diff-jail" style="margin:0">undone</span>';
        else { var b = document.createElement("button"); b.className = "diff-no"; b.textContent = "Undo"; b.addEventListener("click", function () { fetch("/api/fs/undo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: c.id }) }).then(function (r) { return r.json(); }).then(function (x) { window.showToast && window.showToast(x.message || "Undone"); loadFiles(); }); }); act.appendChild(b); }
        card.appendChild(act);
        frag.appendChild(card);
      });
      head.after(frag);
    }).catch(function () {});
  }
  function wireAgentToggle(id, url, key) {
    var t = $(id); if (!t) return;
    t.addEventListener("click", function () {
      var on = t.classList.contains("on"); var body = {}; body[key] = on;
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }).then(function () { window.showToast && window.showToast(on ? "Enabled" : "Disabled"); }).catch(function () {});
    });
  }

  // ---------- Telemetry (real data from /api/ps + measured throughput) ----------
  state.tpsHistory = []; state.lastTps = 0;
  function sparkPath(hist) {
    if (!hist || hist.length < 2) return '<polyline points="0,38 200,38" fill="none" stroke="var(--glass-brd-2)" stroke-width="2"/>';
    var h = hist.slice(-9), max = Math.max.apply(null, h), min = Math.min.apply(null, h);
    var pts = h.map(function (v, i) { var x = h.length > 1 ? i / (h.length - 1) * 200 : 0; var y = 38 - (max > min ? (v - min) / (max - min) : 0.5) * 32; return x.toFixed(0) + "," + y.toFixed(0); }).join(" ");
    return '<polygon points="0,40 ' + pts + ' 200,40" fill="url(#sg)"/><polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="2"/>';
  }
  function renderTelemetry() {
    var body = $("telemetryBody"); if (!body) return;
    fetch("/api/ps").then(function (r) { return r.json(); }).then(function (d) {
      var loaded = d.models || [], tps = state.lastTps || 0;
      var html = '<div class="insp-card"><h5>Throughput</h5>' +
        '<div class="metric-row"><span class="mlabel">Last response</span><span class="mval" style="color:var(--accent);font-size:17px">' + (tps ? tps + " w/s" : "—") + '</span></div>' +
        '<svg class="spark" viewBox="0 0 200 40" preserveAspectRatio="none"><defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>' + sparkPath(state.tpsHistory) + '</svg></div>';
      if (loaded.length) {
        loaded.forEach(function (m) {
          var pct = m.gpu_pct || 0, lit = Math.round(pct / 100 * 14), sq = "";
          for (var i = 0; i < 14; i++) sq += '<span style="width:13px;height:13px;border-radius:4px;background:' + (i < lit ? "var(--accent)" : "var(--glass-brd-2)") + '"></span>';
          html += '<div class="insp-card"><h5 style="text-transform:none;letter-spacing:0;font-family:var(--mono);font-size:12px;color:var(--text)">' + m.name + '</h5>' +
            '<div style="display:flex;gap:4px;margin:6px 0 10px;flex-wrap:wrap">' + sq + '</div>' +
            '<div class="metric-row"><span class="mlabel">GPU offload</span><span class="mval">' + pct + '%</span></div>' +
            '<div class="metric-row"><span class="mlabel">VRAM</span><span class="mval">' + (m.vram_h || "—") + '</span></div>' +
            '<div class="metric-row"><span class="mlabel">Size</span><span class="mval">' + (m.size_h || "—") + '</span></div></div>';
        });
      } else {
        html += '<div class="insp-card"><h5>GPU layer offload</h5><p style="font-size:12px;color:var(--muted);line-height:1.5;margin:2px 0 0">No model is loaded in Ollama right now. Send a message to a local model and its real VRAM &amp; GPU offload appear here.</p></div>';
      }
      body.innerHTML = html;
    }).catch(function () { body.innerHTML = '<div class="insp-card" style="color:var(--muted);font-size:12px">Telemetry unavailable.</div>'; });
  }
  function recordTps(words, ms) {
    if (ms <= 0 || !words) return;
    var v = Math.round(words / (ms / 1000));
    state.lastTps = v; state.tpsHistory.push(v); if (state.tpsHistory.length > 12) state.tpsHistory.shift();
    var meter = $("tps"); if (meter) meter.textContent = v + " w/s";
    renderTelemetry();
  }

  // ---------- Knowledge graph + RAG sources (real data, honest empty-states) ----------
  function renderGraph() {
    var body = $("graphBody"); if (!body) return;
    Promise.all([
      fetch("/api/graph").then(function (r) { return r.json(); }).catch(function () { return { nodes: [], links: [] }; }),
      fetch("/api/secondbrain/health").then(function (r) { return r.json(); }).catch(function () { return {}; })
    ]).then(function (res) {
      var g = res[0] || {}, h = res[1] || {}, nodes = g.nodes || [];
      var health = '<div class="insp-card"><h5>Index health</h5>' +
        '<div class="metric-row"><span class="mlabel">Notes indexed</span><span class="mval">' + (h.notes || 0) + '</span></div>' +
        '<div class="metric-row"><span class="mlabel">Embedding model</span><span class="mval">' + (h.model || "—") + '</span></div>' +
        '<div class="metric-row"><span class="mlabel">Status</span><span class="mval">' + (h.available ? "ready" : "not set up") + '</span></div></div>';
      if (!nodes.length) {
        body.innerHTML = '<div class="insp-card"><h5>Knowledge graph</h5><p style="font-size:12px;color:var(--muted);line-height:1.55;margin:2px 0 0">No second brain yet. Index notes or documents and this map shows how they connect.</p></div>' + health;
        return;
      }
      var N = Math.min(nodes.length, 16), cx = 140, cy = 120, R = 84, pos = {};
      nodes.slice(0, N).forEach(function (n, i) { var a = i / N * 2 * Math.PI; var id = n.id != null ? n.id : (n.name || i); pos[id] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), label: String(n.label || n.name || id).slice(0, 10) }; });
      var lines = "", circles = "";
      (g.links || []).forEach(function (l) { var s = pos[l.source], t = pos[l.target]; if (s && t) lines += '<line x1="' + s.x.toFixed(0) + '" y1="' + s.y.toFixed(0) + '" x2="' + t.x.toFixed(0) + '" y2="' + t.y.toFixed(0) + '"/>'; });
      Object.keys(pos).forEach(function (k) { var p = pos[k]; circles += '<circle cx="' + p.x.toFixed(0) + '" cy="' + p.y.toFixed(0) + '" r="11" fill="var(--base-2)" stroke="var(--accent)" stroke-width="1.3"/><text x="' + p.x.toFixed(0) + '" y="' + (p.y + 22).toFixed(0) + '" text-anchor="middle" font-size="9" fill="var(--text-2)" font-family="Geist">' + p.label + '</text>'; });
      body.innerHTML = '<svg class="kgraph" viewBox="0 0 280 240"><g stroke="var(--accent)" stroke-opacity=".34" stroke-width="1">' + lines + '</g><g>' + circles + '</g></svg>' + health;
    });
  }
  function renderSources() {
    var body = $("sourcesBody"); if (!body) return;
    if (state.lastSources && state.lastSources.length) {
      body.innerHTML = state.lastSources.map(function (s) { return '<div class="src"><div class="sname">' + (s.name || "source") + '<span class="sscore">' + (s.score || "") + '</span></div><div class="ssnip">' + (s.snippet || "") + '</div></div>'; }).join("");
    } else {
      body.innerHTML = '<div class="insp-card"><h5>Retrieved sources</h5><p style="font-size:12px;color:var(--muted);line-height:1.55;margin:2px 0 0">When your second brain is set up and a reply draws on your notes, the source passages it used appear here.</p></div>';
    }
  }

  // ---------- Arena: add models via provider dropdowns; close unloads from Ollama; broadcast races ----------
  state.arena = [];
  function arenaProviderGroups() {
    var groups = [], local = {};
    state.models.forEach(function (m) { (local[m.group || "Local"] = local[m.group || "Local"] || []).push({ name: m.name, provider: "", installed: m.installed, size: m.size }); });
    Object.keys(local).forEach(function (g) { groups.push({ label: g, items: local[g] }); });
    ["anthropic", "openai", "gemini", "grok"].forEach(function (p) {
      var info = state.cloud[p]; if (!info || !(info.models || []).length) return;
      groups.push({ label: (PROV_META[p] || { name: p }).name, items: info.models.map(function (id) { return { name: id, provider: p }; }) });
    });
    return groups;
  }
  function closeArenaPills() { document.querySelectorAll("#arenaPicker .arena-pill.open").forEach(function (p) { p.classList.remove("open"); var m = p.querySelector(".arena-pill-menu"); if (m) m.hidden = true; }); }
  function renderArenaPicker() {
    var box = $("arenaPicker"); if (!box) return;
    box.innerHTML = "";
    arenaProviderGroups().forEach(function (g) {
      var pill = document.createElement("div"); pill.className = "arena-pill";
      var btn = document.createElement("button"); btn.className = "arena-pill-btn";
      btn.innerHTML = '<span class="pdot" style="background:' + colorFor(g.items[0] ? g.items[0].name : g.label) + '"></span>' + g.label + ' <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>';
      var menu = document.createElement("div"); menu.className = "arena-pill-menu"; menu.hidden = true;
      g.items.forEach(function (it) {
        var row = document.createElement("div"); row.className = "mp-row";
        var tail = it.provider ? '<span class="mp-sz">☁</span>' : (it.installed ? "" : '<span class="mp-sz" style="color:var(--accent)">⬇</span>');
        row.innerHTML = '<span class="mp-dot" style="background:' + colorFor(it.name) + '"></span><span class="mp-n">' + it.name + '</span>' + tail;
        row.addEventListener("click", function () { addArenaModel(it.name, it.provider, it.installed); closeArenaPills(); });
        menu.appendChild(row);
      });
      btn.addEventListener("click", function (e) { e.stopPropagation(); var willOpen = !pill.classList.contains("open"); closeArenaPills(); if (willOpen) { pill.classList.add("open"); menu.hidden = false; } });
      pill.appendChild(btn); pill.appendChild(menu); box.appendChild(pill);
    });
  }
  function arenaItem(id) { for (var i = 0; i < state.arena.length; i++) if (state.arena[i].id === id) return state.arena[i]; return null; }
  function arenaCardEl(id) { return document.querySelector('#arenaGrid .arena-card[data-id="' + id + '"]'); }
  function addArenaModel(name, provider, installed) {
    if (!provider && installed === false) startPull(name); // download the local model first
    state._arenaSeq = (state._arenaSeq || 0) + 1;
    state.arena.push({ id: "a" + state._arenaSeq, name: name, provider: provider || "", messages: [], busy: false });
    renderArenaCards();
    window.showToast && window.showToast("Added " + name.split(":")[0] + " to the arena");
  }
  function closeArenaModel(id) {
    var idx = -1; for (var i = 0; i < state.arena.length; i++) if (state.arena[i].id === id) { idx = i; break; }
    if (idx < 0) return;
    var m = state.arena[idx]; state.arena.splice(idx, 1); renderArenaCards();
    if (!m.provider) {
      fetch("/api/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: m.name }) })
        .then(function () { window.showToast && window.showToast(m.name.split(":")[0] + " closed · unloaded from Ollama"); }).catch(function () {});
    } else { window.showToast && window.showToast("Removed " + m.name.split(":")[0]); }
  }
  function renderArenaCards() {
    var grid = $("arenaGrid"); if (!grid) return;
    var n = state.arena.length;
    grid.className = "arena-grid cols-" + Math.min(Math.max(n, 1), 4);
    grid.innerHTML = "";
    if (!n) { grid.innerHTML = '<div class="arena-empty">No models in the arena yet.<br>Add some from the provider menus above, then Broadcast a prompt — or chat each one directly.</div>'; return; }
    state.arena.forEach(function (m) {
      var col = colorFor(m.name);
      var c = document.createElement("div"); c.className = "arena-card glass" + (m.id === state.penHolder ? " penholder" : ""); c.style.setProperty("--mc", col); c.dataset.id = m.id;
      c.innerHTML =
        '<div class="arena-card-head"><span class="ach-model"><span class="ac-dot" style="background:' + col + '"></span><span class="mname-t">' + m.name + '</span>' + (m.provider ? '<span class="ach-cloud">☁</span>' : '') + '</span><span class="ach-meta"></span><button class="arena-pen' + (m.id === state.penHolder ? " on" : "") + '" title="Give this model the pen — it can edit the open document">✒</button><button class="arena-close" title="' + (m.provider ? "Remove from arena" : "Close &amp; unload from Ollama") + '">✕</button></div>' +
        '<div class="lane"><div class="lane-fill" style="width:0%;background:' + col + '"></div></div>' +
        '<div class="arena-convo"></div>' +
        '<div class="arena-cinput"><textarea rows="1" placeholder="Ask ' + esc(m.name.split(":")[0]) + '…"></textarea><button class="arena-send" title="Send to this model"><svg viewBox="0 0 24 24" fill="#0a1020"><path d="M3.4 20.4 21 12 3.4 3.6 3.39 10.2 15 12l-11.61 1.8z"/></svg></button></div>';
      c.querySelector(".arena-close").addEventListener("click", function () { closeArenaModel(m.id); });
      c.querySelector(".arena-pen").addEventListener("click", function () { setPen(m.id); });
      var ta = c.querySelector("textarea"), sb = c.querySelector(".arena-send");
      function doSend() { var v = (ta.value || "").trim(); if (!v) return; ta.value = ""; ta.style.height = ""; sendToArenaModel(m.id, v); }
      sb.addEventListener("click", doSend);
      ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } });
      ta.addEventListener("input", function () { ta.style.height = ""; ta.style.height = Math.min(ta.scrollHeight, 80) + "px"; });
      grid.appendChild(c);
      renderArenaConvo(m.id);
    });
  }
  function renderArenaConvo(id) {
    var card = arenaCardEl(id), m = arenaItem(id); if (!card || !m) return;
    var convo = card.querySelector(".arena-convo");
    if (!m.messages.length) { convo.innerHTML = '<div class="arena-out-idle">Broadcast a prompt, or ask this model directly below.</div>'; return; }
    convo.innerHTML = m.messages.map(function (msg) {
      if (msg.role === "user") { var d = document.createElement("div"); d.className = "arena-msg-u"; d.textContent = msg.content; return d.outerHTML; }
      return '<div class="arena-msg-a">' + (msg.content ? renderMd(msg.content) : '<span class="cursor"></span>') + '</div>';
    }).join("");
    convo.scrollTop = convo.scrollHeight;
  }
  function sendToArenaModel(id, text) {
    var m = arenaItem(id); if (!m || m.busy) return;
    m.messages.push({ role: "user", content: text });
    streamArena(id);
  }
  function streamArena(id) {
    var m = arenaItem(id); if (!m) return;
    var payloadMsgs = m.messages.map(function (x) { return { role: x.role, content: x.content }; });
    var assistant = { role: "assistant", content: "" }; m.messages.push(assistant); m.busy = true;
    renderArenaConvo(id);
    var card = arenaCardEl(id);
    var fill = card && card.querySelector(".lane-fill"), meta = card && card.querySelector(".ach-meta");
    if (meta) meta.textContent = "…";
    var tFirst = 0, tLast = 0;
    function setRate() { if (meta && tLast > tFirst) { var w = assistant.content.trim() ? assistant.content.trim().split(/\s+/).length : 0; meta.textContent = Math.round(w / ((tLast - tFirst) / 1000)) + " w/s"; } }
    var payload = { model: m.name, messages: payloadMsgs, options: {} };
    if (m.provider) payload.provider = m.provider;
    if (state.penHolder === id && state.doc && state.doc.open && state.doc.editable) payload.can_edit_doc = true;
    fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then(function (res) {
        var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { m.busy = false; if (fill) fill.style.width = "100%"; setRate(); renderArenaConvo(id); var cv = card && card.querySelector(".arena-convo"); if (cv) renderArtifacts(cv); return; }
            buf += dec.decode(r.value, { stream: true });
            var lines = buf.split("\n"); buf = lines.pop();
            lines.forEach(function (line) {
              if (!line.trim()) return; var o; try { o = JSON.parse(line); } catch (e) { return; }
              if (o.doc_event) { loadDoc(); return; }
              if (o.error) { assistant.content += "\n\n_" + o.error + "_"; }
              var msg = o.message || {};
              if (msg.content) { if (!tFirst) tFirst = Date.now(); tLast = Date.now(); assistant.content += msg.content; if (fill) fill.style.width = Math.min(96, 8 + assistant.content.length / 6) + "%"; setRate(); renderArenaConvo(id); }
            });
            return pump();
          });
        }
        return pump();
      }).catch(function (e) { m.busy = false; if (e.name !== "AbortError") { assistant.content += "\n\n_request failed_"; renderArenaConvo(id); } });
  }
  function broadcastArena() {
    var promptEl = $("arenaPrompt"), prompt = (promptEl && promptEl.value || "").trim();
    if (!prompt) { promptEl && promptEl.focus(); return; }
    if (!state.arena.length) { window.showToast && window.showToast("Add models to the arena first"); return; }
    state.arena.forEach(function (m) { m.messages.push({ role: "user", content: prompt }); streamArena(m.id); });
    if (promptEl) promptEl.value = "";
  }
  function crossPollinate() {
    if (state.arena.length < 2) { window.showToast && window.showToast("Add at least 2 models to cross-pollinate"); return; }
    var answers = state.arena.map(function (m) { var last = ""; m.messages.forEach(function (x) { if (x.role === "assistant" && x.content) last = x.content; }); return { name: m.name, text: last }; });
    if (answers.filter(function (a) { return a.text; }).length < 2) { window.showToast && window.showToast("Need at least 2 answers first — Broadcast a prompt"); return; }
    state.arena.forEach(function (m, i) {
      var others = answers.filter(function (a, j) { return j !== i && a.text; }).map(function (a) { return "## " + a.name + " answered:\n" + a.text; }).join("\n\n");
      if (!others) return;
      m.messages.push({ role: "user", content: "Here are the other models' answers to the same question:\n\n" + others + "\n\nReconsider your own answer in light of theirs. Keep what you got right, correct anything wrong, and give your best final answer." });
      streamArena(m.id);
    });
    window.showToast && window.showToast("Cross-pollinating " + state.arena.length + " models");
  }

  // ---------- Shared document (the pen): every model reads it; the pen-holder edits it ----------
  function loadDoc() {
    fetch("/api/doc").then(function (r) { return r.json(); }).then(function (d) { state.doc = d && d.open ? d : null; renderDoc(); }).catch(function () {});
  }
  function openDoc() {
    var btn = $("docOpenBtn"); if (!btn) return; var old = btn.innerHTML; btn.disabled = true; btn.textContent = "…";
    fetch("/api/doc/browse", { method: "POST" }).then(function (r) { return r.json(); }).then(function (d) {
      btn.disabled = false; btn.innerHTML = old;
      if (d.ok) { state.doc = { open: true, name: d.name, content: d.content, editable: d.editable, kind: d.kind }; renderDoc(); window.showToast && window.showToast("Opened " + d.name); }
      else if (d.error) window.showToast && window.showToast(d.error);
    }).catch(function () { btn.disabled = false; btn.innerHTML = old; });
  }
  function saveDoc() {
    var ta = document.querySelector("#docBodyEl textarea"); if (!ta || !state.doc) return;
    fetch("/api/doc/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: ta.value }) })
      .then(function (r) { return r.json(); }).then(function (d) { if (d.ok) { state.doc.content = ta.value; window.showToast && window.showToast("Document saved"); } else window.showToast && window.showToast(d.error || "Save failed"); });
  }
  function setPen(id) { state.penHolder = (state.penHolder === id) ? null : id; renderArenaCards(); renderDoc(); }
  function renderDoc() {
    var pane = $("arenaDoc"); if (!pane) return;
    var nameEl = $("docName"), chip = $("docPenChip"), body = $("docBodyEl");
    var holder = state.penHolder ? arenaItem(state.penHolder) : null;
    if (!state.doc || !state.doc.open) {
      nameEl.textContent = "No document"; chip.hidden = true; pane.classList.remove("held"); pane.style.removeProperty("--pen");
      body.classList.remove("editing");
      body.innerHTML = '<div class="arena-out-idle" style="padding:20px">Open a Markdown/text file. Every racing model can read it; give one model the pen (✒ on its card) and it edits the doc when it answers.</div>';
      return;
    }
    nameEl.textContent = state.doc.name;
    chip.hidden = false;
    if (holder) { var c = colorFor(holder.name); pane.classList.add("held"); pane.style.setProperty("--pen", c); chip.style.setProperty("--pen", c); chip.textContent = "✒ " + holder.name.split(":")[0] + " holds the pen"; }
    else { pane.classList.remove("held"); pane.style.removeProperty("--pen"); chip.style.removeProperty("--pen"); chip.textContent = "read-only · ✒ a card to assign the pen"; }
    if ($("docSaveBtn")) $("docSaveBtn").style.display = state.doc.editable ? "" : "none";
    if (state.doc.editable) {
      body.dataset.pkey = "";
      if (!body.querySelector("textarea")) { body.classList.add("editing"); body.innerHTML = '<textarea spellcheck="false"></textarea>'; }
      var ta = body.querySelector("textarea");
      if (document.activeElement !== ta) ta.value = state.doc.content || "";
    } else {
      body.classList.remove("editing");
      var k = state.doc.kind || "", key = (state.doc.name || "") + "|" + k;
      if (body.dataset.pkey !== key) {       // only (re)build when the file/kind changes
        body.dataset.pkey = key; var bust = "?t=" + Date.now();
        if (k === "pdf") body.innerHTML = '<iframe class="doc-frame" src="/api/doc/raw' + bust + '"></iframe>';
        else if (k === "image") body.innerHTML = '<div class="doc-media"><img src="/api/doc/raw' + bust + '" alt=""></div>';
        else if (k === "video") body.innerHTML = '<div class="doc-media"><video src="/api/doc/raw' + bust + '" controls></video></div>';
        else if (k === "docx" || k === "pptx" || k === "xlsx") {
          body.innerHTML = '<div class="doc-loading">Rendering ' + k + ' preview…</div>';
          fetch("/api/doc/preview").then(function (r) { return r.json(); }).then(function (d) {
            var f = document.createElement("iframe"); f.className = "doc-frame"; f.setAttribute("sandbox", "allow-same-origin");
            f.srcdoc = d.html || "<p>Preview unavailable.</p>"; body.innerHTML = ""; body.appendChild(f);
          }).catch(function () { body.innerHTML = '<div class="doc-loading">Preview failed.</div>'; });
        } else body.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:12.5px">No preview for this file type. Try text, Markdown, PDF, an image, or Office (docx/pptx/xlsx).</div>';
      }
    }
  }
  function toggleDoc() { var pane = $("arenaDoc"); if (!pane) return; pane.hidden = !pane.hidden; $("arenaDocBtn") && $("arenaDocBtn").classList.toggle("on", !pane.hidden); if (!pane.hidden) loadDoc(); }

  // ---------- Autonomous collaboration: models pass the pen + reach consensus ----------
  // One focused, stateless turn against a model (the doc is injected server-side). Shows
  // `displayText` in the card but sends `modelText`; resolves with the model's reply text.
  function askOne(item, modelText, displayText) {
    return new Promise(function (resolve) {
      item.messages.push({ role: "user", content: displayText || modelText });
      var assistant = { role: "assistant", content: "" }; item.messages.push(assistant); item.busy = true;
      renderArenaConvo(item.id);
      var card = arenaCardEl(item.id), fill = card && card.querySelector(".lane-fill"), meta = card && card.querySelector(".ach-meta");
      if (meta) meta.textContent = "…";
      var payload = { model: item.name, messages: [{ role: "user", content: modelText }], options: {} };
      if (item.provider) payload.provider = item.provider;
      if (state.penHolder === item.id && state.doc && state.doc.open && state.doc.editable) payload.can_edit_doc = true;
      fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        .then(function (res) {
          var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
          function pump() {
            return reader.read().then(function (r) {
              if (r.done) { item.busy = false; if (fill) fill.style.width = "100%"; if (meta) meta.textContent = ""; renderArenaConvo(item.id); var cv = card && card.querySelector(".arena-convo"); if (cv) renderArtifacts(cv); resolve(assistant.content); return; }
              buf += dec.decode(r.value, { stream: true });
              var lines = buf.split("\n"); buf = lines.pop();
              lines.forEach(function (line) {
                if (!line.trim()) return; var o; try { o = JSON.parse(line); } catch (e) { return; }
                if (o.doc_event) { loadDoc(); return; }
                if (o.error) assistant.content += "\n\n_" + o.error + "_";
                var msg = o.message || {}; if (msg.content) { assistant.content += msg.content; renderArenaConvo(item.id); }
              });
              return pump();
            });
          }
          return pump();
        }).catch(function () { item.busy = false; resolve(assistant.content); });
    });
  }
  function parseProposal(text) {
    function grab(key) { var m = text.match(new RegExp(key + "\\s*:\\s*([\\s\\S]*?)(?:\\n[A-Z][A-Z ]{2,}:|$)", "i")); return m ? m[1].trim() : ""; }
    var dRaw = grab("DECISION"), edit = grab("EDIT");
    var hasEdit = !!edit && !/^(none|n\/a|no\b|nothing)/i.test(edit);
    var decision = (/\bdone\b/i.test(dRaw) && !/\bedit\b/i.test(dRaw)) ? "DONE" : (hasEdit || /edit/i.test(dRaw) ? "EDIT" : "DONE");
    return { decision: decision, volunteer: /yes/i.test(grab("VOLUNTEER")), edit: edit, reason: grab("REASON") || "(no reason given)" };
  }
  var _collabOn = false;
  function autoCollaborate() {
    if (_collabOn) return;
    if (state.arena.length < 2) { window.showToast && window.showToast("Add at least 2 models to collaborate"); return; }
    if (!state.doc || !state.doc.open || !state.doc.editable) { window.showToast && window.showToast("Open an editable text/Markdown document first"); return; }
    var goal = ($("arenaPrompt").value || "").trim();
    if (!goal) { window.showToast && window.showToast("Type the document goal in the shared prompt"); $("arenaPrompt").focus(); return; }
    _collabOn = true; var btn = $("arenaCollab"); if (btn) { btn.classList.add("on"); btn.disabled = true; }
    var history = [], lastHolder = null, MAX = 8;
    function finish(msg) { _collabOn = false; if (btn) { btn.classList.remove("on"); btn.disabled = false; } setPen(state.penHolder); window.showToast && window.showToast("Collaboration finished — " + msg); }
    function round(n) {
      if (n > MAX) return finish("reached the round limit; document saved.");
      var hist = history.length ? history.slice(-6).join("\n") : "(nothing yet)";
      var prompt =
        "You and the other AI models are collaborating to improve the shared document (shown in your context) toward this goal:\n" +
        "GOAL: " + goal + "\n\nCollaboration so far:\n" + hist + "\n\n" +
        "Decide whether the document needs another edit to meet the goal. Reply in EXACTLY this format and nothing else:\n" +
        "DECISION: EDIT or DONE\nVOLUNTEER: yes or no\nEDIT: <if EDIT: the ONE specific change — quote the exact existing text to find and its replacement, or 'APPEND: <text>'>\nREASON: <one short sentence>";
      Promise.all(state.arena.map(function (it) {
        return askOne(it, prompt, "Round " + n + ": review the document and propose an edit (or vote it's done) toward — " + goal).then(function (t) { return { it: it, p: parseProposal(t) }; });
      })).then(function (results) {
        results.forEach(function (r) { history.push(r.it.name.split(":")[0] + ": " + r.p.decision + " — " + r.p.reason); });
        var editors = results.filter(function (r) { return r.p.decision === "EDIT" && r.p.edit; });
        if (!editors.length) return finish("the group agrees the document is done.");
        var vols = editors.filter(function (r) { return r.p.volunteer; }); var pool = vols.length ? vols : editors;
        var pick = pool.filter(function (r) { return r.it.id !== lastHolder; })[0] || pool[0];
        lastHolder = pick.it.id; setPen(pick.it.id);
        var ep = "The group chose you to hold the pen this round. Using the edit_document tool, make this single improvement to the shared document, then confirm in one short line:\n" + pick.p.edit + "\nRules: make exactly ONE surgical edit_document call; `find` must be text that exists verbatim in the document; pass only real document text to `find`/`replace` — never put labels like 'REPLACE:', 'EDIT:', 'APPEND:', or 'FIND:' into the content; preserve the rest of the document.";
        askOne(pick.it, ep, "✒ Holds the pen — applying: " + pick.p.reason).then(function () {
          history.push("✒ " + pick.it.name.split(":")[0] + " edited the document (" + pick.p.reason + ")");
          loadDoc(); setTimeout(function () { round(n + 1); }, 500);
        });
      });
    }
    window.showToast && window.showToast("Models are collaborating on the document…");
    round(1);
  }

  // ---------- MCP servers (Settings → Tools): connect tools for every model ----------
  function renderMcp() {
    var box = $("mcpServers"); if (!box) return;
    fetch("/api/mcp").then(function (r) { return r.json(); }).then(function (d) {
      var servers = d.servers || []; box.innerHTML = ""; var connecting = false;
      if (!servers.length) box.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:0 2px 8px">No MCP servers yet — add one below.</div>';
      servers.forEach(function (s) {
        var card = document.createElement("div"); card.className = "cloudp";
        var statusTxt = s.enabled ? (s.connected ? (s.tools.length + " tool" + (s.tools.length === 1 ? "" : "s")) : "connecting…") : "disabled";
        if (s.enabled && !s.connected) connecting = true;
        card.innerHTML =
          '<div class="cloudp-top"><span class="cloudp-lg" style="background:#67d68a">⚙</span><span class="cloudp-name"></span><span class="' + (s.enabled && s.connected ? "cloudp-stat connected" : "cloudp-stat") + '"></span></div>' +
          '<div class="cloudp-row" style="justify-content:flex-end;align-items:center"><button class="toggle' + (s.enabled ? " on" : "") + '" title="Enable / disable"></button><button class="cloudp-btn mcp-rm">Remove</button></div>';
        var nm = card.querySelector(".cloudp-name"); nm.appendChild(document.createTextNode(s.name));
        var small = document.createElement("small"); small.textContent = (s.command || "") + (s.args && s.args.length ? " " + s.args.join(" ") : ""); nm.appendChild(small);
        card.querySelector(".cloudp-stat").textContent = statusTxt;
        card.querySelector(".toggle").addEventListener("click", function () { toggleMcp(s.name, !s.enabled); });
        card.querySelector(".mcp-rm").addEventListener("click", function () { removeMcp(s.name); });
        box.appendChild(card);
      });
      if (connecting && !state._mcpPoll) state._mcpPoll = setInterval(renderMcp, 2500);
      if (!connecting && state._mcpPoll) { clearInterval(state._mcpPoll); state._mcpPoll = null; }
    }).catch(function () {});
  }
  function addMcp() {
    var name = ($("mcpName").value || "").trim(), cmd = ($("mcpCmd").value || "").trim(), args = ($("mcpArgs").value || "").trim();
    if (!name || !cmd) { window.showToast && window.showToast("Name and command are required"); return; }
    var btn = $("mcpAdd"); btn.disabled = true; btn.textContent = "…";
    fetch("/api/mcp/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name, command: cmd, args: args, enabled: true }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        btn.disabled = false; btn.textContent = "Add";
        if (d.ok) { $("mcpName").value = ""; $("mcpCmd").value = ""; $("mcpArgs").value = ""; window.showToast && window.showToast("Added " + name + " — connecting…"); setTimeout(renderMcp, 800); }
        else window.showToast && window.showToast(d.error || "Couldn't add server");
      }).catch(function () { btn.disabled = false; btn.textContent = "Add"; });
  }
  function toggleMcp(name, enabled) { fetch("/api/mcp/toggle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name, enabled: enabled }) }).then(function () { window.showToast && window.showToast(enabled ? "Enabling…" : "Disabled"); setTimeout(renderMcp, 700); }); }
  function removeMcp(name) { fetch("/api/mcp/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name }) }).then(function () { window.showToast && window.showToast("Removed " + name); setTimeout(renderMcp, 700); }); }

  // ---------- Second brain (connect an Obsidian vault from Settings) ----------
  function renderSecondBrain() {
    var vaultEl = $("sbVault"); if (!vaultEl) return;
    fetch("/api/secondbrain/config").then(function (r) { return r.json(); }).then(function (d) {
      if (document.activeElement !== vaultEl) vaultEl.value = d.vault || "";
      var st = $("sbStatus"), stat = $("sbStat"), note = $("sbNote");
      if (d.indexing) { st.textContent = " · indexing…"; stat.textContent = "indexing"; stat.className = "cloudp-stat"; }
      else if (d.available && d.notes) { st.textContent = " · " + d.notes + " notes indexed"; stat.textContent = "connected"; stat.className = "cloudp-stat connected"; }
      else if (d.error) { st.textContent = " · error"; stat.textContent = "error"; stat.className = "cloudp-stat"; if (note) note.textContent = d.error; }
      else { st.textContent = " · not indexed yet"; stat.textContent = "not connected"; stat.className = "cloudp-stat"; }
      if (d.indexing && !state._sbPoll) state._sbPoll = setInterval(renderSecondBrain, 2500);
      if (!d.indexing && state._sbPoll) { clearInterval(state._sbPoll); state._sbPoll = null; if (d.notes) window.showToast && window.showToast("Vault indexed · " + d.notes + " notes"); }
    }).catch(function () {});
  }
  function browseVault() {
    var btn = $("sbBrowse"), old = btn.textContent; btn.disabled = true; btn.textContent = "…";
    fetch("/api/secondbrain/browse", { method: "POST" }).then(function (r) { return r.json(); }).then(function (d) {
      btn.disabled = false; btn.textContent = old;
      if (d.ok && d.path) { $("sbVault").value = d.path; window.showToast && window.showToast("Selected — now click Connect & index"); }
      else if (d.error) { window.showToast && window.showToast(d.error); }
    }).catch(function () { btn.disabled = false; btn.textContent = old; });
  }
  function connectVault() {
    var vaultEl = $("sbVault"), vault = (vaultEl.value || "").trim();
    if (!vault) { vaultEl.focus(); return; }
    var btn = $("sbConnect"); btn.textContent = "…"; btn.disabled = true;
    fetch("/api/secondbrain/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vault: vault }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        btn.textContent = "Connect & index"; btn.disabled = false;
        if (d.ok) { window.showToast && window.showToast("Indexing " + d.notes_found + " notes…"); renderSecondBrain(); }
        else { window.showToast && window.showToast(d.error || "Couldn't connect"); var st = $("sbStatus"); if (st) st.textContent = " · " + (d.error || ""); }
      }).catch(function () { btn.textContent = "Connect & index"; btn.disabled = false; });
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
    if ($("filesToggle")) $("filesToggle").addEventListener("click", loadFiles);
    if ($("arenaBroadcast")) $("arenaBroadcast").addEventListener("click", broadcastArena);
    if ($("arenaCross")) $("arenaCross").addEventListener("click", crossPollinate);
    if ($("arenaCollab")) $("arenaCollab").addEventListener("click", autoCollaborate);
    if ($("arenaDocBtn")) $("arenaDocBtn").addEventListener("click", toggleDoc);
    if ($("docOpenBtn")) $("docOpenBtn").addEventListener("click", openDoc);
    if ($("docSaveBtn")) $("docSaveBtn").addEventListener("click", saveDoc);
    if ($("sbConnect")) $("sbConnect").addEventListener("click", connectVault);
    if ($("sbBrowse")) $("sbBrowse").addEventListener("click", browseVault);
    if ($("mcpAdd")) $("mcpAdd").addEventListener("click", addMcp);
    if ($("openSettings")) $("openSettings").addEventListener("click", function () { renderSecondBrain(); renderMcp(); });
    renderSecondBrain(); renderMcp();
    if ($("arenaPrompt")) $("arenaPrompt").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); broadcastArena(); } });
    document.addEventListener("mousedown", function (e) { if (!e.target.closest(".arena-pill")) closeArenaPills(); });
    renderArenaCards();
    renderTelemetry();
    setInterval(function () { var ap = $("app"); if (document.visibilityState === "visible" && ap && ap.classList.contains("show-inspector")) renderTelemetry(); }, 5000);
    document.querySelectorAll(".insp-tab").forEach(function (t) { t.addEventListener("click", function () { var p = t.dataset.tab; if (p === "graph") renderGraph(); else if (p === "sources") renderSources(); else renderTelemetry(); }); });
    var topTitle = document.querySelector(".topttl .t");
    if (topTitle) { topTitle.title = "Double-click to rename"; topTitle.style.cursor = "text"; topTitle.addEventListener("dblclick", function () { if (state.activeId) editTitle(topTitle, state.activeId); }); }
    wireAgentToggle("tgWrites", "/api/agent/writes", "enabled");
    wireAgentToggle("tgApprove", "/api/agent/approval", "required");

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
