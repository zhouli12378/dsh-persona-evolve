#!/usr/bin/env node
/**
 * 命令行跑一次人设演化（不依赖 DSH 宿主）。
 *
 * 用法：
 *   node bin.mjs --persona "D:\小鲸鱼\AGENTS.md" --section 最近的样子 --dry-run
 *   node bin.mjs --persona AGENTS.md --transcript chat.txt --api-key sk-xxx
 *
 * 环境变量：DEEPSEEK_API_KEY / PERSONA_EVOLVE_API_KEY、PERSONA_EVOLVE_MODEL
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { evolve, transcriptFromMessages, decodeZstdFrames } from './evolve.js';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const personaPath = String(arg('persona', 'AGENTS.md'));
const sectionTitle = String(arg('section', '最近的样子'));
const maxLines = Number(arg('max-lines', 8)) || 8;
const dryRun = Boolean(arg('dry-run', false));
const transcriptFile = arg('transcript', null);
const sessionsDir = String(arg('sessions', join(homedir(), '.dsh', 'sessions')));
const apiKey = String(
  arg('api-key', process.env.PERSONA_EVOLVE_API_KEY || process.env.DEEPSEEK_API_KEY || ''),
);
const baseUrl = String(arg('base-url', process.env.PERSONA_EVOLVE_BASE_URL || 'https://api.deepseek.com'));
const model = String(arg('model', process.env.PERSONA_EVOLVE_MODEL || 'deepseek-chat'));
const logPath = String(arg('log', '') || '');

/** 从压缩的会话文件里粗略抠出对话文本（结构随 DSH 版本变化，这里做宽容匹配）。 */
function harvest(node, out, depth = 0) {
  if (!node || depth > 8 || out.length > 400) return;
  if (Array.isArray(node)) {
    for (const n of node) harvest(n, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const role = node.role;
  if ((role === 'user' || role === 'assistant') && node.content !== undefined) {
    const text = typeof node.content === 'string'
      ? node.content
      : Array.isArray(node.content)
        ? node.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n')
        : '';
    if (text && text.trim().length > 4) out.push({ role, content: text });
  }
  for (const key of Object.keys(node)) harvest(node[key], out, depth + 1);
}

async function readSessions(dir, limit = 3) {
  const files = [];
  async function walk(d, depth = 0) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 4) await walk(p, depth + 1);
      else if (e.isFile() && /session.*\.jsonl(\.zstd)?$/i.test(e.name)) files.push(p);
    }
  }
  await walk(dir);
  const withTime = [];
  for (const f of files) {
    try { withTime.push({ f, t: (await stat(f)).mtimeMs }); } catch { /* skip */ }
  }
  withTime.sort((a, b) => b.t - a.t);
  const messages = [];
  for (const { f } of withTime.slice(0, limit)) {
    let raw;
    try {
      const buf = await readFile(f);
      raw = f.endsWith('.zstd') ? decodeZstdFrames(buf).toString('utf8') : buf.toString('utf8');
    } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { harvest(JSON.parse(line), messages); } catch { /* 半行/坏行跳过 */ }
    }
  }
  return messages;
}

async function chat(messages) {
  if (!apiKey) throw new Error('没有 API key：传 --api-key 或设 DEEPSEEK_API_KEY');
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: 600 }),
  });
  if (!res.ok) throw new Error(`模型返回 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

let transcript;
if (transcriptFile && transcriptFile !== true) {
  transcript = await readFile(String(transcriptFile), 'utf8');
} else {
  const messages = await readSessions(sessionsDir);
  transcript = transcriptFromMessages(messages);
}
if (!transcript.trim()) throw new Error('没取到对话内容（可以用 --transcript 指定一个文本文件）');

const result = await evolve({
  personaPath,
  sectionTitle,
  maxLines,
  transcript,
  chat,
  logPath: logPath || undefined,
  dryRun,
});

console.log(JSON.stringify({
  changed: result.changed,
  reason: result.reason,
  before: result.before.trim(),
  after: result.after.trim(),
  dryRun,
}, null, 2));
