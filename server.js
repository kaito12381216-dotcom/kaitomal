#!/usr/bin/env node
/**
 * Grand-Master Mail — Node.js バックエンドサーバー
 *
 * 使い方:
 *   node server.js
 *   → ブラウザで http://localhost:8888 を開く
 *
 * 必要なもの: Node.js 16以上（追加パッケージ不要）
 */

'use strict';

const tls  = require('tls');
const net  = require('net');
const http = require('http');
const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────
//  設定（ここを書き換えてください）
// ─────────────────────────────────────
const CONFIG = {
  imap: {
    host:     'imap.nifty.com',   // Gmail以外: imap.mail.yahoo.co.jp など
    port:     993,
    tls:      true,               // SSL/TLS を使う（通常 true）
  },
  email:    'fnic@nifty.com',                   // 例: grandmaster@gmail.com
  password: 'ua2uyns7',                   // Gmailはアプリパスワード（16桁）
  fetchLimit: 50,                 // 取得する最新メール件数
  port: process.env.PORT,                   // ブラウザからアクセスするポート
};
// ─────────────────────────────────────

// AI分類ルール（差出人アドレスの正規表現で判定）
const RULES = [
  { tag: 'm3',     re: /m3\.com/i,                              label: '🏥 M3'      },
  { tag: 'sw',     re: /googlegroups\.com/i,                    label: '🎓 からたち' },
  { tag: 'office', re: /amazon|rakuten|mufg|noreply|no-reply/i, label: '📋 事務'    },
];

const IMPORTANT_KW = ['重要','緊急','至急','満期','同窓会','訃報','ご案内','お知らせ'];

// ─── IMAP クライアント（built-in のみ） ───────────────────────────

class ImapClient {
  constructor(host, port, useTls) {
    this.host   = host;
    this.port   = port;
    this.useTls = useTls;
    this.sock   = null;
    this.buf    = '';
    this.tag    = 0;
    this.waiters = new Map(); // tag → resolve/reject
    this.untagged = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const opts = { host: this.host, port: this.port };
      const onConnect = () => {
        this.sock.setEncoding('utf8');
        this.sock.on('data', d => this._onData(d));
        this.sock.on('error', e => reject(e));
        // Wait for server greeting
        const gTimer = setTimeout(() => reject(new Error('Greeting timeout')), 10000);
        this.sock.once('data', () => { clearTimeout(gTimer); resolve(); });
      };
      if (this.useTls) {
        this.sock = tls.connect({ ...opts, rejectUnauthorized: false }, onConnect);
      } else {
        this.sock = net.connect(opts, onConnect);
      }
      this.sock.on('error', reject);
    });
  }

  _onData(data) {
    this.buf += data;
    let lines = this.buf.split('\r\n');
    this.buf  = lines.pop(); // 未完成行を保持
    for (const line of lines) {
      const m = line.match(/^([A-Z]\d+)\s+(OK|NO|BAD)\s*(.*)/i);
      if (m) {
        const [, t, status, text] = m;
        const w = this.waiters.get(t);
        if (w) {
          this.waiters.delete(t);
          status === 'OK' ? w.resolve(this.untagged.splice(0)) : w.reject(new Error(text));
        }
      } else {
        this.untagged.push(line);
      }
    }
  }

  _cmd(str) {
    return new Promise((resolve, reject) => {
      const t = `A${String(++this.tag).padStart(4,'0')}`;
      this.waiters.set(t, { resolve, reject });
      this.sock.write(`${t} ${str}\r\n`);
      setTimeout(() => {
        if (this.waiters.has(t)) {
          this.waiters.delete(t);
          reject(new Error('IMAP command timeout: ' + str.split(' ')[0]));
        }
      }, 20000);
    });
  }

  async login(user, pass) {
    await this._cmd(`LOGIN "${user}" "${pass}"`);
  }

  async select(mailbox = 'INBOX') {
    const lines = await this._cmd(`SELECT "${mailbox}"`);
    const existsLine = lines.find(l => /\d+ EXISTS/.test(l));
    const m = existsLine && existsLine.match(/(\d+) EXISTS/);
    return m ? parseInt(m[1]) : 0;
  }

  async search(criteria = 'ALL') {
    const lines = await this._cmd(`SEARCH ${criteria}`);
    const line  = lines.find(l => /^\* SEARCH/.test(l)) || '';
    const nums  = line.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean);
    return nums.map(Number).filter(n => !isNaN(n));
  }

  // fetch (RFC822 + FLAGS) for a sequence set
  async fetch(seqSet) {
    const lines = await this._cmd(`FETCH ${seqSet} (FLAGS RFC822)`);
    return lines;
  }

  logout() {
    try { this._cmd('LOGOUT'); } catch(_) {}
    try { this.sock.destroy(); } catch(_) {}
  }
}

