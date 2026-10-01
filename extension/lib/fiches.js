// Reads the publishing sheet placed next to a video, whatever tool wrote it:
//   - Markdown (publication.md, youtube.md, <video>.md): "## Titre" / "## Title",
//     "## Description", "## Mots-clés" / "## Tags", "## Commentaire épinglé";
//     a section's value is its first ``` block, or its text;
//     "## Titres proposés" with a numbered list -> the first one is used;
//   - JSON (metadata.json, <video>.json): { title, description, tags, comment };
//   - plain text (<video>.txt): first line = title, the rest = description;
//     description.txt / titre.txt / title.txt / tags.txt hold one field each.
// Shared by the offscreen scanner and the options page (no modules: plain global).

const KappFiches = (() => {
  const plain = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  function blockOrText(body) {
    const m = body.match(/```[^\n]*\n([\s\S]*?)```/);
    return (m ? m[1] : body).trim();
  }

  function sections(text) {
    const out = [];
    let current = null;
    let lines = [];
    let inCode = false;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('```')) inCode = !inCode;
      const m = inCode ? null : line.match(/^(#{1,3})\s+(.*)$/);
      if (m) {
        if (current) out.push({ ...current, body: lines.join('\n') });
        current = { level: m[1].length, heading: m[2].trim() };
        lines = [];
      } else {
        lines.push(line);
      }
    }
    if (current) out.push({ ...current, body: lines.join('\n') });
    return out;
  }

  function splitTags(raw) {
    const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,\n]/);
    return list.map((t) => String(t).replace(/^[\s#`]+|[\s`]+$/g, '')).filter((t) => t && !t.startsWith('('));
  }

  function markdown(text) {
    const sheet = {};
    for (const { heading, body } of sections(text)) {
      const key = plain(heading);
      if (/^(titres|titles|titre propose|title ideas|title options)/.test(key)) {
        const choices = [...body.matchAll(/^\s*\d+[.)]\s*(.+)$/gm)].map((m) => m[1].replace(/\s*\(\d+\s*car\w*\.?\)\s*$/, '').trim());
        if (choices.length && !sheet.title) {
          sheet.title = choices[0];
          sheet.titles = choices;
        }
      } else if (/^(titre|title)\b/.test(key)) {
        const value = blockOrText(body).split('\n')[0].trim();
        if (value) sheet.title = value;
      } else if (key.startsWith('description')) {
        sheet.description = blockOrText(body);
      } else if (/^(mots|tags|keywords)/.test(key)) {
        sheet.tags = splitTags(blockOrText(body));
      } else if (/^(destination|plateformes?|platforms?|publier sur)\b/.test(key)) {
        sheet.destination = blockOrText(body);
      } else if (/^(commentaire|pinned comment|comment)/.test(key)) {
        sheet.comment = blockOrText(body);
      }
    }
    return sheet;
  }

  function json(text) {
    const data = JSON.parse(text);
    return {
      title: data.title || data.titre,
      description: data.description,
      tags: data.tags || data.keywords || data.mots_cles ? splitTags(data.tags || data.keywords || data.mots_cles) : undefined,
      comment: data.comment || data.commentaire,
    };
  }

  // name: file name of the sheet; text: its content.
  function read(name, text) {
    const lower = plain(name);
    try {
      if (lower.endsWith('.json')) return json(text);
      if (lower.endsWith('.md')) return markdown(text);
      if (lower.endsWith('.txt')) {
        if (lower.startsWith('description')) return { description: text.trim() };
        if (lower.startsWith('titre') || lower.startsWith('title')) return { title: text.trim().split('\n')[0] };
        if (lower.startsWith('tags') || lower.startsWith('mots')) return { tags: splitTags(text) };
        // Sections written as labels in capitals ("TITRES (au choix)",
        // "DESCRIPTION", "MINIATURE : x.jpg") are read like Markdown headings.
        const label = /^([A-ZÀ-Ý][A-ZÀ-Ý'’ -]{2,30}?)\s*(\([^)]*\))?\s*(?::\s*(.*))?$/;
        const lines = text.trim().split(/\r?\n/);
        const isLabel = (line) => label.test(line.trim());
        if (lines.some((line) => isLabel(line) && /^(TITRE|TITLE|DESCRIPTION|TAGS|MOTS)/.test(plain(line).toUpperCase()))) {
          return markdown(lines.map((line) => {
            const m = line.trim().match(label);
            // Only known labels: "SOURCES" or "CHAPITRES" stay inside the description.
            if (!m || !/^(TITRE|TITLE|DESCRIPTION|TAGS|MOTS|KEYWORDS|MINIATURE|THUMBNAIL|COMMENTAIRE|COMMENT|HASHTAGS)/.test(plain(m[1]).toUpperCase())) return line;
            return `## ${m[1].trim()}${m[2] ? ` ${m[2]}` : ''}${m[3] ? `\n${m[3]}` : ''}`;
          }).join('\n'));
        }
        const [first, ...rest] = lines;
        return { title: (first || '').trim(), description: rest.join('\n').trim() };
      }
    } catch {
      return {};
    }
    return {};
  }

  // YouTube Studio rejects < and > and cuts long fields.
  function clean(text, limit) {
    return String(text || '').replace(/</g, '‹').replace(/>/g, '›').trim().slice(0, limit).trim();
  }

  // Keeps whole tags within YouTube's 500-character budget.
  function fitTags(tags) {
    const out = [];
    let used = 0;
    for (const tag of tags || []) {
      const cost = tag.length + (tag.includes(' ') ? 2 : 0) + (out.length ? 1 : 0);
      if (used + cost > 500) break;
      out.push(tag);
      used += cost;
    }
    return out;
  }

  return { read, clean, fitTags, plain };
})();
