// Generates a large test session log (2 hours worth of events)
// Writes a plaintext JSON to test/fixtures and an encrypted integrity.log
// to the workspace .vscode/logs folder using the same encryption
// parameters as StorageManager (so the extension can open it with
// the default password `password`).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_PASSPHRASE = 'password';
const SALT = 'salty_buffer_tbd';
const KEY = crypto.scryptSync(SECRET_PASSPHRASE, SALT, 32);
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

function formatISO(ts) {
  return new Date(ts).toISOString();
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sampleText(words) {
  const w = ['function','variable','const','let','return','if','else','class','component','render','async','await','console.log','import','export','test','expect','describe','it','useEffect','state','props','hook','ref','map','filter','reduce','Promise','resolve','reject','handler'];
  let out = [];
  for (let i=0;i<words;i++) out.push(w[Math.floor(Math.random()*w.length)]);
  return out.join(' ');
}

function generateEvents(durationMs) {
  const events = [];
  let now = Date.now();
  const start = now;
  let lastTs = now;
  while (now - start < durationMs) {
    // Step forward a small random interval (5-30s)
    const step = randomInt(5, 30) * 1000;
    now += step;
    const evTypeRoll = Math.random();
    let ev = { time: formatISO(now), flightTime: String(step), eventType: 'typing' };
    if (evTypeRoll < 0.55) {
      // typing burst
      ev.eventType = 'keystroke';
      ev.keys = randomInt(1, 20);
      ev.textFragment = sampleText(randomInt(3,10));
    } else if (evTypeRoll < 0.7) {
      ev.eventType = 'paste';
      ev.pastedLength = randomInt(5, 200);
      ev.pastePreview = sampleText(Math.min(50, Math.floor(ev.pastedLength/3)));
    } else if (evTypeRoll < 0.78) {
      ev.eventType = 'delete';
      ev.deletedChars = randomInt(1, 40);
    } else if (evTypeRoll < 0.9) {
      ev.eventType = 'ai-assist';
      ev.aiProvider = (Math.random()<0.5)?'copilot':'chatgpt';
      ev.prompt = sampleText(randomInt(5,20));
      ev.generatedSummary = sampleText(randomInt(10,40));
    } else if (evTypeRoll < 0.95) {
      ev.eventType = 'fileView';
      ev.file = `/workspace/src/${['app.ts','index.tsx','utils.ts','component.jsx'][Math.floor(Math.random()*4)]}`;
    } else {
      ev.eventType = 'save';
      ev.file = `/workspace/src/${['app.ts','index.tsx','utils.ts','component.jsx'][Math.floor(Math.random()*4)]}`;
    }
    events.push(ev);
    lastTs = now;
  }
  return events;
}

function buildSession() {
  const twoHours = 2 * 60 * 60 * 1000;
  const startTs = Date.now() - twoHours;
  const header = {
    sessionHeader: {
      sessionNumber: 1,
      startedBy: 'developer',
      project: 'devproject',
      startTime: formatISO(startTs),
      metadata: { vscodeVersion: 'test', startTimestamp: formatISO(startTs), extensionVersion: '0.0.0-test' }
    }
  };
  const events = generateEvents(twoHours);
  return Object.assign({}, header, { events });
}

function encryptBuffer(buf) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, encrypted]);
}

function writeFiles() {
  const session = buildSession();
  const plain = JSON.stringify(session, null, 2);

  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
  const plainPath = path.join(fixturesDir, 'test_session_plain.json');
  fs.writeFileSync(plainPath, plain, 'utf8');
  console.log('Wrote plaintext session to', plainPath);

  // Write encrypted file to workspace .vscode/logs
  const workspaceLogs = path.join(process.cwd(), '.vscode', 'logs');
  if (!fs.existsSync(workspaceLogs)) fs.mkdirSync(workspaceLogs, { recursive: true });
  const filename = 'developer-devproject-Session1-integrity.log';
  const outPath = path.join(workspaceLogs, filename);
  const enc = encryptBuffer(Buffer.from(plain, 'utf8'));
  fs.writeFileSync(outPath, enc);
  console.log('Wrote encrypted session to', outPath);
}

writeFiles();

console.log('Done. To regenerate, run: node test/scripts/generate_test_log.js');
