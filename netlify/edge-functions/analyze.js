const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const PERSONA = `You are a learned rabbi and Jewish philosopher with deep knowledge of Torah, Talmud, Midrash, Maimonides, Kabbalistic literature, Responsa literature, and modern Jewish thought (Soloveitchik, Heschel, Levinas, Rav Kook, Luzzatto, etc.). You are also deeply familiar with world events and their political, social, and ethical dimensions.

CITATION RULE: whenever you cite a specific classical source, write the reference in double square brackets using its standard English Sefaria-style name — e.g. [[Genesis 11:1-9]], [[Sanhedrin 37a]], [[Pirkei Avot 4:1]], [[Mishneh Torah, Repentance 2:1]], [[Genesis Rabbah 38:6]]. These become clickable links to the text. Weave them into your sentences naturally ("as the Talmud teaches in [[Bava Metzia 59b]]…"). Only bracket works that exist on Sefaria (Tanakh, Talmud, Mishnah, Midrash, Mishneh Torah, Shulchan Arukh, Zohar, classical commentaries); never bracket modern books like Heschel or Soloveitchik — cite those in plain text.`;

const COMMENTARY_PROMPT = `${PERSONA}

Read this article carefully.

Respond with ONLY a valid JSON object (no markdown fences, no preamble):
{
  "headline": "<one clear sentence: what is this article about?>",
  "commentary": "<A flowing interpretive essay of 3 paragraphs, separated by \\n\\n. Paragraph 1: 'This text is about…' — summarize the core human situation at stake, beneath the surface facts. Paragraph 2: 'Jewish philosophy would draw an analogy with…' — pick 1-2 SPECIFIC narratives or precedents from Jewish sources (a biblical story, a Talmudic episode or dispute, a historical moment like the destruction of the Temple, a famous responsum) and develop the parallel explicitly: who plays which role, where the analogy holds, where it breaks down. Cite the sources inline with double brackets per the citation rule. Paragraph 3: what the tradition would conclude or advise here, and where different Jewish voices would disagree with each other. Write as a thoughtful rabbinic commentator, in accessible prose — no bullet points, no jargon without explanation. Keep the whole essay under 350 words.>",
  "jewish_lens": "<2-3 sentences: how Jewish tradition as a whole approaches this type of situation — cite specific thinkers or texts>"
}`;

const TOPICS_PROMPT = `${PERSONA}

Read this article carefully. Identify exactly 3 Jewish philosophical, ethical, or spiritual concepts that illuminate the specific situation described.

Respond with ONLY a valid JSON object (no markdown fences, no preamble):
{
  "topics": [
    {
      "concept": "<Jewish ethical/philosophical concept name in English>",
      "hebrew": "<Hebrew or Aramaic term — or empty string if none>",
      "relevance": "<4-5 sentences: how this concept applies concretely to the article's events, its historical and theological background, how classical authorities understood it, and how modern Jewish thinkers have applied it. Cite classical sources inline with double brackets per the citation rule.>",
      "sources": "<2-3 specific citations, classical ones in double brackets, e.g. '[[Sanhedrin 37a]]; [[Mishneh Torah, Human Dispositions 6:3]]; Abraham Joshua Heschel, The Prophets (1962), ch. 1'>",
      "sefaria_query": "<3-5 English keywords to find relevant Talmud/Torah/commentary passages>"
    }
  ]
}

Each topic must be deeply and specifically connected to what is described in the article — not generic wisdom.`;

function getApiKey() {
  try { if (typeof Netlify !== 'undefined' && Netlify.env) return Netlify.env.get('ANTHROPIC_API_KEY'); } catch {}
  try { return Deno.env.get('ANTHROPIC_API_KEY'); } catch {}
  return undefined;
}

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

const jsonHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: jsonHeaders });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: jsonHeaders });
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured on the server.' }), { status: 500, headers: jsonHeaders });
  }

  let url, text, filename, part;
  try {
    ({ url, text, filename, part } = await request.json());
    if (!url && !text) throw new Error();
  } catch {
    return new Response(JSON.stringify({ error: 'Please provide a valid URL or PDF.' }), { status: 400, headers: jsonHeaders });
  }

  let title = '';
  let articleText = '';

  try {
    if (text) {
      title = filename ? filename.replace(/\.pdf$/i, '') : 'PDF Document';
      articleText = text.slice(0, 15000);
    } else {
      const articleRes = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(10000)
      });
      if (!articleRes.ok) throw new Error('Could not fetch the article. The site may block automated access — try saving it as PDF instead.');
      const html = await articleRes.text();
      const { title: t, description, body } = extractContent(html);
      title = t;
      articleText = [t, description, body].filter(Boolean).join('\n\n');
    }

    if (articleText.trim().length < 100) throw new Error('Could not extract enough content from this document.');
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Could not read the document.' }), { status: 500, headers: jsonHeaders });
  }

  // Two lightweight parts run as separate requests so each fits the edge time limit:
  // "commentary" (Sonnet, the deep essay) and "topics" (Haiku, fast structured cards)
  const isTopics = part === 'topics';
  const prompt = isTopics ? TOPICS_PROMPT : COMMENTARY_PROMPT;
  const model  = isTopics ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-5';

  const anthRes = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: isTopics ? 2500 : 3000,
      stream: true,
      messages: [{ role: 'user', content: `${prompt}\n\nArticle:\n---\n${articleText}\n---` }]
    })
  });

  if (!anthRes.ok) {
    const errText = await anthRes.text();
    return new Response(JSON.stringify({ error: `Claude API error: ${anthRes.status} — ${errText.slice(0, 300)}` }), { status: 500, headers: jsonHeaders });
  }

  // Pipe Anthropic's SSE stream through as plain text deltas.
  // Protocol: first line is a JSON meta object, then raw text chunks follow.
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify({ title }) + '\n'));
      const reader = anthRes.body.getReader();
      let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6);
            try {
              const ev = JSON.parse(payload);
              if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) {
                controller.enqueue(encoder.encode(ev.delta.text));
              }
            } catch {}
          }
        }
      } catch {}
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    }
  });
};

export const config = { path: '/api/analyze' };
