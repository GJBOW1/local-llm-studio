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
        function finishStream() { body.parentElement.classList.remove("cursor"); state.messages.push({ role: "assistant", content: acc }); setStreaming(false); persist(); recordTps(acc.trim() ? acc.trim().split(/\s+/).length : 0, _tFirst ? Math.max(_tLast - _tFirst, 100) : 0); }
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
  function addArenaModel(name, provider, installed) {
    if (!provider && installed === false) startPull(name); // download the local model first
    state.arena.push({ name: name, provider: provider || "" });
    renderArenaCards();
    window.showToast && window.showToast("Added " + name.split(":")[0] + " to the race");
  }
  function closeArenaModel(i) {
    var m = state.arena[i]; if (!m) return;
    state.arena.splice(i, 1); renderArenaCards();
    if (!m.provider) {
      fetch("/api/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: m.name }) })
        .then(function () { window.showToast && window.showToast(m.name.split(":")[0] + " closed · unloaded from Ollama"); }).catch(function () {});
    } else { window.showToast && window.showToast("Removed " + m.name.split(":")[0]); }
  }
  function renderArenaCards() {
    var grid = $("arenaGrid"); if (!grid) return;
    var n = state.arena.length;
    grid.className = "arena-grid cols-" + Math.min(Math.max(n, 1), 3);
    grid.innerHTML = "";
    if (!n) { grid.innerHTML = '<div class="arena-empty">No models in the race yet.<br>Add some from the provider menus above, then Broadcast a prompt.</div>'; return; }
    state.arena.forEach(function (m, i) {
      var col = colorFor(m.name);
      var c = document.createElement("div"); c.className = "arena-card glass"; c.style.setProperty("--mc", col);
      var head = document.createElement("div"); head.className = "arena-card-head";
      head.innerHTML = '<span class="ach-model"><span class="ac-dot" style="background:' + col + '"></span><span class="mname-t">' + m.name + '</span>' + (m.provider ? '<span class="ach-cloud">☁</span>' : '') + '</span>';
      var close = document.createElement("button"); close.className = "arena-close"; close.title = m.provider ? "Remove from race" : "Close & unload from Ollama"; close.textContent = "✕";
      close.addEventListener("click", function () { closeArenaModel(i); });
      head.appendChild(close);
      c.appendChild(head);
      c.insertAdjacentHTML("beforeend", '<div class="lane"><div class="lane-fill" style="width:0%;background:' + col + '"></div></div><div class="arena-out arena-out-idle">idle — broadcast a prompt</div><div class="arena-foot">' + (m.provider ? "cloud · " + m.provider : "local") + '</div>');
      grid.appendChild(c);
    });
  }
  function broadcastArena() {
    var promptEl = $("arenaPrompt"), prompt = (promptEl && promptEl.value || "").trim();
    if (!prompt) { promptEl && promptEl.focus(); return; }
    if (!state.arena.length) { window.showToast && window.showToast("Add models to the race first"); return; }
    var cards = document.querySelectorAll("#arenaGrid .arena-card");
    var finishOrder = [];
    state.arena.forEach(function (m, i) {
      var card = cards[i]; if (!card) return;
      var out = card.querySelector(".arena-out"), fill = card.querySelector(".lane-fill"), foot = card.querySelector(".arena-foot");
      card.classList.remove("win"); out.textContent = ""; out.classList.remove("arena-out-idle"); foot.textContent = "running…";
      var acc = "", t0 = Date.now();
      function wc() { return acc.trim() ? acc.trim().split(/\s+/).length : 0; }
      var payload = { model: m.name, messages: [{ role: "user", content: prompt }], options: {} };
      if (m.provider) payload.provider = m.provider;
      fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        .then(function (res) {
          var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
          function pump() {
            return reader.read().then(function (r) {
              if (r.done) {
                var s = (Date.now() - t0) / 1000;
                foot.textContent = "✓ " + s.toFixed(1) + "s · " + wc() + " words · " + (wc() / Math.max(s, 0.1)).toFixed(0) + " w/s";
                fill.style.width = "100%";
                if (acc.trim()) { finishOrder.push(i); if (finishOrder.length === 1) { card.classList.add("win"); } }
                return;
              }
              buf += dec.decode(r.value, { stream: true });
              var lines = buf.split("\n"); buf = lines.pop();
              lines.forEach(function (line) {
                if (!line.trim()) return; var o; try { o = JSON.parse(line); } catch (e) { return; }
                if (o.error) { out.textContent = "⚠ " + o.error; foot.textContent = "error"; return; }
                var msg = o.message || {};
                if (msg.content) { acc += msg.content; out.textContent = acc; var s = (Date.now() - t0) / 1000; foot.textContent = (wc() / Math.max(s, 0.1)).toFixed(0) + " w/s"; fill.style.width = Math.min(96, 8 + acc.length / 6) + "%"; }
              });
              return pump();
            });
          }
          return pump();
        }).catch(function (e) { if (e.name !== "AbortError") { out.textContent = "⚠ request failed"; foot.textContent = "error"; } });
    });
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
