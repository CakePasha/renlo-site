// /api/audit.js — Vercel Serverless Function
// Принимает данные формы Free Audit и сразу отправляет их тебе на почту.
// Заявка доходит гарантированно в момент нажатия кнопки на сайте —
// посетителю не нужно ничего подтверждать в своём приложении.

const nodemailer = require('nodemailer');

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map(s => s.trim());

// Тот же простой rate-limit, что и в chat.js — защита от спам-скриптов на форму.
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_REQ_PER_MIN = 5;

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
    res.status(429).json({ error: 'Too many requests — please try again in a minute.' });
    return;
  }

  const { name, contact, business, site, pain } = req.body || {};
  if (!name || !contact || !business) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  // Обрезаем длину полей на сервере — защита от мусорных гигантских payload
  const clean = s => String(s || '').slice(0, 500);
  const contactLooksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(contact).trim());

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.GMAIL_USER,
      replyTo: contactLooksLikeEmail ? clean(contact).trim() : undefined,
      subject: `Free Audit request — ${clean(business)}`,
      text: `New free audit request from the website.

Name: ${clean(name)}
Contact (email/WhatsApp): ${clean(contact)}
Business: ${clean(business)}
Current website: ${clean(site) || '—'}
Biggest frustration: ${clean(pain) || '—'}`
    });

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'Could not send right now, please try again.' });
  }
};
