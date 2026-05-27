/* Tiny, dependency-free markdown renderer — vendored locally so the app works
 * with zero internet. Handles the subset that matters for chat: fenced code
 * blocks (with copy buttons), inline code, **bold**, *italic*, unordered and
 * ordered lists, paragraphs, and line breaks. HTML is escaped first, so it is
 * safe to inject the output.
 *
 * Exposes a single global: renderMarkdown(text) -> htmlString.
 */
(function () {
  "use strict";

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Inline formatting applied to already-escaped text (never inside code).
  function renderInline(text) {
    return text
      .replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  }

  function renderMarkdown(src) {
    const escaped = escapeHtml(src);

    // Split on fenced code blocks first so their contents are left untouched.
    const parts = escaped.split(/(```[\s\S]*?```)/g);
    let html = "";

    for (const part of parts) {
      const fence = part.match(/^```([^\n]*)\n?([\s\S]*?)```$/);
      if (fence) {
        const lang = fence[1].trim().toLowerCase();
        const code = fence[2].replace(/\n$/, "");
        // Renderable artifacts: app.js turns these into a diagram + toolbar once
        // the block is complete. Until then they read as a code block. The source
        // sits HTML-escaped inside .artifact-src; app.js reads it via textContent.
        if (["mermaid", "svg", "html", "chart", "embed"].includes(lang)) {
          html +=
            '<div class="artifact" data-type="' + lang + '" data-rendered="0">' +
            '<pre class="artifact-src">' + code + "</pre>" +
            "</div>";
          continue;
        }
        // Carry the language as a sanitized class + a small label; app.js reads
        // the class and runs the offline highlighter once the block is complete.
        const langSafe = lang.replace(/[^\w+#-]/g, "");
        const langLabel = langSafe ? '<span class="code-lang">' + langSafe + "</span>" : "";
        const codeClass = langSafe ? ' class="lang-' + langSafe + '"' : "";
        html +=
          '<div class="code-block">' +
          langLabel +
          '<button class="copy-btn" type="button">Copy</button>' +
          "<pre><code" +
          codeClass +
          ">" +
          code +
          "</code></pre>" +
          "</div>";
        continue;
      }

      // Process the non-code segment block by block.
      const lines = part.split("\n");
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];

        // ATX header: # … ###### . Level = number of leading hashes (escaped to
        // "#" already since escapeHtml leaves "#" untouched).
        const header = line.match(/^(#{1,6})\s+(.*)$/);
        if (header) {
          const level = header[1].length;
          html += "<h" + level + ">" + renderInline(header[2].trim()) + "</h" + level + ">";
          i++;
          continue;
        }

        // Unordered list.
        if (/^\s*[-*+]\s+/.test(line)) {
          html += "<ul>";
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            const item = lines[i].replace(/^\s*[-*+]\s+/, "");
            html += "<li>" + renderInline(item) + "</li>";
            i++;
          }
          html += "</ul>";
          continue;
        }

        // Ordered list.
        if (/^\s*\d+\.\s+/.test(line)) {
          html += "<ol>";
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
            const item = lines[i].replace(/^\s*\d+\.\s+/, "");
            html += "<li>" + renderInline(item) + "</li>";
            i++;
          }
          html += "</ol>";
          continue;
        }

        // Blank line -> paragraph break, skip.
        if (line.trim() === "") {
          i++;
          continue;
        }

        // Gather consecutive non-blank, non-list lines into one paragraph.
        const para = [];
        while (
          i < lines.length &&
          lines[i].trim() !== "" &&
          !/^\s*[-*+]\s+/.test(lines[i]) &&
          !/^\s*\d+\.\s+/.test(lines[i]) &&
          !/^#{1,6}\s+/.test(lines[i])
        ) {
          para.push(lines[i]);
          i++;
        }
        html += "<p>" + renderInline(para.join("<br>")) + "</p>";
      }
    }

    return html;
  }

  window.renderMarkdown = renderMarkdown;
})();
