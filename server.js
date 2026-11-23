// Sanabelmart WhatsApp Cloud API webhook — prepared 2026-11-23
// No secrets are hard-coded here. All credentials come from environment
// variables, set at deploy time. The permanent token is stored separately
// in the secure WhatsApp Cloud API connector, not in this file.
//
// Meta setup already done:
//   App: Sanabelmart Auto Reply (1139708258803994)
//   WABA: Kanyon Work Space (519187307934567)
//   Phone: +20 10 44690205, phone number ID 451419464730914
//   System User: SanabelmartAutoReply (61596715507548), permanent token,
//     permissions: whatsapp_business_messaging, whatsapp_business_management
//
// Still needed before going live:
//   1. The permanent token — DONE and verified 2026-11-23 21:11 EET.
//      It is stored in the secure custom.whatsapp-cloud-api connector.
//      For local testing, the token value is passed in WHATSAPP_TOKEN
//      at run time only, never written to a file.
//   2. A public HTTPS host for this server, and its URL entered as the
//      webhook callback URL in the Meta app (WhatsApp > Configuration),
//      subscribed to the `messages` field, with the same VERIFY_TOKEN.
//      For the first-message test this is a temporary Cloudflare tunnel.
//   3. Mohamed's business details (what customers usually ask, reply
//      rules) to replace the placeholder AUTO_REPLY_TEXT below.
//
// TEST MODE (2026-11-23, per Mohamed): TEST_ONE_SHOT=true means reply
// only to the very first incoming text message, then ignore later ones.
// The replied flag is persisted in REPLY_STATE_FILE so a restart does
// not reply a second time.

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '451419464730914';
const APP_SECRET = process.env.APP_SECRET || '';
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
const TEST_ONE_SHOT = process.env.TEST_ONE_SHOT === 'true';
const REPLY_STATE_FILE =
  process.env.REPLY_STATE_FILE || '.test-replied.json';
// Approved welcome reply (2026-11-23, Mohamed approved):
// Engineering design office — architectural design, interior design,
// licenses/permits, supervision. Signed Eng Mohamed Sayed.
const AUTO_REPLY_TEXT =
  process.env.AUTO_REPLY_TEXT ||
  'أهلاً بحضرتك، مع حضرتك Eng Mohamed Sayed، مكتب تصميم هندسي. بنقدم تصميم معماري، تصميم داخلي، تراخيص، وإشراف على التنفيذ. تحب أساعد حضرتك في إيه؟';

const seenMessageIds = new Set();
let testAlreadyReplied = false;
try {
  const state = JSON.parse(fs.readFileSync(REPLY_STATE_FILE, 'utf8'));
  testAlreadyReplied = state.replied === true;
} catch {
  testAlreadyReplied = false;
}
function persistTestReplied() {
  try {
    fs.writeFileSync(
      REPLY_STATE_FILE,
      JSON.stringify({ replied: true, at: new Date().toISOString() }),
    );
  } catch (err) {
    console.error('Could not persist test-replied state:', err.message);
  }
}

function verifySignature(rawBody, signatureHeader) {
  if (!APP_SECRET) {
    console.warn('APP_SECRET is not set — skipping X-Hub-Signature-256 check');
    return true;
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = crypto
    .createHmac('sha256', APP_SECRET)
    .update(rawBody)
    .digest('hex');
  const given = signatureHeader.slice('sha256='.length);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendWhatsAppMessage(to, text) {
  return new Promise((resolve, reject) => {
    if (!WHATSAPP_TOKEN) {
      reject(new Error('WHATSAPP_TOKEN is not set'));
      return;
    }
    const payload = JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    });
    const req = https.request(
      {
        hostname: 'graph.facebook.com',
        path: `/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`Graph API ${res.statusCode}: ${body}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function markRead(messageId) {
  return new Promise((resolve) => {
    if (!WHATSAPP_TOKEN) return resolve();
    const payload = JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
    const req = https.request(
      {
        hostname: 'graph.facebook.com',
        path: `/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', () => resolve());
    req.write(payload);
    req.end();
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Meta webhook verification (GET)
  if (req.method === 'GET' && url.pathname === '/webhook') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(challenge || '');
    } else {
      res.writeHead(403);
      res.end('Verification failed');
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Incoming WhatsApp events (POST)
  if (req.method === 'POST' && url.pathname === '/webhook') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks);
      // Always answer Meta quickly; do the reply work after responding.
      res.writeHead(200);
      res.end('EVENT_RECEIVED');
      if (!verifySignature(rawBody, req.headers['x-hub-signature-256'])) {
        console.error('Rejected webhook: bad X-Hub-Signature-256');
        return;
      }
      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch (err) {
        console.error('Rejected webhook: invalid JSON', err.message);
        return;
      }
      if (payload.object !== 'whatsapp_business_account') return;
      for (const entry of payload.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value || {};
          for (const message of value.messages || []) {
            if (message.type !== 'text' || !message.from) continue;
            if (seenMessageIds.has(message.id)) continue;
            seenMessageIds.add(message.id);
            if (TEST_ONE_SHOT && testAlreadyReplied) {
              console.log(
                `Test one-shot: ignoring message ${message.id} from ${message.from}, already replied to the first one`,
              );
              continue;
            }
            try {
              await markRead(message.id);
              await sendWhatsAppMessage(message.from, AUTO_REPLY_TEXT);
              console.log(`Replied to ${message.from} (message ${message.id})`);
              if (TEST_ONE_SHOT) {
                testAlreadyReplied = true;
                persistTestReplied();
              }
            } catch (err) {
              console.error(`Failed to reply to ${message.from}:`, err.message);
            }
          }
        }
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`WhatsApp webhook listening on port ${PORT}`);
  if (!VERIFY_TOKEN) console.warn('VERIFY_TOKEN is not set');
  if (!WHATSAPP_TOKEN) console.warn('WHATSAPP_TOKEN is not set');
});