// ─── メール解析ユーティリティ ───────────────────────────────────

function decodeMimeWord(str) {
  if (!str) return '';
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      let buf;
      if (enc.toUpperCase() === 'B') {
        buf = Buffer.from(text, 'base64');
      } else {
        const qp = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, h) =>
          String.fromCharCode(parseInt(h, 16))
        );
        buf = Buffer.from(qp, 'binary');
      }
      return buf.toString(charset.toLowerCase().replace('iso-2022-jp','iso2022jp').replace('shift_jis','sjis') || 'utf8');
    } catch { return text; }
  });
}

function parseHeaders(raw) {
  const headers = {};
  const lines = raw.split(/\r?\n/);
  let current = '';
  for (const line of lines) {
    if (!line) break;
    if (/^\s/.test(line)) { current += ' ' + line.trim(); continue; }
    if (current) {
      const idx = current.indexOf(':');
      if (idx > 0) {
        const k = current.slice(0, idx).toLowerCase().trim();
        const v = current.slice(idx + 1).trim();
        headers[k] = headers[k] ? headers[k] + '\n' + v : v;
      }
    }
    current = line;
  }
  if (current) {
    const idx = current.indexOf(':');
    if (idx > 0) {
      const k = current.slice(0, idx).toLowerCase().trim();
      headers[k] = current.slice(idx + 1).trim();
    }
  }
  return headers;
}

function parseAddress(str) {
  if (!str) return { name: '', addr: '' };
  str = decodeMimeWord(str);
  const m = str.match(/^(.*?)<([^>]+)>/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g,''), addr: m[2].trim() };
  return { name: '', addr: str.trim() };
}

