/**
 * dsh-persona-evolve —— 宿主半边
 *
 * 定时回看最近的会话，让模型判断人设里「可演化小节」有没有长出新东西；
 * 有就只改那一节，根（铁律/边界）一个字节不碰。
 *
 * 通道：优先宿主自带模型服务（ctx.llm，装了 DSH 就能用，不花额外钱）；
 *       宿主没暴露时才退回用户在设置页填的 apiKey。
 *
 * 设置页：/api/persona-evolve/*（浏览器半端 client.js 用）。
 * 配置落盘：~/.dsh/persona-evolve/config.json（设置页改的就是它，优先级高于 profile 的 patch）。
 */

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
import { evolve, transcriptFromMessages } from './evolve.js';

export const name = 'persona-evolve';

const DEFAULTS = {
  enabled: true,
  intervalHours: 168,
  personaFile: 'AGENTS.md',
  section: '最近的样子',
  maxLines: 8,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: '',
  sessionsDir: '',
  // 数据目录（配置/状态/日志）。留空 = ~/.dsh/persona-evolve；
  // 想在别的盘就把它指过去（这是"开机级"设置，只能改 profile 的 cordis.patch.yml，设置页只读）。
  dataDir: '',
};

function dataDirOf(cfg) {
  const raw = String(cfg?.dataDir || '').trim();
  if (raw) return isAbsolute(raw) ? raw : join(homedir(), raw);
  return join(homedir(), '.dsh', 'persona-evolve');
}

function mask(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 8) return '***';
  return s.slice(0, 3) + '***' + s.slice(-4);
}

function resolveChat(ctx, cfg) {
  const llm = (() => { try { return ctx?.get?.('llm') } catch { return null } })();
  if (llm && typeof llm.stream === 'function') {
    const route = (() => {
      try {
        const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
        if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model };
      } catch { /* 没这个服务 */ }
      try {
        const ps = llm.listProviders?.() || [];
        if (ps.length) return { provider: ps[0].id, model: ps[0].defaultModel || '' };
      } catch { /* ignore */ }
      return null;
    })();
    if (route?.model) {
      return {
        via: `host:${route.provider}/${route.model}`,
        chat: async (messages) => {
          const sys = messages.find((m) => m.role === 'system')?.content || '';
          const rest = messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text: String(m.content ?? '') }] }));
          let out = '';
          for await (const chunk of llm.stream({
            provider: route.provider,
            model: route.model,
            ...(sys ? { system: sys } : {}),
            messages: rest,
            maxTokens: 700,
            temperature: 0.4,
          })) {
            if (chunk?.type === 'text-delta') out += String(chunk.text ?? '');
            else if (chunk?.type === 'finish') break;
          }
          return out;
        },
      };
    }
  }
  if (!cfg.apiKey) return { via: '', chat: null };
  return {
    via: `http:${cfg.baseUrl}/${cfg.model}`,
    chat: async (messages) => {
      const res = await fetch(`${String(cfg.baseUrl).replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, messages, temperature: 0.4, max_tokens: 700 }),
      });
      if (!res.ok) throw new Error(`模型返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return data?.choices?.[0]?.message?.content ?? '';
    },
  };
}

