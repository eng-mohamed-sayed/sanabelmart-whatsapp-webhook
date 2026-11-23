// Vercel serverless webhook for the WhatsApp Cloud API.
// Same behaviour as server.js: GET /webhook verifies, POST /webhook replies
// once (TEST_ONE_SHOT) with the approved welcome text.
// Note: serverless functions are stateless, so the one-shot flag is
// in-memory only and resets on a cold start. That is fine for the test:
// Meta retries are de-duplicated by message id within a warm instance.
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '451419464730914';
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
const TEST_ONE_SHOT = process.env.TEST_ONE_SHOT === 'true';
const AUTO_REPLY_TEXT =
  process.env.AUTO_REPLY_TEXT ||
  'أهلاً بحضرتك، مع حضرتك Eng Mohamed Sayed، مكتب تصميم هندسي. بنقدم تصميم معماري، تصميم داخلي، تراخيص، وإشراف على التنفيذ. تحب أساعد حضرتك في إيه؟';

const seen = new Set();
let alreadyReplied = false;

async function sendWhatsAppMessage(to, text) {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: text },
      }),
    },
  );
  if (!res.ok) throw new Error(`Graph API ${res.status}: ${await res.text()}`);
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'https://localhost');
  if (req.method === 'GET' && url.pathname === '/webhook') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      res.status(200).send(challenge || '');
    } else {
      res.status(403).send('Verification failed');
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    res.status(200).json({ ok: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/webhook') {
    res.status(200).send('EVENT_RECEIVED');
    // Vercel may hand req.body to the function as a raw string, not a
    // parsed object. Parse it here, otherwise payload.object is
    // undefined and every real message is silently ignored.
    let payload = {};
    try {
      if (typeof req.body === 'string' && req.body) {
        payload = JSON.parse(req.body);
      } else if (req.body && typeof req.body === 'object') {
        payload = req.body;
      }
    } catch (err) {
      console.error('Failed to parse webhook body:', err.message);
      return;
    }
    console.log('Webhook payload object:', payload.object);
    if (payload.object !== 'whatsapp_business_account') return;
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const message of value.messages || []) {
          console.log('Incoming message:', message.from, message.type, message.id);
          if (message.type !== 'text' || !message.from) continue;
          if (seen.has(message.id)) continue;
          seen.add(message.id);
          if (TEST_ONE_SHOT && alreadyReplied) continue;
          try {
            await sendWhatsAppMessage(message.from, AUTO_REPLY_TEXT);
            if (TEST_ONE_SHOT) alreadyReplied = true;
          } catch (err) {
            console.error('Failed to reply:', err.message);
          }
        }
      }
    }
    return;
  }
  res.status(404).send('Not found');
};