function decodeBody(raw, charset = 'utf-8', encoding = '') {
  try {
    let buf;
    const enc = encoding.toLowerCase().trim();
    if (enc === 'base64') {
      buf = Buffer.from(raw.replace(/\s/g,''), 'base64');
    } else if (enc === 'quoted-printable') {
      const qp = raw
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      buf = Buffer.from(qp, 'binary');
    } else {
      buf = Buffer.from(raw, 'binary');
    }
    const cs = charset.toLowerCase().replace(/-/g,'');
    if (cs === 'iso2022jp' || cs === 'iso2022jp') {
      // Fallback: try utf8 first
      return buf.toString('utf8');
    }
    return buf.toString('utf8');
  } catch { return raw; }
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// RFC822メッセージをパース（マルチパート対応・簡易版）
function parseMessage(raw) {
  const sepIdx = raw.indexOf('\r\n\r\n');
  if (sepIdx < 0) return { headers: {}, text: raw };
  const headerRaw = raw.slice(0, sepIdx);
  const bodyRaw   = raw.slice(sepIdx + 4);
  const headers   = parseHeaders(headerRaw);
  const ct        = headers['content-type'] || '';
  const ce        = headers['content-transfer-encoding'] || '';

  // マルチパート
  const boundaryM = ct.match(/boundary="?([^";]+)"?/i);
  if (boundaryM) {
    const boundary = boundaryM[1];
    const parts = bodyRaw.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:--)?`));
    let textPlain = '', textHtml = '';
    for (const part of parts) {
      if (!part.trim() || part.trim() === '--') continue;
      const subSep = part.indexOf('\r\n\r\n');
      if (subSep < 0) continue;
      const subHeaders = parseHeaders(part.slice(0, subSep));
      const subBody    = part.slice(subSep + 4);
      const subCt  = subHeaders['content-type'] || '';
      const subCe  = subHeaders['content-transfer-encoding'] || '';
      const csM    = subCt.match(/charset="?([^";]+)"?/i);
      const cs     = csM ? csM[1] : 'utf-8';
      if (/text\/plain/i.test(subCt) && !textPlain) {
        textPlain = decodeBody(subBody, cs, subCe);
      } else if (/text\/html/i.test(subCt) && !textHtml) {
        textHtml = decodeBody(subBody, cs, subCe);
      }
    }
    return { headers, text: textPlain || stripHtml(textHtml) || '' };
  }

  // シングルパート
  const csM = ct.match(/charset="?([^";]+)"?/i);
  const cs  = csM ? csM[1] : 'utf-8';
  let text  = decodeBody(bodyRaw, cs, ce);
  if (/text\/html/i.test(ct)) text = stripHtml(text);
  return { headers, text };
}

// ─── 振り分けロジック ─────────────────────────────────────────

function classify(fromAddr, subject) {
  const tags = [];
  for (const rule of RULES) {
    if (rule.re.test(fromAddr)) { tags.push(rule.tag); break; }
  }
  if (IMPORTANT_KW.some(kw => subject.includes(kw))) tags.push('important');
  if (!tags.length) tags.push('office');
  return tags;
}

// ─── IMAP FETCH レスポンス解析 ────────────────────────────────

function extractMessages(lines) {
  /**
   * IMAP FETCH レスポンスは以下の形式:
   * * N FETCH (FLAGS (\Seen) RFC822 {size}
   * <raw message>
   * )
   * 複数メッセージがあれば繰り返す
   */
  const messages = [];
  const joined = lines.join('\r\n');
  // RFC822 の literal を抽出する
  const msgRegex = /\* (\d+) FETCH \(FLAGS \(([^)]*)\) RFC822 \{(\d+)\}\r?\n([\s\S]*?)(?=\r?\n\* \d+ FETCH|\r?\nA\d+|$)/g;
  let match;
  while ((match = msgRegex.exec(joined)) !== null) {
    const seqNum = parseInt(match[1]);
    const flags  = match[2];
    const size   = parseInt(match[3]);
    const raw    = match[4].slice(0, size);
    messages.push({ seqNum, flags, raw });
  }
  return messages;
}

// ─── メール取得メイン ─────────────────────────────────────────

async function fetchMails() {
  if (!CONFIG.email || !CONFIG.password) {
    return { error: 'config', message: 'server.js の email と password を設定してください' };
  }

  const client = new ImapClient(CONFIG.imap.host, CONFIG.imap.port, CONFIG.imap.tls);

  try {
    console.log(`  → ${CONFIG.imap.host}:${CONFIG.imap.port} に接続中...`);
    await client.connect();

    console.log(`  → ログイン中 (${CONFIG.email})...`);
    await client.login(CONFIG.email, CONFIG.password);

    const total = await client.select('INBOX');
    console.log(`  → 受信トレイ: ${total}件`);

    // 最新 N 件の ID を取得
    const allIds = await client.search('ALL');
    const ids    = allIds.slice(-CONFIG.fetchLimit).reverse(); // 新しい順
    if (!ids.length) { client.logout(); return { mails: [], count: 0, account: CONFIG.email }; }

    // バッチ取得（10件ずつ）
    const mails = [];
    const batchSize = 10;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const seqSet = batch.join(',');
      const lines  = await client.fetch(seqSet);
      const msgs   = extractMessages(lines);

      for (const { seqNum, flags, raw } of msgs) {
        try {
          const { headers, text } = parseMessage(raw);

          const subjectRaw = decodeMimeWord(headers['subject'] || '(件名なし)');
          const fromRaw    = decodeMimeWord(headers['from'] || '');
          const dateRaw    = headers['date'] || '';
          const { name: fromName, addr: fromAddr } = parseAddress(fromRaw);

          // 日時フォーマット
          let dateStr = '—';
          try {
            const d = new Date(dateRaw);
            if (!isNaN(d)) {
              const mm = String(d.getMonth()+1).padStart(2,'0');
              const dd = String(d.getDate()).padStart(2,'0');
              const hh = String(d.getHours()).padStart(2,'0');
              const mi = String(d.getMinutes()).padStart(2,'0');
              dateStr = `${mm}/${dd} ${hh}:${mi}`;
            }
          } catch(_) {}

          const unread  = !flags.includes('\\Seen');
          const preview = text.replace(/\s+/g,' ').slice(0, 60) + (text.length > 60 ? '…' : '');
          const tags    = classify(fromAddr, subjectRaw);

          // SPF/DKIM/DMARC
          const auth  = headers['authentication-results'] || '';
          const spfH  = headers['received-spf'] || '';
          const spf   = /pass/i.test(spfH) ? 'PASS' : (/fail/i.test(spfH) ? 'FAIL' : '—');
          const dkim  = /dkim=pass/i.test(auth) ? 'PASS' : (/dkim=fail/i.test(auth) ? 'FAIL' : '—');
          const dmarc = /dmarc=pass/i.test(auth) ? 'PASS' : (/dmarc=fail/i.test(auth) ? 'FAIL' : '—');
          const recvd = headers['received'] || '';
          const srvM  = recvd.match(/from\s+(\S+)/i);
          const server= srvM ? srvM[1] : (fromAddr.split('@')[1] || '—');

          mails.push({
            id:      seqNum,
            from:    fromName || fromAddr,
            email:   fromAddr,
            subject: subjectRaw,
            date:    dateStr,
            preview,
            body:    text.slice(0, 3000).replace(/\n/g, '<br>'),
            tags,
            unread,
            spf, dkim, dmarc, server,
          });
        } catch(e) {
          console.warn('  ⚠ メール解析エラー:', e.message);
        }
      }
    }

    client.logout();
    console.log(`  ✓ ${mails.length}件取得完了`);
    return { mails, count: mails.length, account: CONFIG.email };

  } catch(e) {
    client.logout();
    if (/LOGIN|auth|credential/i.test(e.message)) {
      return { error: 'auth', message: `認証失敗: ${e.message}` };
    }
    if (/timeout|ECONNREFUSED|ENOTFOUND/i.test(e.message)) {
      return { error: 'connect', message: `接続失敗: ${e.message}` };
    }
    return { error: 'unknown', message: e.message };
  }
}

// ─── HTTP サーバー ────────────────────────────────────────────

const HTML_PATH = path.join(__dirname, 'grand-master-mail.html');

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  console.log(`  [${new Date().toLocaleTimeString('ja-JP')}] ${req.method} ${url}`);

  const json = (data, status = 200) => {
    const body = JSON.stringify(data, null, 0);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' });
    res.end(); return;
  }

  if (url === '/' || url === '/index.html') {
    try {
      const html = fs.readFileSync(HTML_PATH);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      json({ error: 'grand-master-mail.html が見つかりません。同じフォルダに置いてください。' }, 404);
    }
    return;
  }

  if (url === '/api/mails') {
    console.log('  → メール取得開始...');
    const result = await fetchMails();
    json(result);
    return;
  }

  if (url === '/api/config') {
    json({
      configured: !!(CONFIG.email && CONFIG.password),
      host: CONFIG.imap.host,
      account: CONFIG.email || '(未設定)',
    });
    return;
  }

  json({ error: 'not found' }, 404);
});

// ─── 起動 ─────────────────────────────────────────────────────

server.listen(CONFIG.port, 'localhost', () => {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  Grand-Master Mail  —  Node.js サーバー');
  console.log('═══════════════════════════════════════════');
  console.log(`  アカウント    : ${CONFIG.email || '(未設定 — server.js を編集)'}`);
  console.log(`  IMAPサーバー  : ${CONFIG.imap.host}:${CONFIG.imap.port}`);
  console.log(`  取得件数      : 最新 ${CONFIG.fetchLimit} 件`);
  console.log(`  URL           : http://localhost:${CONFIG.port}`);
  console.log('───────────────────────────────────────────');
  if (!CONFIG.email || !CONFIG.password) {
    console.log('  ⚠️  server.js の email / password を設定してください');
    console.log('');
  }
  console.log('  ブラウザで http://localhost:' + CONFIG.port + ' を開いてください');
  console.log('  終了: Ctrl+C');
  console.log('═══════════════════════════════════════════');
  console.log('');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`  ✗ ポート ${CONFIG.port} は使用中です。CONFIG.port を変更してください`);
  } else {
    console.error('  ✗ サーバーエラー:', e.message);
  }
  process.exit(1);
});