function harvest(node, out, depth = 0) {
  if (!node || depth > 8 || out.length > 500) return;
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

async function readSessions(dir, limit = 4) {
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

  const stamped = [];
  for (const f of files) {
    try { stamped.push({ f, t: (await stat(f)).mtimeMs }); } catch { /* skip */ }
  }
  stamped.sort((a, b) => b.t - a.t);

  const messages = [];
  for (const { f } of stamped.slice(0, limit)) {
    let raw;
    try {
      const buf = await readFile(f);
      raw = f.endsWith('.zstd') ? zstdDecompressSync(buf).toString('utf8') : buf.toString('utf8');
    } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { harvest(JSON.parse(line), messages); } catch { /* 半行跳过 */ }
    }
  }
  return messages;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readJsonFile(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

export function apply(ctx, rawConfig) {
  const log = (msg) => {
    try { ctx?.logger?.info?.(String(msg)); } catch { /* ignore */ }
  };

  const runtime = {
    cfg: { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) },
    chat: null,
    via: '',
    timer: null,
  };

  const HOME = dataDirOf(runtime.cfg);
  const CONFIG_FILE = join(HOME, 'config.json');
  const STATE_FILE = join(HOME, 'state.json');
  const LOG_FILE = join(HOME, 'evolve.log');
  function normalizeCfg(cfg) {
    cfg.intervalHours = Number(cfg.intervalHours) || DEFAULTS.intervalHours;
    cfg.maxLines = Number(cfg.maxLines) || DEFAULTS.maxLines;
    if (!cfg.apiKey) cfg.apiKey = process.env.PERSONA_EVOLVE_API_KEY || process.env.DEEPSEEK_API_KEY || '';
    if (!cfg.sessionsDir) cfg.sessionsDir = join(homedir(), '.dsh', 'sessions');
    if (!isAbsolute(cfg.personaFile)) {
      let base = '';
      try {
        const list = ctx.get('workspaceRegistry')?.list?.() || [];
        if (list[0]?.path) base = String(list[0].path);
      } catch { /* no service */ }
      cfg.personaFile = join(base || process.cwd(), cfg.personaFile);
    }
    return cfg;
  }

  async function saveConfigFile() {
    try {
      await mkdir(HOME, { recursive: true });
      const { apiKey, ...rest } = runtime.cfg;
      await writeFile(CONFIG_FILE, JSON.stringify({ ...rest, ...(apiKey ? { apiKey } : {}) }, null, 2), 'utf8');
    } catch (e) {
      log('persona-evolve: 保存配置失败 ' + (e?.message ?? e));
    }
  }

  async function readState() {
    return readJsonFile(STATE_FILE, {});
  }
  async function writeState(patch) {
    try {
      await mkdir(HOME, { recursive: true });
      const prev = await readState();
      await writeFile(STATE_FILE, JSON.stringify({ ...prev, ...patch }, null, 2), 'utf8');
    } catch { /* 状态写失败不影响主流程 */ }
  }

  function startTimer() {
    if (runtime.timer) { try { clearInterval(runtime.timer) } catch { /* ignore */ } runtime.timer = null; }
    if (!runtime.chat) return;
    const tickMs = 10 * 60 * 1000;
    const dueMs = runtime.cfg.intervalHours * 3600 * 1000;
    runtime.timer = setInterval(async () => {
      try {
        const s = await readState();
        const last = s.lastRun ? Date.parse(s.lastRun) : 0;
        if (!last || Date.now() - last >= dueMs) await runOnce('timer');
      } catch (e) {
        log('persona-evolve: 定时器回调出错 ' + (e?.message ?? e));
      }
    }, tickMs);
    runtime.timer.unref?.();
  }

  function rebuild() {
    normalizeCfg(runtime.cfg);
    const r = resolveChat(ctx, runtime.cfg);
    runtime.chat = r.chat;
    runtime.via = r.via;
    startTimer();
  }

  async function runOnce(reason = 'timer', dryRun = false) {
    try {
      if (!runtime.chat) throw new Error('没有可用的模型通道（宿主 llm 与 apiKey 都没有）');
      const messages = await readSessions(runtime.cfg.sessionsDir);
      const transcript = transcriptFromMessages(messages);
      if (!transcript.trim()) return { changed: false, reason: '没有可读的会话', dryRun };
      const result = await evolve({
        personaPath: runtime.cfg.personaFile,
        sectionTitle: runtime.cfg.section,
        maxLines: runtime.cfg.maxLines,
        transcript,
        chat: runtime.chat,
        logPath: LOG_FILE,
        dryRun,
      });
      await writeState({ lastRun: new Date().toISOString(), lastReason: result.reason, lastVia: runtime.via });
      log(`persona-evolve[${reason}${dryRun ? ':dry' : ''}]: ${result.changed ? '已更新' : '未改动'}（${result.reason}）`);
      return { ...result, dryRun, via: runtime.via, personaFile: runtime.cfg.personaFile };
    } catch (e) {
      log(`persona-evolve[${reason}] 失败：${e?.message ?? e}`);
      return { changed: false, reason: String(e?.message ?? e), dryRun };
    }
  }

  async function status() {
    const s = await readState();
    let exists = false;
    try { exists = (await stat(runtime.cfg.personaFile)).isFile(); } catch { exists = false; }
    return {
      ok: true,
      enabled: runtime.cfg.enabled !== false,
      configured: Boolean(runtime.chat),
      via: runtime.via || null,
      intervalHours: runtime.cfg.intervalHours,
      personaFile: runtime.cfg.personaFile,
      personaFileExists: exists,
      section: runtime.cfg.section,
      maxLines: runtime.cfg.maxLines,
      hasApiKey: Boolean(runtime.cfg.apiKey),
      apiKeyMasked: mask(runtime.cfg.apiKey),
      baseUrl: runtime.cfg.baseUrl,
      model: runtime.cfg.model,
      lastRun: s.lastRun ?? null,
      lastReason: s.lastReason ?? null,
      lastVia: s.lastVia ?? null,
      dataDir: HOME,
      configFile: CONFIG_FILE,
      logFile: LOG_FILE,
    };
  }

  // ── HTTP 接口（设置页用）─────────────────────────────────────────────
  const routes = [
    ['/api/persona-evolve/status', async (req, res) => {
      try { sendJson(res, 200, await status()); } catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }); }
    }],
    ['/api/persona-evolve/config', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const patch = {};
        for (const k of ['enabled', 'intervalHours', 'personaFile', 'section', 'maxLines', 'apiKey', 'baseUrl', 'model']) {
          if (body[k] !== undefined) patch[k] = body[k];
        }
        if (patch.personaFile === '') delete patch.personaFile;
        if (patch.apiKey === '__KEEP__') delete patch.apiKey;
        Object.assign(runtime.cfg, patch);
        if (typeof runtime.cfg.enabled === 'string') runtime.cfg.enabled = runtime.cfg.enabled !== 'false';
        rebuild();
        await saveConfigFile();
        sendJson(res, 200, { ok: true, ...(await status()) });
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }); }
    }],
    ['/api/persona-evolve/run', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        let body = {};
        try { body = JSON.parse(raw); } catch { body = {}; }
        const result = await runOnce('manual', Boolean(body.dryRun));
        sendJson(res, 200, { ok: true, ...result });
      } catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }); }
    }],
  ];

  let retryTimer = 0;
  const mountRoutes = (attempt) => {
    const webServer = (() => { try { return ctx?.get?.('webServer') } catch { return null } })();
    if (webServer && typeof webServer.register === 'function') {
      for (const [path, handler] of routes) {
        try {
          const mount = () => webServer.register({ kind: 'exact', path, handler });
          if (typeof ctx.effect === 'function') ctx.effect(mount, `persona-evolve: ${path}`);
          else mount();
        } catch (e) {
          log(`persona-evolve: 路由 ${path} 注册失败 ${e?.message ?? e}`);
        }
      }
      log('persona-evolve: 设置页接口已注册（/api/persona-evolve/*）');
      return;
    }
    if (attempt < 20) retryTimer = setTimeout(() => mountRoutes(attempt + 1), 1000);
    else log('persona-evolve: webServer 20 秒内未就绪，设置页接口未注册');
  };

  // 初始化：读设置页存下的配置 → 覆盖 patch → 建通道 → 起定时器 → 挂路由
  void (async () => {
    const saved = await readJsonFile(CONFIG_FILE, null);
    if (saved && typeof saved === 'object') {
      for (const k of ['enabled', 'intervalHours', 'personaFile', 'section', 'maxLines', 'apiKey', 'baseUrl', 'model']) {
        if (saved[k] !== undefined) runtime.cfg[k] = saved[k];
      }
    }
    rebuild();
    log(
      runtime.chat
        ? `persona-evolve: 已启用（通道 ${runtime.via}），每 ${runtime.cfg.intervalHours} 小时检查一次，目标 ${runtime.cfg.personaFile}`
        : 'persona-evolve: ⚠️ 没有可用的模型通道，插件不会运行。宿主有 ctx.llm 就会自动用它；否则请在设置页填 apiKey。',
    );
    mountRoutes(0);
  })();

  ctx.personaEvolve = { runOnce, status, config: runtime.cfg };

  const cleanup = () => {
    try { if (runtime.timer) clearInterval(runtime.timer) } catch { /* ignore */ }
    try { if (retryTimer) clearTimeout(retryTimer) } catch { /* ignore */ }
  };
  try {
    if (typeof ctx?.on === 'function') ctx.on('dispose', cleanup);
  } catch { /* ignore */ }
  return cleanup;
}
