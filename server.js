'use strict';

// ASSEMBLE local API server. Uses Node.js built-ins only; no npm install required.
// API credentials stay on the server and are never exposed to the browser.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { URL } = require('node:url');

const ROOT = __dirname;
const HOST = process.env.ASSEMBLE_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const PORT = Number(process.env.PORT || 4173);
const ENV_FILE = path.join(ROOT, '.env');
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const API_RATE_LIMITS = { '/api/analyze': 5, '/api/chat': 30, '/api/recommend': 10 };
const MAX_CONCURRENT_API_REQUESTS = 6;
const rateLimitBuckets = new Map();
let activeApiRequests = 0;

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

const MODEL = process.env.OPENAI_MODEL || 'gpt-6-astra';
const configuredApiKey = (process.env.OPENAI_API_KEY || '').trim();
const API_KEY = /^(?:replace_with_your_api_key|your_openai_api_key)$/i.test(configuredApiKey) ? '' : configuredApiKey;
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, 'candidates.json'), 'utf8'));

const SYSTEM_PROMPT = `You are ASSEMBLE, an AI agent for project resource orchestration. You help project initiators understand what their project requires, identify possible capability gaps, and choose between LEARN, TOOL, and PEOPLE resources.

Operating principles:
1. Diagnose before matching. First understand the intended outcome, stage, constraints and what is already known.
2. Evidence before assumption. Distinguish provided evidence, inference and unknowns. Missing profile evidence does NOT prove missing ability.
3. Do not default to hiring. A gap may be addressed by learning, an existing tool, narrowing scope, or a person.
4. Explain reasoning in concise, user-friendly terms and expose uncertainty. Ask a clarifying question only when it would materially change the recommendation.
5. The user has authority. Present drafts, ask for corrections, and never claim that you changed a profile, contacted someone, sent an invitation, or executed an external action.
6. Candidate data in this prototype is fictional sample data. Always identify it as simulated when relevant. Do not invent candidate profiles or claim availability or interest is verified.
7. Prefer Chinese when the user writes Chinese; mirror the user's language.
8. Keep answers structured and specific to the supplied project context. Do not disclose hidden reasoning; give concise reasons and evidence instead.`;

const analysisSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    project_summary: { type: 'string' },
    tasks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      title: { type: 'string' }, description: { type: 'string' }, capability: { type: 'string' }
    }, required: ['title', 'description', 'capability'] } },
    gap: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string' }, why: { type: 'string' }, confidence: { type: 'string', enum: ['Low', 'Low-medium', 'Medium', 'High'] }
    }, required: ['name', 'why', 'confidence'] },
    capability_observations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string' }, status: { type: 'string', enum: ['Evidence found', 'Some evidence', 'Unknown'] }, evidence: { type: 'string' }
    }, required: ['name', 'status', 'evidence'] } },
    resource_strategies: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      type: { type: 'string', enum: ['LEARN', 'TOOL', 'PEOPLE'] }, title: { type: 'string' }, rationale: { type: 'string' }, tradeoff: { type: 'string' }
    }, required: ['type', 'title', 'rationale', 'tradeoff'] } },
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
function clientAddress(req) {
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (net.isIP(forwarded)) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}
function rateLimit(req, pathname) {
  const now = Date.now();
  const key = `${clientAddress(req)}:${pathname}`;
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
    const userContent = [{ type: 'input_text', text: `Analyze this project for ASSEMBLE. Treat the output as a provisional, editable draft. Use the user's profile, capability examples, resume and past projects as self-reported evidence; do not infer a skill gap solely from missing profile information. Return 4–8 actionable tasks, up to 5 capability observations, all three resource strategies (LEARN, TOOL, PEOPLE), and one well-calibrated potential gap hypothesis. Keep explanations concise and specific. If the brief is ambiguous, lower confidence and include a follow-up question.\n\n${projectSummary(input)}` }];
    for (const fileId of uploadedFileIds) userContent.push({ type: 'input_file', file_id: fileId });
    const response = await openaiRequest('/responses', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      model: MODEL,
      instructions: SYSTEM_PROMPT,
      input: [{ role: 'user', content: userContent }],
      text: { format: { type: 'json_schema', name: 'assemble_project_analysis', strict: true, schema: analysisSchema } },
      max_output_tokens: 2000
    }) });
    const raw = textFromResponse(response);
    if (!raw) throw new Error('The model returned no structured output.');
    let result; try { result = JSON.parse(raw); } catch { throw new Error('The model output could not be parsed as JSON.'); }
    // Clamp untrusted model output before it reaches the UI.
    result.tasks = Array.isArray(result.tasks) ? result.tasks.slice(0, 10) : [];
    result.capability_observations = Array.isArray(result.capability_observations) ? result.capability_observations.slice(0, 5) : [];
    result.resource_strategies = Array.isArray(result.resource_strategies) ? result.resource_strategies.filter(x => ['LEARN', 'TOOL', 'PEOPLE'].includes(x.type)).slice(0, 3) : [];
    result.follow_up_questions = Array.isArray(result.follow_up_questions) ? result.follow_up_questions.slice(0, 4) : [];
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
  const prompt = `Recommend up to three candidates from the provided local SAMPLE directory for this project and confirmed/potential gap. Rank by capability evidence and contextual relevance, not a made-up match percentage. Only use supplied candidate IDs; do not claim availability or interest. For each, state a short reason and unknowns. If no candidate is meaningfully relevant, return an empty list.\n\nProject: ${JSON.stringify(input.project || {})}\nGap: ${JSON.stringify(input.gap || {})}\nResource path: PEOPLE\nCandidate directory: ${JSON.stringify(candidatesGiven)}`;
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

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
  const base = `http://${req.headers.host || `${HOST}:${PORT}`}`;
  const url = new URL(req.url, base);
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return json(res, 200, { configured: Boolean(API_KEY), model: MODEL, api: 'OpenAI Responses API', toolCalling: true, localProfiles: profiles.length });
  }
  if (req.method === 'POST' && ['/api/analyze', '/api/chat', '/api/recommend'].includes(url.pathname)) {
    const limit = rateLimit(req, url.pathname);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter));
      return json(res, 429, { error: 'RATE_LIMITED', message: 'Too many requests from this network address. Please wait before trying again.' });
    }
    if (activeApiRequests >= MAX_CONCURRENT_API_REQUESTS) return json(res, 503, { error: 'SERVER_BUSY', message: 'The service is handling several requests. Please retry shortly.' });
    activeApiRequests++;
    try {
      const input = await readBody(req);
      if (url.pathname === '/api/analyze') return json(res, 200, await analyzeProject(input));
      if (url.pathname === '/api/chat') return json(res, 200, await agentChat(input));
      if (url.pathname === '/api/recommend') return json(res, 200, await recommendResources(input));
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
server.listen(PORT, HOST, () => {
  console.log(`ASSEMBLE local server: http://${HOST}:${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`API key: ${API_KEY ? 'configured' : 'not configured (add OPENAI_API_KEY to .env)'}`);
  console.log('For local development only; server binds to localhost. Do not expose directly to the public internet.');
});
