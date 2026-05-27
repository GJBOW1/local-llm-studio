/* highlight-mini — a tiny, dependency-free syntax highlighter, vendored locally
 * so the app stays 100% offline (same philosophy as markdown.js). It tokenizes
 * a handful of languages an LLM commonly emits and colours each token.
 *
 * XSS-safe by construction: it reads the code from the node's textContent and
 * rebuilds the node's children as <span> elements whose text is set via
 * textContent. No HTML string is ever assembled or injected, so untrusted code
 * can never become markup.
 *
 * Exposes one global: highlightCode(codeEl, langHint) — highlights in place.
 */
(function () {
  "use strict";

  // Anchored regex helper — matches only at the start of the remaining slice so
  // the scanner can consume one token at a time, left to right.
  function rx(source, extraFlags) {
    return new RegExp("^(?:" + source + ")", extraFlags || "");
  }

  function kw(words) {
    return rx("\\b(?:" + words.trim().split(/\s+/).join("|") + ")\\b");
  }

  // Shared token rules.
  const STR_DQ = ["str", rx('"(?:\\\\.|[^"\\\\\\n])*"?')];
  const STR_SQ = ["str", rx("'(?:\\\\.|[^'\\\\\\n])*'?")];
  const STR_TICK = ["str", rx("`(?:\\\\.|[^`\\\\])*`?")];
  const NUM = ["num", rx("\\b0[xX][0-9a-fA-F]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b")];
  const LINE_C_SLASH = ["com", rx("//[^\\n]*")];
  const LINE_C_HASH = ["com", rx("#[^\\n]*")];
  const BLOCK_C = ["com", rx("/\\*[\\s\\S]*?\\*/")];
  const FN = ["fn", rx("[A-Za-z_$][\\w$]*(?=\\s*\\()")];

  const JS_KW =
    "as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield";
  const TS_EXTRA =
    " interface type enum implements public private protected readonly namespace declare abstract is keyof infer satisfies override";
  const PY_KW =
    "and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield";
  const BASH_KW =
    "if then else elif fi for while until do done case esac function in return select time coproc";

  const LIT = ["lit", kw("true false null undefined NaN Infinity")];
  const PY_LIT = ["lit", kw("True False None")];

  const GRAMMARS = {
    javascript: [LINE_C_SLASH, BLOCK_C, STR_DQ, STR_SQ, STR_TICK, NUM, LIT, ["kw", kw(JS_KW)], FN],
    typescript: [LINE_C_SLASH, BLOCK_C, STR_DQ, STR_SQ, STR_TICK, NUM, LIT, ["kw", kw(JS_KW + TS_EXTRA)], FN],
    python: [LINE_C_HASH, STR_DQ, STR_SQ, NUM, PY_LIT, ["kw", kw(PY_KW)], FN],
    bash: [
      LINE_C_HASH,
      STR_DQ,
      STR_SQ,
      ["attr", rx("\\$(?:\\{[^}]*\\}|[A-Za-z_]\\w*|[@*#?!$])")],
      NUM,
      ["kw", kw(BASH_KW)],
    ],
    json: [
      ["attr", rx('"(?:\\\\.|[^"\\\\])*"(?=\\s*:)')],
      ["str", rx('"(?:\\\\.|[^"\\\\])*"')],
      NUM,
      LIT,
    ],
    css: [
      BLOCK_C,
      STR_DQ,
      STR_SQ,
      ["kw", rx("@[\\w-]+")],
      ["num", rx("#[0-9a-fA-F]{3,8}\\b")],
      ["num", rx("\\b\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr|pt)?\\b")],
      ["attr", rx("[a-zA-Z-]+(?=\\s*:)")],
    ],
    html: [
      ["com", rx("<!--[\\s\\S]*?-->")],
      ["str", rx('"(?:[^"]*)"')],
      ["str", rx("'(?:[^']*)'")],
      ["tag", rx("</?[a-zA-Z][\\w-]*")],
      ["tag", rx("/?>")],
      ["attr", rx("[a-zA-Z_:][\\w:.-]*(?=\\s*=)")],
    ],
    _default: [LINE_C_SLASH, LINE_C_HASH, BLOCK_C, STR_DQ, STR_SQ, STR_TICK, NUM, LIT],
  };

  const ALIASES = {
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    node: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    python3: "python",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    console: "bash",
    htm: "html",
    xml: "html",
    vue: "html",
    svg: "html",
    scss: "css",
    less: "css",
    json5: "json",
  };

  function resolveLang(hint) {
    const l = (hint || "").toLowerCase();
    if (GRAMMARS[l]) return l;
    if (ALIASES[l]) return ALIASES[l];
    return "_default";
  }

  // Tokenize and append <span> nodes (plus plain text nodes) to a fragment.
  // Token text is always set via textContent, so it can never be parsed as HTML.
  function tokenize(code, lang) {
    const grammar = GRAMMARS[lang] || GRAMMARS._default;
    const frag = document.createDocumentFragment();
    let pos = 0;
    let plain = "";
    const flush = () => {
      if (plain) {
        frag.appendChild(document.createTextNode(plain));
        plain = "";
      }
    };
    const n = code.length;
    while (pos < n) {
      const rest = code.slice(pos);
      let hit = null;
      for (const [cls, re] of grammar) {
        const m = rest.match(re);
        if (m && m[0].length > 0) {
          hit = [cls, m[0]];
          break;
        }
      }
      if (hit) {
        flush();
        const span = document.createElement("span");
        span.className = "tok-" + hit[0];
        span.textContent = hit[1];
        frag.appendChild(span);
        pos += hit[1].length;
      } else {
        plain += code[pos];
        pos += 1;
      }
    }
    flush();
    return frag;
  }

  // Highlight a <code> element in place by replacing its children with coloured
  // token nodes built from its current textContent.
  function highlightCode(codeEl, langHint) {
    if (!codeEl) return;
    const lang = resolveLang(langHint);
    codeEl.replaceChildren(tokenize(codeEl.textContent, lang));
  }

  window.highlightCode = highlightCode;
})();
