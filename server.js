'use strict';

// API credentials stay on the server and are never exposed to the browser.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { URL } = require('node:url');
const { Pool } = require('pg');

const ROOT = __dirname;
const HOST = process.env.ASSEMBLE_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const PORT = Number(process.env.PORT || 4173);
const ENV_FILE = path.join(ROOT, '.env');
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const API_RATE_LIMITS = {
  '/api/analyze': 5, '/api/chat': 30, '/api/recommend': 10, '/api/research': 8,
  '/api/auth/register': 5, '/api/auth/login': 10, '/api/auth/logout': 30, '/api/auth/delete-account': 3,
  '/api/profile': 60, '/api/projects': 60
};
const MAX_CONCURRENT_API_REQUESTS = 6;
const rateLimitBuckets = new Map();
let activeApiRequests = 0;
const scrypt = promisify(crypto.scrypt);
let pool = null;

function loadLocalEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith('#')) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
loadLocalEnv();
pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 }) : null;

const MODEL = process.env.OPENAI_MODEL || 'gpt-6-astra';
const configuredApiKey = (process.env.OPENAI_API_KEY || '').trim();
const API_KEY = /^(?:replace_with_your_api_key|your_openai_api_key)$/i.test(configuredApiKey) ? '' : configuredApiKey;
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, 'candidates.json'), 'utf8'));

