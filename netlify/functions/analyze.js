const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const JEWISH_PROMPT = `You are a learned rabbi and Jewish philosopher with deep knowledge of Torah, Talmud, Midrash, Maimonides, Kabbalistic literature, Responsa literature, and modern Jewish thought (Soloveitchik, Heschel, Levinas, Rav Kook, Luzzatto, etc.). You are also deeply familiar with world events and their political, social, and ethical dimensions.

Read this article carefully. Then identify the most relevant Jewish philosophical, ethical, or spiritual concepts that illuminate the specific situation described.

For each concept you must:
- Cite specific classical sources by name (tractate and folio, biblical verse, Maimonidean law, Midrash, or specific responsa)
- Reference at least one classical rabbinic authority (Rashi, Rambam, Ramban, Ramchal, Vilna Gaon, etc.) and one modern Jewish thinker (Soloveitchik, Heschel, Levinas, Rav Kook, Nechama Leibowitz, etc.) when relevant
- Explain concretely how the events in the article connect to this concept — not in a generic way
- Provide the historical and theological background of the concept

Respond with ONLY a valid JSON object (no markdown, no preamble):
{
  "headline": "<one clear sentence: what is this article about?>",
  "jewish_lens": "<3-4 sentences: how Jewish tradition as a whole approaches this type of situation — cite specific thinkers or texts that shape the Jewish worldview here>",
  "topics": [
    {
      "concept": "<Jewish ethical/philosophical concept name in English>",
      "hebrew": "<Hebrew or Aramaic term — or empty string if none>",
      "relevance": "<5-6 sentences: (1) how this concept applies concretely to the article's events; (2) the historical and theological background of this concept; (3) how classical authorities understood it; (4) how modern Jewish thinkers have developed or applied it>",
      "sources": "<2-3 specific citations, e.g. 'Talmud Bavli, Sanhedrin 37a; Maimonides, Mishneh Torah, Hilchot De'ot 6:3; Abraham Joshua Heschel, The Prophets (1962), ch. 1'>",
      "sefaria_query": "<3-5 English keywords to find relevant Talmud/Torah/commentary passages>"
    }
  ]
}

Include 3 to 4 topics. Each must be deeply and specifically connected to what is described in the article.`;

/* ── Strip HTML to plain text ── */
function extractContent(html) {
  const getMeta = (attr, val) => {
    const r1 = new RegExp(`<meta[^>]+${attr}=["']${val}["'][^>]+content=["']([^"']+)["']`, 'i');
    const r2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${val}["']`, 'i');
    return (html.match(r1) || html.match(r2) || [])[1] || '';
  };

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title       = getMeta('property', 'og:title') || getMeta('name', 'twitter:title') || (titleMatch && titleMatch[1]) || '';
  const description = getMeta('property', 'og:description') || getMeta('name', 'description') || '';

  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3500);

  return { title: title.trim(), description: description.trim(), body };
}

/* ── Call Claude API with a content array ── */
async function callClaudeMessages(apiKey, content, model) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 2500,
      messages: [{ role: 'user', content }]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${res.status} — ${err}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

/* ── Search Sefaria ── */
async function searchSefaria(query) {
  try {
    const params = new URLSearchParams({
      query, type: 'text', field: 'naive_lemmatizer',
      sort_type: 'relevance', size: 4
    });
    const res = await fetch(`https://www.sefaria.org/api/search-wrapper/?${params}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.hits?.hits || [];
  } catch {
    return [];
  }
}

/* ── Main handler ── */
exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured on the server.' }) };
  }

  let url, pdf, filename;
  try {
    ({ url, pdf, filename } = JSON.parse(event.body));
    if (!url && !pdf) throw new Error();
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please provide a valid URL or PDF.' }) };
  }

  try {
    let title = '';
    let claudeContent;

    if (pdf) {
      // PDF mode: send document directly to Claude
      title = filename ? filename.replace(/\.pdf$/i, '') : 'PDF Document';
      claudeContent = [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdf }
        },
        { type: 'text', text: JEWISH_PROMPT }
      ];
    } else {
      // URL mode: fetch article and embed text in prompt
      const articleRes = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(10000)
      });
      if (!articleRes.ok) throw new Error('Could not fetch the article. The site may block automated access — try copy-pasting the text directly.');
      const html = await articleRes.text();

      const { title: t, description, body } = extractContent(html);
      title = t;
      const articleText = [t, description, body].filter(Boolean).join('\n\n');
      if (articleText.trim().length < 100) throw new Error('Could not extract enough content from this article.');

      claudeContent = [{ type: 'text', text: `${JEWISH_PROMPT}\n\nArticle:\n---\n${articleText}\n---` }];
    }

    const model = pdf ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-5';
    const raw = await callClaudeMessages(apiKey, claudeContent, model);

    let analysis;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(match ? match[0] : raw);
    } catch {
      throw new Error('Could not parse the AI analysis. Please try again.');
    }

    if (!Array.isArray(analysis.topics) || analysis.topics.length === 0) {
      throw new Error('The AI did not return a valid analysis. Please try again.');
    }

    // Search Sefaria in parallel for each topic
    const sefariaResults = await Promise.all(
      analysis.topics.map(t => searchSefaria(t.sefaria_query || t.concept))
    );

    const topics = analysis.topics.map((t, i) => {
      const hits = sefariaResults[i] || [];
      const passages = hits.slice(0, 2).map(h => {
        const src = h._source || {};
        const en = (Array.isArray(src.exact) ? src.exact.join(' ') : (src.exact || src.text || '')).replace(/<[^>]+>/g, '').trim();
        const he = (Array.isArray(src.he) ? src.he.join(' ') : (src.he || '')).trim();
        return {
          ref: src.ref || '',
          en,
          he,
          categories: Array.isArray(src.categories) ? src.categories.join(' · ') : ''
        };
      }).filter(p => p.ref && (p.en || p.he));

      return { ...t, passages };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ title, headline: analysis.headline || '', jewish_lens: analysis.jewish_lens || '', topics })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'An unexpected error occurred.' })
    };
  }
};
