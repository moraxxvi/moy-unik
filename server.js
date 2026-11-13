/**
 * Мой уник — запуск на компе.
 * Своей логики тут нет: этот файл запускает Code.gs (тот же код, что работает в Google)
 * и подменяет ему сервисы Google на местные: запросы в интернет и хранилище настроек.
 * Маркер Canvas лежит в canvas-token.txt и никуда, кроме Canvas, не уходит.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const PORT = 8787;
const TOKEN_FILE = path.join(__dirname, 'canvas-token.txt');
const PROPS_FILE = path.join(__dirname, 'local-props.json');
const ALLOWED = ['getData', 'saveToken', 'forgetToken', 'tgStatus', 'saveSettings'];

// --- Хранилище настроек вместо PropertiesService ---
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
const store = {
  getProperty(key) {
    if (key === 'CANVAS_TOKEN') {
      try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null; } catch { return null; }
    }
    const value = readJson(PROPS_FILE)[key];
    return value == null ? null : value;
  },
  setProperty(key, value) {
    if (key === 'CANVAS_TOKEN') return fs.writeFileSync(TOKEN_FILE, value + '\n', { mode: 0o600 });
    const all = readJson(PROPS_FILE);
    all[key] = String(value);
    fs.writeFileSync(PROPS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  },
  deleteProperty(key) {
    if (key === 'CANVAS_TOKEN') return fs.rmSync(TOKEN_FILE, { force: true });
    if (!fs.existsSync(PROPS_FILE)) return;
    const all = readJson(PROPS_FILE);
    delete all[key];
    fs.writeFileSync(PROPS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  },
};

// --- Запросы в интернет вместо UrlFetchApp ---
// Code.gs ждёт ответ сразу (без await), поэтому запросы выполняет отдельный процесс, а мы ждём его целиком.
const WORKER = `
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', async () => {
  const out = await Promise.all(JSON.parse(input).map(async (r) => {
    try {
      const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
      return { code: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
    } catch (e) {
      return { code: 0, headers: {}, body: '' };
    }
  }));
  process.stdout.write(JSON.stringify(out));
});`;

function fetchAll(requests) {
  const input = requests.map((r) => ({
    url: r.url,
    method: String(r.method || 'get').toUpperCase(),
    headers: Object.assign({}, r.headers, r.contentType ? { 'Content-Type': r.contentType } : {}),
    body: r.payload,
  }));
  const run = spawnSync(process.execPath, ['-e', WORKER], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return JSON.parse(run.stdout).map((r) => {
    if (!r.code) throw new Error('network');
    return { getResponseCode: () => r.code, getContentText: () => r.body, getHeaders: () => r.headers };
  });
}

const noTrigger = { timeBased: () => noTrigger, everyHours: () => noTrigger, create: () => {} };

function callGas(name, arg) {
  // Каждый вызов читает Code.gs заново, поэтому правки подхватываются без перезапуска.
  const sandbox = vm.createContext({
    console,
    UrlFetchApp: { fetch: (url, opts) => fetchAll([Object.assign({ url }, opts)])[0], fetchAll },
    PropertiesService: { getUserProperties: () => store },
    Utilities: { getUuid: () => require('crypto').randomUUID() },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: () => noTrigger }, // расписаний на компе нет
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), sandbox, { filename: 'Code.gs' });
  return vm.runInContext(name, sandbox)(arg);
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10000) reject(new Error('too big'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const LOCAL = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];

const server = http.createServer(async (req, res) => {
  // Пускаем только запросы с этого же компа и с этой же страницы.
  const origin = req.headers.origin;
  if (!LOCAL.includes(req.headers.host) || (origin && !LOCAL.includes(origin.replace(/^https?:\/\//, '')))) {
    return send(res, 403, { error: 'forbidden' });
  }
  try {
    if (req.method === 'GET' && req.url.split('?')[0] === '/') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'POST' && req.url === '/api/call') {
      const { name, arg } = JSON.parse(await readBody(req));
      if (!ALLOWED.includes(name)) return send(res, 404, { error: 'not found' });
      return send(res, 200, callGas(name, arg));
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err.message);
    send(res, 502, { error: 'network' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Мой уник запущен: http://localhost:${PORT}`);
});