async function initializeDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS assemble_users (
      id uuid PRIMARY KEY,
      email text NOT NULL,
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS assemble_users_email_lower_idx ON assemble_users (lower(email));
    CREATE TABLE IF NOT EXISTS assemble_sessions (
      token_hash text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES assemble_users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS assemble_sessions_user_idx ON assemble_sessions (user_id);
    CREATE TABLE IF NOT EXISTS assemble_profiles (
      user_id uuid PRIMARY KEY REFERENCES assemble_users(id) ON DELETE CASCADE,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      resume_name text,
      resume_mime text,
      resume_data bytea,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS assemble_projects (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES assemble_users(id) ON DELETE CASCADE,
      title text NOT NULL,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS assemble_projects_user_updated_idx ON assemble_projects (user_id, updated_at DESC);
  `);
}

const SYSTEM_PROMPT = `You are ASSEMBLE, an AI agent for project resource orchestration. You help project initiators understand what their project requires, identify possible capability gaps, and choose between LEARN, TOOL, and PEOPLE resources.

Operating principles:
1. Diagnose before matching. First understand the intended outcome, stage, constraints and what is already known.
2. Evidence before assumption. Distinguish provided evidence, inference and unknowns. Missing profile evidence does NOT prove missing ability.
3. Do not default to hiring. A gap may be addressed by learning, an existing tool, narrowing scope, or a person.
4. Explain reasoning in concise, user-friendly terms and expose uncertainty. Ask a clarifying question only when it would materially change the recommendation.
5. The user has authority. Present drafts, ask for corrections, and never claim that you changed a profile, contacted someone, sent an invitation, or executed an external action.
6. Candidate data in this prototype is fictional sample data. Always identify it as simulated when relevant. Do not invent candidate profiles or claim availability or interest is verified.
7. Prefer Chinese when the user writes Chinese; mirror the user's language.
8. Keep answers structured and specific to the supplied project context. Tie every recommendation to the exact goal, stage, time constraint, and relevant profile/project evidence. If a profile does not contain evidence, say unknown instead of inventing an ability or deficit.
9. Avoid generic advice. Give the next concrete action, expected deliverable, completion check, realistic effort, likely blocker, and how it relates to this project. Prioritize evidence from this user's profile and past work when it genuinely matches the requirement; explain what supports the match and what remains unknown. Do not repeat generic strengths or recommend hiring by default.
10. For research, use official, institutional, or primary sources. State the exact project decision each source supports, how to apply it at the current stage, prerequisites, limitations, and whether the source verifies a free or paid option. If cost is not verifiable, say so. Do not disclose hidden reasoning; give concise reasons and evidence instead.`;

const analysisSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    project_summary: { type: 'string' },
    tasks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      title: { type: 'string' }, description: { type: 'string' }, capability: { type: 'string' }, deliverable: { type: 'string' }, done_when: { type: 'string' }, estimated_effort: { type: 'string' }
    }, required: ['title', 'description', 'capability', 'deliverable', 'done_when', 'estimated_effort'] } },
    gap: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string' }, why: { type: 'string' }, evidence_basis: { type: 'string' }, validation_test: { type: 'string' }, confidence: { type: 'string', enum: ['Low', 'Low-medium', 'Medium', 'High'] }
    }, required: ['name', 'why', 'evidence_basis', 'validation_test', 'confidence'] },
    capability_observations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string' }, status: { type: 'string', enum: ['Evidence found', 'Some evidence', 'Unknown'] }, evidence: { type: 'string' }
    }, required: ['name', 'status', 'evidence'] } },
    resource_strategies: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      type: { type: 'string', enum: ['LEARN', 'TOOL', 'PEOPLE'] }, title: { type: 'string' }, rationale: { type: 'string' }, tradeoff: { type: 'string' }, steps: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { action: { type: 'string' }, deliverable: { type: 'string' }, done_when: { type: 'string' } }, required: ['action', 'deliverable', 'done_when'] } }, resources: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, url: { type: 'string' }, relevance: { type: 'string' } }, required: ['title', 'url', 'relevance'] } }
    }, required: ['type', 'title', 'rationale', 'tradeoff', 'steps', 'resources'] } },
    follow_up_questions: { type: 'array', items: { type: 'string' } }
  },
  required: ['project_summary', 'tasks', 'gap', 'capability_observations', 'resource_strategies', 'follow_up_questions']
};

const recommendationSchema = {
  type: 'object', additionalProperties: false,
  properties: { recommendations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string' }, reason: { type: 'string' }, unknowns: { type: 'string' }
  }, required: ['id', 'reason', 'unknowns'] } } },
  required: ['recommendations']
};

const searchTool = {
  type: 'function',
  name: 'search_candidate_profiles',
  description: 'Search the local simulated candidate directory for roles/skills/industries relevant to the current project. Use when the user asks who could help, wants candidate options, or asks to explore the private network. These are fictional sample profiles, not real people.',
  strict: true,
  parameters: {
    type: 'object', additionalProperties: false,
    properties: { query: { type: 'string', description: 'Search terms for role, skills, project evidence, or industry.' }, category: { type: 'string', enum: ['ALL', 'TECH', 'DESIGN', 'BUSINESS', 'GROWTH', 'PRODUCT', 'OPERATIONS', 'IMPACT'] } },
    required: ['query', 'category']
  }
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
function sessionCookie(token, clear = false) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `assemble_session=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 60 * 60 * 24 * 30}${secure}`;
}
function sessionTokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function requestHasValidOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function parseSessionToken(req) {
  const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('assemble_session='));
  return cookie ? decodeURIComponent(cookie.slice('assemble_session='.length)) : '';
}
async function currentUser(req) {
  if (!pool) return null;
  const token = parseSessionToken(req);
  if (!token) return null;
  const result = await pool.query(`
    SELECT u.id, u.email FROM assemble_sessions s
    JOIN assemble_users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > now()
  `, [sessionTokenHash(token)]);
  return result.rows[0] || null;
}
async function issueSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await pool.query('DELETE FROM assemble_sessions WHERE expires_at < now()');
  await pool.query('INSERT INTO assemble_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sessionTokenHash(token), userId, expiresAt]);
  res.setHeader('Set-Cookie', sessionCookie(token));
}
async function makePasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(hash).toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  const [algorithm, salt, expectedHex] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(await scrypt(password, salt, expected.length));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function ensureDatabase(res) {
  if (pool) return true;
  json(res, 503, { error: 'ACCOUNT_STORAGE_UNAVAILABLE', message: '云端账号功能尚未配置数据库。' });
  return false;
}
async function authenticatedUser(req, res) {
  const user = await currentUser(req);
  if (!user) json(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录账号。' });
  return user;
}
async function handleAccountRoutes(req, res, url) {
  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    if (!pool) return json(res, 200, { accountsEnabled: false, user: null });
    try { return json(res, 200, { accountsEnabled: true, user: await currentUser(req) }); }
    catch { return json(res, 503, { error: 'DATABASE_UNAVAILABLE', message: '账号数据库暂时不可用，请稍后再试。' }); }
  }
  if (!url.pathname.startsWith('/api/auth/')) return false;
  if (!ensureDatabase(res)) return true;
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' });
  if (!requestHasValidOrigin(req)) return json(res, 403, { error: 'INVALID_ORIGIN', message: '请求来源校验失败，请刷新页面后重试。' });
  try {
    if (url.pathname === '/api/auth/register' || url.pathname === '/api/auth/login') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json(res, 400, { error: 'INVALID_EMAIL', message: '请输入有效邮箱地址。' });
      if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 256) return json(res, 400, { error: 'INVALID_PASSWORD', message: '密码长度需为 12 至 128 个字符。' });
      let user;
      if (url.pathname === '/api/auth/register') {
        const id = crypto.randomUUID();
        const passwordHash = await makePasswordHash(password);
        try {
          const result = await pool.query('INSERT INTO assemble_users (id, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email', [id, email, passwordHash]);
          user = result.rows[0];
          await pool.query('INSERT INTO assemble_profiles (user_id, data) VALUES ($1, $2::jsonb)', [user.id, JSON.stringify({})]);
        } catch (error) {
          if (error.code === '23505') return json(res, 409, { error: 'ACCOUNT_EXISTS', message: '该邮箱已注册，请切换到登录。' });
          throw error;
        }
      } else {
        const result = await pool.query('SELECT id, email, password_hash FROM assemble_users WHERE lower(email) = lower($1)', [email]);
        user = result.rows[0];
        if (!user || !(await verifyPassword(password, user.password_hash))) return json(res, 401, { error: 'INVALID_CREDENTIALS', message: '邮箱或密码不正确。' });
      }
      await issueSession(res, user.id);
      return json(res, 200, { user: { id: user.id, email: user.email } });
    }
    if (url.pathname === '/api/auth/logout') {
      const token = parseSessionToken(req);
      if (token) await pool.query('DELETE FROM assemble_sessions WHERE token_hash = $1', [sessionTokenHash(token)]);
      res.setHeader('Set-Cookie', sessionCookie('', true));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/auth/delete-account') {
      const body = await readBody(req);
      const user = await authenticatedUser(req, res);
      if (!user) return true;
      const result = await pool.query('SELECT password_hash FROM assemble_users WHERE id = $1', [user.id]);
      if (!result.rows[0] || !(await verifyPassword(String(body.password || ''), result.rows[0].password_hash))) return json(res, 401, { error: 'INVALID_CREDENTIALS', message: '密码不正确，账号和个人资料未删除。' });
      await pool.query('DELETE FROM assemble_users WHERE id = $1', [user.id]);
      res.setHeader('Set-Cookie', sessionCookie('', true));
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'NOT_FOUND', message: '账号接口不存在。' });
  } catch (error) {
    console.error('Account request failed:', error.message);
    return json(res, 500, { error: 'ACCOUNT_REQUEST_FAILED', message: '账号操作失败，请稍后再试。' });
  }
}
async function handleUserDataRoutes(req, res, url) {
  if (!['/api/profile', '/api/projects'].includes(url.pathname) && !/^\/api\/projects\/[0-9a-f-]{36}$/i.test(url.pathname)) return false;
  if (!ensureDatabase(res)) return true;
  if (req.method !== 'GET' && !requestHasValidOrigin(req)) return json(res, 403, { error: 'INVALID_ORIGIN', message: '请求来源校验失败，请刷新页面后重试。' });
  try {
    const user = await authenticatedUser(req, res);
    if (!user) return true;
    if (url.pathname === '/api/profile' && req.method === 'GET') {
      const result = await pool.query('SELECT data, resume_name, resume_mime, resume_data FROM assemble_profiles WHERE user_id = $1', [user.id]);
      const row = result.rows[0];
      return json(res, 200, { data: row?.data || {}, resume: row?.resume_data ? { name: row.resume_name, mimeType: row.resume_mime, base64: row.resume_data.toString('base64') } : null });
    }
    if (url.pathname === '/api/profile' && req.method === 'PUT') {
      const body = await readBody(req);
      const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};
      const dataJson = JSON.stringify(data);
      if (Buffer.byteLength(dataJson, 'utf8') > 512 * 1024) return json(res, 413, { error: 'PROFILE_TOO_LARGE', message: '个人资料内容过大，请精简项目经历后再保存。' });
      const resume = body.resume && typeof body.resume === 'object' ? body.resume : null;
      let resumeBytes = null;
      if (resume?.base64) {
        if (typeof resume.base64 !== 'string' || resume.base64.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8) return json(res, 413, { error: 'FILE_TOO_LARGE', message: '简历文件不能超过 8 MB。' });
        resumeBytes = Buffer.from(resume.base64, 'base64');
        if (!resumeBytes.length || resumeBytes.length > MAX_FILE_BYTES) return json(res, 413, { error: 'FILE_TOO_LARGE', message: '简历文件不能超过 8 MB。' });
      }
      await pool.query(`INSERT INTO assemble_profiles (user_id, data, resume_name, resume_mime, resume_data, updated_at)
        VALUES ($1, $2::jsonb, $3, $4, $5, now())
        ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, resume_name = EXCLUDED.resume_name, resume_mime = EXCLUDED.resume_mime, resume_data = EXCLUDED.resume_data, updated_at = now()`,
        [user.id, dataJson, resumeBytes ? String(resume.name || 'resume').slice(0, 200) : null, resumeBytes ? String(resume.mimeType || 'application/octet-stream').slice(0, 120) : null, resumeBytes]);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/projects' && req.method === 'GET') {
      const result = await pool.query('SELECT id, title, data, created_at, updated_at FROM assemble_projects WHERE user_id = $1 ORDER BY updated_at DESC', [user.id]);
      return json(res, 200, { projects: result.rows });
    }
    if (url.pathname === '/api/projects' && req.method === 'POST') {
      const body = await readBody(req);
      const id = /^[0-9a-f-]{36}$/i.test(String(body.id || '')) ? String(body.id) : crypto.randomUUID();
      const title = String(body.title || 'Untitled project').trim().slice(0, 200) || 'Untitled project';
      const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};
      const dataJson = JSON.stringify(data);
      if (Buffer.byteLength(dataJson, 'utf8') > 1024 * 1024) return json(res, 413, { error: 'PROJECT_TOO_LARGE', message: '项目数据超过 1 MB，请减少聊天记录或长文本后再保存。' });
      const result = await pool.query(`INSERT INTO assemble_projects (id, user_id, title, data) VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, data = EXCLUDED.data, updated_at = now()
        WHERE assemble_projects.user_id = EXCLUDED.user_id RETURNING id, title, data, created_at, updated_at`, [id, user.id, title, dataJson]);
      if (!result.rows[0]) return json(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在或无权访问。' });
      return json(res, 200, result.rows[0]);
    }
    const projectId = url.pathname.match(/^\/api\/projects\/([0-9a-f-]{36})$/i)?.[1];
    if (projectId && req.method === 'DELETE') {
      const result = await pool.query('DELETE FROM assemble_projects WHERE id = $1 AND user_id = $2', [projectId, user.id]);
      return json(res, result.rowCount ? 200 : 404, result.rowCount ? { ok: true } : { error: 'PROJECT_NOT_FOUND', message: '项目不存在或无权访问。' });
    }
    return json(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' });
  } catch (error) {
    console.error('User data request failed:', error.message);
    return json(res, 500, { error: 'USER_DATA_REQUEST_FAILED', message: '个人资料或项目保存失败，请稍后再试。' });
  }
}
function clientAddress(req) {
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (net.isIP(forwarded)) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}
function rateLimit(req, pathname, identity = '') {
  const now = Date.now();
  const key = `${identity || clientAddress(req)}:${pathname}`;
  let bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    rateLimitBuckets.set(key, bucket);
  }
  if (rateLimitBuckets.size > 5000) {
    for (const [bucketKey, oldBucket] of rateLimitBuckets) if (now - oldBucket.startedAt >= RATE_WINDOW_MS) rateLimitBuckets.delete(bucketKey);
    if (rateLimitBuckets.size > 5000) {
      const oldestKeys = rateLimitBuckets.keys();
      for (let i = 0, excess = rateLimitBuckets.size - 5000; i < excess; i++) rateLimitBuckets.delete(oldestKeys.next().value);
    }
  }
  if (bucket.count >= API_RATE_LIMITS[pathname]) return { allowed: false, retryAfter: Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - bucket.startedAt)) / 1000)) };
  bucket.count++;
  return { allowed: true };
}
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('Request body is too large. Keep each uploaded file under 8 MB and the combined request under 25 MB.'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function ensureKey() {
  if (!API_KEY) throw Object.assign(new Error('API_KEY_MISSING'), { status: 503, code: 'API_KEY_MISSING' });
}
function publicApiError(error) {
  const raw = String(error?.message || 'Unknown error');
  if (raw === 'API_KEY_MISSING') return { status: 503, code: 'API_KEY_MISSING', message: '没有找到 API 密钥。请复制 .env.example 为 .env，并填写你自己的 OPENAI_API_KEY。' };
  if (/OpenAI API error 401/.test(raw)) return { status: 401, code: 'INVALID_API_KEY', message: 'API 密钥无效或未获授权。请检查 .env 中的 OPENAI_API_KEY。' };
  if (/OpenAI API error 403/.test(raw)) return { status: 403, code: 'MODEL_ACCESS', message: '该 API 账户暂时没有权限调用所选模型。请在 .env 中把 OPENAI_MODEL 改成账户有权限的模型。' };
  if (/OpenAI API error 429/.test(raw)) return { status: 429, code: 'RATE_OR_QUOTA', message: 'API 调用额度不足或触发限流。请检查 API 计费与使用限额后再试。' };
  if (/OpenAI API error 400/.test(raw)) return { status: 400, code: 'BAD_REQUEST', message: '模型拒绝了本次请求参数。可能是模型名称或结构化输出格式不受支持；可尝试更新 OPENAI_MODEL。' };
  if (/timed out|TimeoutError|aborted/i.test(raw)) return { status: 504, code: 'TIMEOUT', message: '模型响应超时，请缩短项目描述后重试。' };
  return { status: error.status || 500, code: error.code || 'AGENT_ERROR', message: raw.slice(0, 500) };
}
async function openaiRequest(pathname, options = {}) {
  ensureKey();
  const response = await fetch(`${OPENAI_BASE}${pathname}`, {
    method: options.method || 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, ...(options.headers || {}) },
    body: options.body,
    signal: AbortSignal.timeout(options.timeout || 90000)
  });
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { error: { message: text.slice(0, 600) } }; }
  if (!response.ok) {
    const message = data?.error?.message || `HTTP ${response.status}`;
    throw Object.assign(new Error(`OpenAI API error ${response.status}: ${message}`), { status: response.status, code: 'OPENAI_API_ERROR' });
  }
  return data;
}
function textFromResponse(response) {
  if (typeof response.output_text === 'string' && response.output_text) return response.output_text;
  const chunks = [];
  for (const item of response.output || []) {
    if (item.type === 'message') for (const part of item.content || []) if (part.type === 'output_text' && part.text) chunks.push(part.text);
  }
  return chunks.join('\n');
}
function citationsFromResponse(response) {
  const citations = [];
  for (const item of response.output || []) for (const part of item.content || []) for (const annotation of part.annotations || []) {
    if (annotation.type !== 'url_citation' || !annotation.url) continue;
    try {
      const url = new URL(annotation.url);
      if (url.protocol !== 'https:') continue;
      if (!citations.some(entry => entry.url === url.href)) citations.push({ title: String(annotation.title || url.hostname).slice(0, 180), url: url.href });
    } catch { /* ignore malformed model annotations */ }
  }
  return citations.slice(0, 12);
}
async function uploadInputFile(file) {
  if (!file || !file.base64 || !file.name) return null;
  const ext = path.extname(file.name).toLowerCase();
  const allowed = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx']);
  if (!allowed.has(ext)) throw Object.assign(new Error('Only PDF, DOC/DOCX and PPT/PPTX files are sent to the model. TXT/Markdown should be passed as extracted text.'), { status: 400, code: 'UNSUPPORTED_FILE' });
  const bytes = Buffer.from(file.base64, 'base64');
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw Object.assign(new Error('File is empty or larger than 8 MB.'), { status: 413, code: 'FILE_TOO_LARGE' });
  const form = new FormData();
  form.append('purpose', 'user_data');
  form.append('file', new Blob([bytes], { type: file.mimeType || 'application/octet-stream' }), path.basename(file.name));
  const uploaded = await openaiRequest('/files', { body: form, timeout: 90000 });
  if (!uploaded.id) throw new Error('OpenAI file upload did not return a file id.');
  return uploaded.id;
}
async function deleteUploadedFile(fileId) {
  if (!fileId || !API_KEY) return;
  try { await openaiRequest(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE', timeout: 15000 }); } catch { /* best-effort cleanup */ }
}
function projectSummary(input) {
  const fields = [
    `Project name: ${input.title || 'Not specified'}`,
    `User's brief: ${input.goal || 'Not provided'}`,
    `Project type: ${input.projectType || 'other'}`,
    `Current stage: ${input.stage || 'Not specified'}`,
    `Time available: ${input.time || 'Not specified'}`,
    `Personal profile name: ${input.profileName || 'Not provided'}`,
    `Personal profile summary: ${(input.profileSummary || '').slice(0, 4000) || 'Not provided'}`,
    `User capability profile (self-reported; unknown is not lack of ability): ${JSON.stringify(Array.isArray(input.profile) ? input.profile.slice(0, 40) : []).slice(0, 12000)}`,
    `Existing project evidence: ${JSON.stringify(Array.isArray(input.workProjects) ? input.workProjects.slice(0, 30) : []).slice(0, 12000)}`,
    `Resume text (self-reported; may be incomplete): ${(input.resumeText || '').slice(0, 16000) || 'None'}`,
    `Text extracted from attached project notes: ${(input.attachedText || '').slice(0, 12000) || 'None'}`
  ];
  return fields.join('\n');
}
async function analyzeProject(input) {
  const uploadedFileIds = [];
  try {
    const uploadResults = await Promise.allSettled([uploadInputFile(input.file || null), uploadInputFile(input.resumeFile || null)]);
    for (const result of uploadResults) if (result.status === 'fulfilled' && result.value) uploadedFileIds.push(result.value);
    const failedUpload = uploadResults.find(result => result.status === 'rejected');
    if (failedUpload) throw failedUpload.reason;
    const userContent = [{ type: 'input_text', text: `Analyze this project for ASSEMBLE. Treat the output as a provisional, editable draft. Use the user's profile, capability examples, resume and past projects as self-reported evidence; do not infer a skill gap solely from missing profile information. First map the stated outcome and constraints to the user's strongest relevant evidence; do not list irrelevant profile facts. Return 4–8 actionable tasks, up to 5 capability observations, all three resource strategies (LEARN, TOOL, PEOPLE), and one well-calibrated potential gap hypothesis. Every task must reference this project's outcome or stage and provide a concrete deliverable, acceptance check, realistic effort estimate, and important dependency when relevant. For the gap, explain the project requirement that creates the risk, cite profile evidence or state that none was provided, and give one small test that would confirm or reject the hypothesis. For every strategy provide 3 ordered steps with a deliverable and done condition; explain when that path fits this project and its main trade-off. Keep resource lists empty; verified external sources are searched only when the user opens a specific resource path. Keep explanations concise but actionable. If the brief is ambiguous, lower confidence and ask only the most decision-relevant follow-up questions.\n\n${projectSummary(input)}` }];
    for (const fileId of uploadedFileIds) userContent.push({ type: 'input_file', file_id: fileId });
    const response = await openaiRequest('/responses', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      model: MODEL,
      instructions: SYSTEM_PROMPT,
      input: [{ role: 'user', content: userContent }],
      text: { format: { type: 'json_schema', name: 'assemble_project_analysis', strict: true, schema: analysisSchema } },
      max_output_tokens: 3600
    }) });
    const raw = textFromResponse(response);
    if (!raw) throw new Error('The model returned no structured output.');
    let result; try { result = JSON.parse(raw); } catch { throw new Error('The model output could not be parsed as JSON.'); }
    if (result.gap) result.gap.why = [result.gap.why, result.gap.evidence_basis ? `Evidence used: ${result.gap.evidence_basis}` : '', result.gap.validation_test ? `Quick validation: ${result.gap.validation_test}` : ''].filter(Boolean).join('\n\n');
    // Clamp untrusted model output before it reaches the UI.
    result.tasks = Array.isArray(result.tasks) ? result.tasks.slice(0, 10) : [];
    result.capability_observations = Array.isArray(result.capability_observations) ? result.capability_observations.slice(0, 5) : [];
    result.resource_strategies = Array.isArray(result.resource_strategies) ? result.resource_strategies.filter(x => ['LEARN', 'TOOL', 'PEOPLE'].includes(x.type)).slice(0, 3) : [];
    result.follow_up_questions = Array.isArray(result.follow_up_questions) ? result.follow_up_questions.slice(0, 4) : [];
    result.citations = citationsFromResponse(response);
    const citedUrls = new Set(result.citations.map(citation => citation.url));
    result.resource_strategies = result.resource_strategies.map(strategy => ({ ...strategy, steps: Array.isArray(strategy.steps) ? strategy.steps.slice(0, 5) : [], resources: (Array.isArray(strategy.resources) ? strategy.resources : []).filter(resource => { try { return citedUrls.has(new URL(resource.url).href); } catch { return false; } }).slice(0, 4) }));
    if (!result.tasks.length || !result.gap?.name) throw new Error('The model output is missing tasks or a gap hypothesis.');
    return result;
  } finally {
    await Promise.all(uploadedFileIds.map(deleteUploadedFile));
  }
}

