const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

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

/* ── Call Claude API ── */
async function callClaude(apiKey, prompt) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
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

  let url;
  try {
    ({ url } = JSON.parse(event.body));
    if (!url) throw new Error();
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please provide a valid URL.' }) };
  }

  try {
    // 1. Fetch article server-side (no CORS issues)
    const articleRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000)
    });
    if (!articleRes.ok) throw new Error('Could not fetch the article. The site may block automated access — try copy-pasting the text directly.');
    const html = await articleRes.text();

    // 2. Extract readable content
    const { title, description, body } = extractContent(html);
    const articleText = [title, description, body].filter(Boolean).join('\n\n');
    if (articleText.trim().length < 100) throw new Error('Could not extract enough content from this article.');

    // 3. Claude reads the article and identifies Jewish philosophical themes
    const prompt = `You are a learned rabbi and Jewish philosopher with deep knowledge of Torah, Talmud, Midrash, Maimonides, and modern Jewish thought. Read this news article carefully, then identify the most relevant Jewish philosophical, ethical, or spiritual concepts that illuminate the situation described.

Article:
---
${articleText}
---

Respond with ONLY a valid JSON object (no markdown, no preamble):
{
  "headline": "<one clear sentence: what is this article about?>",
  "jewish_lens": "<2-3 sentences: how does Jewish tradition as a whole approach this type of human situation — what is the broader framework?>",
  "topics": [
    {
      "concept": "<Jewish ethical/philosophical concept name in English>",
      "hebrew": "<Hebrew or Aramaic term, e.g. Tikkun Olam, Tzedek, Pikuach Nefesh — or empty string if none>",
      "relevance": "<3-4 sentences specifically connecting this concept to the events described in the article — be concrete, not generic>",
      "sefaria_query": "<3-5 English keywords that will find relevant Talmud/Torah/commentary passages on this theme>"
    }
  ]
}

Include 3 to 4 topics. Each must be directly connected to what is described in the article — not generic wisdom.`;

    const raw = await callClaude(apiKey, prompt);

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

    // 4. Search Sefaria in parallel for each topic
    const sefariaResults = await Promise.all(
      analysis.topics.map(t => searchSefaria(t.sefaria_query || t.concept))
    );

    // 5. Attach top passages to each topic
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
