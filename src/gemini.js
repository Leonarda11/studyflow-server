const unavailableMessage =
  'AI trenutno nije dostupan. Dosegnut je privremeni limit AI usluge. Pokušajte ponovno kasnije.';

export class AiUnavailableError extends Error {
  constructor(message = unavailableMessage) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

export async function generateGeminiJson({ prompt, file }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new AiUnavailableError();
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const parts = [{ text: prompt }];
  if (file) parts.push({ inlineData: { mimeType: file.mimeType, data: file.base64 } });

  let response;
  const startedAt = Date.now();
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseMimeType: 'application/json' }
        }),
        signal: AbortSignal.timeout(45000)
      }
    );
  } catch {
    throw new AiUnavailableError();
  }
  // Vrijeme obrade Gemini poziva (ms) — koristi se za mjerenje performansi pri evaluaciji AI funkcionalnosti.
  console.log(
    `[gemini] ${model} odgovorio za ${Date.now() - startedAt}ms (status ${response.status})`
  );
  if (!response.ok) throw new AiUnavailableError();
  const body = await response.json();
  const text = body.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('');
  if (!text) throw new AiUnavailableError('AI trenutno nije dostupan. Pokušajte ponovno kasnije.');
  try {
    return JSON.parse(text);
  } catch {
    throw new AiUnavailableError('AI nije vratio ispravan rezultat. Pokušajte ponovno kasnije.');
  }
}