function searchProfiles(query, category) {
  const terms = String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1);
  const pool = profiles.filter(p => category === 'ALL' || !category || p.category === category);
  return pool.map(p => {
    const haystack = [p.name, p.role, p.evidence, p.fit, ...(p.skills || []), ...(p.industries || [])].join(' ').toLowerCase();
    const score = terms.reduce((n, term) => n + (haystack.includes(term) ? 1 : 0), 0);
    return { p, score };
  }).sort((a, b) => b.score - a.score).slice(0, 6).map(x => ({ ...x.p, sampleData: true }));
}
async function agentChat(input) {
  const safeHistory = (Array.isArray(input.messages) ? input.messages : []).slice(-8).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 1400)
  })).filter(m => m.content);
  const context = `Current ASSEMBLE project context (may be incomplete):\n${JSON.stringify(input.context || {})}\n\nThe following messages are the recent chat. Answer the latest user message and retain context from the history.`;
  let apiInput = [{ role: 'user', content: context }, ...safeHistory];
  for (let round = 0; round < 3; round++) {
    const response = await openaiRequest('/responses', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      model: MODEL,
      instructions: SYSTEM_PROMPT,
      input: apiInput,
      tools: [searchTool],
      tool_choice: 'auto',
      max_output_tokens: 1200
    }) });
    const calls = (response.output || []).filter(item => item.type === 'function_call');
    if (!calls.length) {
      const answer = textFromResponse(response);
      if (!answer) throw new Error('The model returned an empty answer.');
      return { answer, toolCalls: round };
    }
    const outputs = [];
    for (const call of calls) {
      let args = {}; try { args = JSON.parse(call.arguments || '{}'); } catch { args = {}; }
      let result;
      if (call.name === 'search_candidate_profiles') {
        result = { profiles: searchProfiles(args.query, args.category), note: 'These are fictional demo profiles. Availability and willingness are unverified.' };
      } else {
        result = { error: 'Tool not found.' };
      }
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
    }
    apiInput = [...apiInput, ...(response.output || []), ...outputs];
  }
  throw new Error('Agent tool-call limit reached without a final answer. Try a more specific question.');
}
async function recommendResources(input) {
  const candidatesGiven = profiles.map(({ id, name, role, category, skills, evidence, fit, industries }) => ({ id, name, role, category, skills, evidence, fit, industries }));
  const userProfile = input.userProfile || {};
  const capabilities = (Array.isArray(userProfile.capabilities) ? userProfile.capabilities : []).slice(0, 20).map(item => ({ name: String(item.name || '').slice(0, 120), level: String(item.level || '').slice(0, 80), evidence: String(item.evidence || '').slice(0, 400) }));
  const workProjects = (Array.isArray(userProfile.workProjects) ? userProfile.workProjects : []).slice(0, 10).map(item => ({ title: String(item.title || '').slice(0, 160), role: String(item.role || '').slice(0, 120), description: String(item.description || '').slice(0, 600) }));
  const prompt = `Recommend up to three candidates from the provided local SAMPLE directory for this project and confirmed/potential gap. Use the user's relevant capability evidence and past projects to decide whether a collaborator should complement the user's existing strengths, not duplicate them. Tie each reason to a specific project need and candidate evidence; say when the profile lacks evidence. Rank by evidence and contextual relevance, not a made-up match percentage. Only use supplied candidate IDs; do not claim availability or interest. For each, state a short reason and unknowns. If no candidate is meaningfully relevant, return an empty list. These are self-reported user profile details; use them only for this recommendation and do not expose or repeat irrelevant personal details.\n\nProject: ${JSON.stringify(input.project || {})}\nGap: ${JSON.stringify(input.gap || {})}\nRelevant user capabilities: ${JSON.stringify(capabilities)}\nUser's past project evidence: ${JSON.stringify(workProjects)}\nResource path: PEOPLE\nCandidate directory: ${JSON.stringify(candidatesGiven)}`;
  const response = await openaiRequest('/responses', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    model: MODEL,
    instructions: SYSTEM_PROMPT,
    input: [{ role: 'user', content: prompt }],
    text: { format: { type: 'json_schema', name: 'assemble_resource_recommendations', strict: true, schema: recommendationSchema } },
    max_output_tokens: 1000
  }) });
  const raw = textFromResponse(response);
  const data = JSON.parse(raw || '{}');
  const byId = new Map(profiles.map(p => [p.id, p]));
  const recommendations = (data.recommendations || []).filter(r => byId.has(r.id)).slice(0, 3).map(r => ({
    ...byId.get(r.id), modelReason: String(r.reason || ''), unknowns: String(r.unknowns || 'Availability and willingness are unconfirmed.'), sampleData: true
  }));
  return { recommendations, note: 'Recommendations use a fictional local sample directory. Profiles, availability and willingness are not verified.' };
}

