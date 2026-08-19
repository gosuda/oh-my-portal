'use strict';

// ── Markdown renderer (self-contained, no dependencies) ─────────────

function md(src) {
  if (!src) return '';
  const blocks = [];
  let html = '';

  // Extract code blocks first
  let text = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocks.length;
    blocks.push({ lang, code });
    return `\x00CB${i}\x00`;
  });

  // Escape HTML
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Inline code (before other formatting)
  text = text.replace(/`([^`\n]+)`/g, '<code class="ic">$1</code>');

  // Bold
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    // Scheme whitelist — agent output must not mint javascript: links
    const u = url.trim();
    const safe = /^(https?:|mailto:|#|\/)/i.test(u) ? u : '#';
    return `<a href="${safe}" target="_blank" rel="noopener">${label}</a>`;
  });

  // Process lines (headers, lists, paragraphs)
  const lines = text.split('\n');
  let inList = false;
  let listType = '';
  let para = [];

  const flushPara = () => {
    if (para.length) {
      html += `<p>${para.join('<br>')}</p>`;
      para = [];
    }
  };
  const flushList = () => {
    if (inList) {
      html += `</${listType}>`;
      inList = false;
    }
  };

  for (const line of lines) {
    const t = line.trim();

    // Code block placeholder
    const cb = t.match(/^\x00CB(\d+)\x00$/);
    if (cb) {
      flushPara(); flushList();
      const b = blocks[parseInt(cb[1])];
      html += `<div class="code-block"><div class="code-lang">${escAttr(b.lang || 'text')}</div><pre><code>${hl(b.code, b.lang)}</code></pre></div>`;
      continue;
    }

    // Headers
    const h = t.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      flushPara(); flushList();
      const lvl = h[1].length;
      html += `<h${lvl + 2}>${h[2]}</h${lvl + 2}>`;
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(t)) {
      flushPara(); flushList();
      html += '<hr>';
      continue;
    }

    // Unordered list
    if (/^[-•]\s+/.test(t)) {
      flushPara();
      if (!inList || listType !== 'ul') { flushList(); html += '<ul>'; inList = true; listType = 'ul'; }
      html += `<li>${t.replace(/^[-•]\s+/, '')}</li>`;
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(t)) {
      flushPara();
      if (!inList || listType !== 'ol') { flushList(); html += '<ol>'; inList = true; listType = 'ol'; }
      html += `<li>${t.replace(/^\d+\.\s+/, '')}</li>`;
      continue;
    }

    // Empty line = paragraph break
    if (!t) {
      flushPara(); flushList();
      continue;
    }

    // Regular text
    flushList();
    para.push(t);
  }
  flushPara(); flushList();

  // Restore any remaining code blocks
  html = html.replace(/\x00CB(\d+)\x00/g, (_, i) => {
    const b = blocks[parseInt(i)];
    return `<div class="code-block"><div class="code-lang">${escAttr(b.lang || 'text')}</div><pre><code>${hl(b.code, b.lang)}</code></pre></div>`;
  });

  return html;
}

function escAttr(s) { return s.replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

// ── Basic syntax highlighting ─────────────────────────────────────────

const KW = {
  javascript: 'const let var function return if else for while class new typeof instanceof await async yield import export from default try catch finally throw switch case break continue delete in of this super extends static get set null undefined true false',
  typescript: 'const let var function return if else for while class new typeof instanceof await async yield import export from default try catch finally throw switch case break continue interface type enum implements private public protected readonly namespace declare null undefined true false string number boolean any void never unknown',
  python: 'def return if elif else for while class new lambda import from as try except finally raise with yield global nonlocal pass break continue assert del in is not and or None True False',
  go: 'func return if else for range switch case default break continue go defer chan select type struct interface map nil true false string int int64 float64 bool byte rune error',
  rust: 'fn return if else for while loop match use pub mod struct enum impl trait let mut const static async await move ref type where Self crate super as in dyn box yield break continue true false Some None Ok Err',
  bash: 'if then else elif fi for while do done case esac function return local export source echo exit cd ls grep find awk sed cat head tail sort uniq wc xargs sudo apt yum brew git docker curl wget ssh scp rm cp mv mkdir touch chmod chown',
  json: 'true false null',
  yaml: 'true false null yes no on off',
};

function hl(code, lang) {
  const l = (lang || '').toLowerCase();
  const aliases = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', golang: 'go', rs: 'rust' };
  const langKey = aliases[l] || l;
  const keywords = KW[langKey] ? KW[langKey].split(' ') : [];
  const kwSet = new Set(keywords);

  let out = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Comments
  if (langKey === 'python' || langKey === 'bash' || langKey === 'yaml') {
    out = out.replace(/(#[^\n]*)/g, '<span class="c">$1</span>');
  } else {
    out = out.replace(/(\/\/[^\n]*)/g, '<span class="c">$1</span>');
  }
  // Strings (simple, no nesting)
  out = out.replace(/(["'`])(?:(?!\1)[^\\\n]|\\.)*\1/g, m => `<span class="s">${m}</span>`);
  // Numbers
  out = out.replace(/\b(\d+\.?\d*)\b/g, '<span class="n">$1</span>');
  // Keywords
  if (kwSet.size) {
    out = out.replace(/\b([a-zA-Z_]\w*)\b/g, (m) => {
      if (kwSet.has(m)) return `<span class="k">${m}</span>`;
      // Common type/function patterns
      if (/^[A-Z]/.test(m) && m.length > 2) return `<span class="t">${m}</span>`;
      return m;
    });
  }

  return out;
}
