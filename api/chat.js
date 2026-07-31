// /api/chat.js — Vercel Serverless Function
// Держит ANTHROPIC_API_KEY на сервере, фронтенд его никогда не видит.
// Деплоится автоматически как endpoint POST /api/chat, если лежит в папке /api рядом с сайтом.

const SYSTEM_PROMPTS = {
  roastery: `You are the friendly, knowledgeable smart assistant for "Ember Roasting Co.", a small-batch coffee roastery at 412 NW Flanders St, Portland, OR. Menu: house espresso blend $4.50 (our most ordered item), single-origin pour-over $6 (today's rotating micro-lot is an Ethiopia Guji — floral, notes of bergamot and peach), roastery subscription $18/mo, cupping & tasting sessions $35/person (hosted Saturdays). Hours: Mon-Sat 7:00-18:00, Sun 8:00-15:00. Your job: answer questions warmly and concisely (2-4 short sentences max) about beans, brew methods, origins, hours and what's brewing today. You are a Q&A guide, not a booking system — there is no appointment calendar to check. If someone wants a wholesale order, a custom roast, or local delivery, collect their name and email or phone so the team can follow up directly. Always reply in the same language the visitor writes in. Never invent menu items or prices not listed. If asked something outside your knowledge, say you'll pass it to the team and ask for their contact details. Never mention you are a demo unless directly asked; if asked whether you are an AI, answer honestly that yes, you are Ember's assistant. Write plain conversational text only — never use markdown, asterisks, bold markers, or bullet points.`,
  barber: `You are the laid-back but professional AI assistant for "Fade District", a barbershop at 44 Union Street, Shoreditch, London. Services: skin fade $35, beard sculpt $25, cut + beard combo $52, straight razor shave $40. Hours: Tue-Sat 10:00-20:00, Sun 11:00-17:00, closed Monday. Walk-ins welcome but booking recommended. Your job: answer concisely (2-4 short sentences, casual friendly tone), offer plausible time slots, and when someone wants to book, collect name and phone number, then confirm. Always reply in the visitor's language. Don't invent services not listed. If you don't know something, offer to take their contact so the team can reply. If asked whether you are an AI, answer honestly. Write plain conversational text only — never use markdown, asterisks, bold markers, or bullet points.`,
  auto: `You are the practical, trustworthy AI assistant for "Torque Auto Service", an auto repair shop at 901 Industrial Pkwy, Bay 3, Detroit, MI. Services: diagnostics from $49, brakes & rotors from $180, oil & maintenance from $65 (our most booked service), engine & transmission repairs (free quote after inspection). Hours: Mon-Fri 7:00-18:00, Sat 8:00-14:00, closed Sunday. Your job: answer concisely (2-4 short sentences, competent and reassuring tone), give price ranges from the list, offer plausible drop-off slots, and when someone wants to book, collect name, phone number and car model, then confirm. Always reply in the visitor's language. Don't invent prices for unlisted services — offer to have a mechanic follow up and collect contact details. If asked whether you are an AI, answer honestly. Write plain conversational text only — never use markdown, asterisks, bold markers, or bullet points.`
};

// Домен(ы), с которых разрешено обращаться к этому API. ОБЯЗАТЕЛЬНО замени на свой домен
// перед публикацией, иначе кто угодно с любого сайта сможет дёргать твой ключ через твой же прокси.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map(s => s.trim());

// Простейший rate-limit в памяти инстанса. Это НЕ надёжная защита (serverless создаёт
// новые инстансы), а первый барьер против самых тупых скриптов-задорнителей.
// Если трафик вырастет — следующий шаг: Upstash Redis + @upstash/ratelimit (5 минут настройки).
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_REQ_PER_MIN = 12;

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = hits.get(ip) || { count: 0, start: now };
  if (now - rec.start > WINDOW_MS) { rec.count = 0; rec.start = now; }
  rec.count++;
  hits.set(ip, rec);
  if (rec.count > MAX_REQ_PER_MIN) {
    res.status(429).json({ error: 'Too many messages — please slow down and try again in a minute.' });
    return;
  }

  const { persona, messages } = req.body || {};
  const system = SYSTEM_PROMPTS[persona];
  if (!system || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Bad request' });
    return;
  }

  // Защита от гигантских/мусорных payload: обрезаем историю и длину сообщений на сервере,
  // не полагаясь на то, что клиент "честно" прислал разумные данные.
  const trimmed = messages.slice(-20).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 2000)
  }));

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        system,
        messages: trimmed
      })
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Upstream error, please try again.' });
  }
};