async function researchResources(input) {
  const project = input.project || {};
  const gap = input.gap || {};
  const safe = value => String(value || '').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email removed]').replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '[phone removed]').slice(0, 1200);
  const pathName = ['LEARN', 'TOOL', 'PEOPLE'].includes(input.path) ? input.path : 'LEARN';
  const prompt = `Find current, reliable resources for this specific project path. Use live web search. Prefer official documentation, public institutions, standards bodies, original research, and primary sources. Give 2-4 verified links. For each source, explain the exact project decision or task it supports, what to use first and how to apply it at the current stage, prerequisites and limitations, and whether the source verifies a free or paid option. Do not guess costs or invent links. End with one recommended first action that fits the stated time constraint and a measurable completion check. Never search for or reveal personal data. Only use the generic project topic, stage, time constraint, capability gap and chosen path below; this request deliberately contains no profile, resume, email, or project history.\n\nProject topic: ${safe(project.goal)}\nProject category: ${safe(project.projectType)}\nProject stage: ${safe(project.stage)}\nTime constraint: ${safe(project.time)}\nCapability gap: ${safe(gap.name)}\nWhy it matters: ${safe(gap.why)}\nChosen path: ${pathName}`;
  const response = await openaiRequest('/responses', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    model: MODEL,
    instructions: SYSTEM_PROMPT + '\n\nFor this request, do focused live research and cite sources that actually appear in the web search results. Do not make up links.',
    input: [{ role: 'user', content: prompt }],
    tools: [{ type: 'web_search' }],
    max_output_tokens: 1400
  }) });
  const answer = textFromResponse(response);
  if (!answer) throw new Error('The research step returned no answer.');
  return { answer, citations: citationsFromResponse(response) };
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
  const base = `http://${req.headers.host || `${HOST}:${PORT}`}`;
  const url = new URL(req.url, base);
  if (url.pathname.startsWith('/api/auth/')) {
    if (req.method === 'POST') {
      const limit = rateLimit(req, url.pathname);
      if (!limit.allowed) { res.setHeader('Retry-After', String(limit.retryAfter)); return json(res, 429, { error: 'RATE_LIMITED', message: '尝试次数过多，请稍后再试。' }); }
    }
    return await handleAccountRoutes(req, res, url);
  }
  if (url.pathname === '/api/profile' || url.pathname === '/api/projects' || /^\/api\/projects\/[0-9a-f-]{36}$/i.test(url.pathname)) {
    const limit = rateLimit(req, url.pathname.startsWith('/api/projects/') ? '/api/projects' : url.pathname);
    if (!limit.allowed) { res.setHeader('Retry-After', String(limit.retryAfter)); return json(res, 429, { error: 'RATE_LIMITED', message: '保存请求过于频繁，请稍后再试。' }); }
    return await handleUserDataRoutes(req, res, url);
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return json(res, 200, { configured: Boolean(API_KEY), model: MODEL, api: 'OpenAI Responses API', toolCalling: true, localProfiles: profiles.length, accountsEnabled: Boolean(pool) });
  }
  if (req.method === 'POST' && ['/api/analyze', '/api/chat', '/api/recommend', '/api/research'].includes(url.pathname)) {
    const limit = rateLimit(req, url.pathname);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter));
      return json(res, 429, { error: 'RATE_LIMITED', message: 'Too many requests from this network address. Please wait before trying again.' });
    }
    if (activeApiRequests >= MAX_CONCURRENT_API_REQUESTS) return json(res, 503, { error: 'SERVER_BUSY', message: 'The service is handling several requests. Please retry shortly.' });
    activeApiRequests++;
    try {
      if (pool) {
        let user;
        try { user = await currentUser(req); }
        catch (error) { console.error('Session lookup failed:', error.message); return json(res, 503, { error: 'DATABASE_UNAVAILABLE', message: '账号数据库暂时不可用，请稍后重试。' }); }
        if (!user) return json(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录账号，再使用项目分析与 Agent 功能。' });
        const userLimit = rateLimit(req, url.pathname, `account:${user.id}`);
        if (!userLimit.allowed) { res.setHeader('Retry-After', String(userLimit.retryAfter)); return json(res, 429, { error: 'ACCOUNT_RATE_LIMITED', message: '该账号本时段的请求次数已达到上限，请稍后再试。' }); }
      }
      const input = await readBody(req);
      if (url.pathname === '/api/analyze') return json(res, 200, await analyzeProject(input));
      if (url.pathname === '/api/chat') return json(res, 200, await agentChat(input));
      if (url.pathname === '/api/recommend') return json(res, 200, await recommendResources(input));
      if (url.pathname === '/api/research') return json(res, 200, await researchResources(input));
    } catch (error) {
      const e = publicApiError(error);
      return json(res, e.status || 500, { error: e.code || 'REQUEST_FAILED', message: e.message || 'The request could not be completed.' });
    } finally { activeApiRequests--; }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
  catch { return json(res, 400, { error: 'BAD_PATH', message: 'Invalid path.' }); }
  // Serve only the UI file. Never expose .env, server.js, candidate data, or other local files.
  if (pathname !== '/index.html') return json(res, 404, { error: 'NOT_FOUND', message: 'File not found.' });
  const target = path.join(ROOT, 'index.html');
  fs.readFile(target, (error, data) => {
    if (error) return json(res, 404, { error: 'NOT_FOUND', message: 'File not found.' });
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
});
async function startServer() {
  if (process.env.NODE_ENV === 'production' && !pool) throw new Error('DATABASE_URL is required in production to enable secure user accounts and persistent profiles.');
  if (pool) await initializeDatabase();
  server.listen(PORT, HOST, () => {
    console.log(`ASSEMBLE server listening on ${HOST}:${PORT}`);
    console.log(`Model: ${MODEL}`);
    console.log(`API key: ${API_KEY ? 'configured' : 'not configured (add OPENAI_API_KEY to .env)'}`);
    console.log(`Cloud accounts: ${pool ? 'enabled' : 'disabled (configure DATABASE_URL)'}`);
  });
}
startServer().catch(error => { console.error('ASSEMBLE startup failed:', error.message); process.exitCode = 1; });
