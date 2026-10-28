// P0 connectivity probe only. This module never accepts conversation content.
// API contract: https://docs.github.com/en/rest/repos/contents
const API_ROOT = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const TIMEOUT_MS = 15_000;
export const PROBE_PATH = 'collector-probe/connection-check.json';
export const PROBE_CONTENT = JSON.stringify({
  schemaVersion: 1,
  product: 'ai-memory-collector',
  name: 'github-connection-check',
  version: '0.1.0',
  synthetic: true,
}, null, 2) + '\n';

export class GitHubProbeError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'GitHubProbeError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new GitHubProbeError(code, message, status);
}

function validateInput({ owner, repo, branch, token, fetchImpl = globalThis.fetch }) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    fail('INVALID_REPOSITORY', '请填写有效的 GitHub 仓库所有者。');
  }
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === '.' || repo === '..') {
    fail('INVALID_REPOSITORY', '请填写有效的 GitHub 仓库名称。');
  }
  if (typeof token !== 'string' || token.length < 1 || token.length > 1024 || /[\s\x00-\x1f\x7f]/.test(token)) {
    fail('INVALID_TOKEN', '请填写 GitHub Token；不要包含空白字符。');
  }
  if (branch != null && branch !== '') validateBranch(branch);
  if (typeof fetchImpl !== 'function') fail('INVALID_CLIENT', 'GitHub 网络客户端不可用。');
  return { owner, repo, branch: branch || null, token, fetchImpl };
}

function validateBranch(branch) {
  if (typeof branch !== 'string' || branch.length > 240 || !branch.length ||
      /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{') ||
      branch === '@' || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') ||
      branch.endsWith('.') || branch.includes('//') ||
      branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) {
    fail('INVALID_BRANCH', '请填写有效的 Git 分支名。');
  }
}

function client(input) {
  const config = validateInput(input);
  const base = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  async function request(suffix = '', { method = 'GET', body, allowed = [] } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      // Browser fetch requires its Window/Worker receiver, not the config object.
      const response = await config.fetchImpl.call(globalThis, `${API_ROOT}${base}${suffix}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${config.token}`,
          'X-GitHub-Api-Version': API_VERSION,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (allowed.includes(response.status)) return { status: response.status, data: null };
      if (!response.ok) {
        const status = response.status;
        if (status === 401) fail('AUTH_REQUIRED', 'GitHub 授权失效，请检查 Token。', status);
        if (status === 403 || status === 429) fail('ACCESS_OR_RATE_LIMIT', 'GitHub 拒绝访问或正在限流，请检查权限并稍后重试。', status);
        if (status === 404) fail('NOT_FOUND', '未找到仓库或分支，或当前 Token 无权访问。', status);
        if (status === 409 || status === 422) fail('CONFLICT', '远端状态冲突或请求被拒绝，未覆盖现有内容。', status);
        fail('HTTP_ERROR', `GitHub 请求失败（HTTP ${status}）。`, status);
      }
      let data;
      try { data = await response.json(); }
      catch { fail('INVALID_RESPONSE', 'GitHub 返回了无法解析的响应。'); }
      return { status: response.status, data };
    } catch (error) {
      if (error instanceof GitHubProbeError) throw error;
      // Never forward response bodies, URLs, headers, or raw exception messages.
      fail(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK',
        controller.signal.aborted ? 'GitHub 请求超时，请检查网络后重试。' : 'GitHub 网络请求失败，请检查网络后重试。');
    } finally {
      clearTimeout(timer);
    }
  }
  return { config, request };
}

function isSha(value) { return typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value); }

async function inspectRepository(api) {
  const { data } = await api.request();
  if (!data || data.private !== true) fail('PRIVATE_REPOSITORY_REQUIRED', 'P0 只允许连接私有数据仓库，请勿使用公开代码仓库。');
  if (data.archived === true || data.disabled === true) fail('READ_ONLY_REPOSITORY', '仓库已归档或停用，不能执行提交验证。');
  const defaultBranch = typeof data.default_branch === 'string' && data.default_branch ? data.default_branch : 'main';
  const branch = api.config.branch || defaultBranch;
  validateBranch(branch);
  const ref = await api.request(`/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { allowed: [404, 409] });
  let headSha = null;
  let empty = false;
  if (ref.status === 200 && ref.data?.object?.type === 'commit' && isSha(ref.data.object.sha)) {
    headSha = ref.data.object.sha;
  } else if (ref.status === 404 || ref.status === 409) {
    // A missing branch is not evidence of an empty repository.
    const branches = await api.request('/branches?per_page=1');
    if (!Array.isArray(branches.data)) fail('INVALID_RESPONSE', '无法确认仓库分支状态。');
    if (branches.data.length) fail('BRANCH_NOT_FOUND', '指定分支不存在；P0 不自动创建已有仓库的新分支。');
    if (api.config.branch && api.config.branch !== defaultBranch) {
      fail('EMPTY_REPOSITORY_BRANCH', '空仓库首次验证请使用默认分支，P0 不创建其他分支。');
    }
    empty = true;
  } else {
    fail('INVALID_RESPONSE', '无法确认目标分支的提交。');
  }
  return {
    owner: api.config.owner,
    repo: api.config.repo,
    private: true,
    defaultBranch,
    branch,
    headSha,
    empty,
  };
}

/** Read-only. No Token or raw GitHub metadata is returned. */
export async function probeRepository(input) {
  return inspectRepository(client(input));
}

function encodeProbe() {
  // Fixed ASCII-only payload. Conversation text cannot enter this path.
  return btoa(PROBE_CONTENT);
}

async function readProbe(api, branch) {
  const result = await api.request(`/contents/${PROBE_PATH}?ref=${encodeURIComponent(branch)}`, { allowed: [404] });
  if (result.status === 404) return null;
  const file = result.data;
  if (!file || file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' ||
      file.size > 16_384 || file.content.length > 24_000 || !isSha(file.sha)) {
    fail('PROBE_PATH_CONFLICT', '验证路径已被其他内容占用，未覆盖。');
  }
  let content;
  try { content = atob(file.content.replace(/\s/g, '')); }
  catch { fail('INVALID_RESPONSE', '验证文件无法读取，未覆盖。'); }
  if (content !== PROBE_CONTENT) fail('PROBE_PATH_CONFLICT', '验证路径已有不同内容，未覆盖。');
  return { sha: file.sha };
}

/** Explicit synthetic write probe. It never uploads archived conversations. */
export async function commitProbe(input) {
  const api = client(input);
  const info = await inspectRepository(api);
  const existing = info.empty ? null : await readProbe(api, info.branch);
  const result = (status, commitSha, writeVerified) => ({
    status,
    path: PROBE_PATH,
    branch: info.branch,
    commitSha,
    readbackVerified: true,
    writeVerified,
  });
  if (existing) return result('already-present', null, false);

  let written;
  try {
    written = await api.request(`/contents/${PROBE_PATH}`, {
      method: 'PUT',
      body: {
        message: 'chore: verify AI Memory Collector connection',
        content: encodeProbe(),
        ...(info.empty ? {} : { branch: info.branch }),
      },
    });
  } catch (error) {
    const mayHaveWritten = ['TIMEOUT', 'NETWORK', 'CONFLICT', 'INVALID_RESPONSE'].includes(error.code) || error.status >= 500;
    if (!mayHaveWritten) throw error;
    try {
      if (await readProbe(api, info.branch)) return result('recovered', null, false);
    } catch (readError) {
      if (readError.code === 'PROBE_PATH_CONFLICT') throw readError;
    }
    fail('WRITE_UNCONFIRMED', '提交结果尚未确认；未自动重写，请重新检查连接。');
  }
  let confirmed;
  try { confirmed = await readProbe(api, info.branch); }
  catch (error) {
    if (error.code === 'PROBE_PATH_CONFLICT') throw error;
    fail('WRITE_UNCONFIRMED', '提交已返回，但读回验证失败；请重新检查连接。');
  }
  if (!confirmed) fail('WRITE_UNCONFIRMED', '提交后未能读回验证文件，请重新检查连接。');
  if (!isSha(written.data?.commit?.sha)) {
    return result('recovered', null, false);
  }
  return result('created', written.data.commit.sha, true);
}

// Shared transport for production archive sync. Credentials remain in this client.
export { client as createGitHubClient, inspectRepository as inspectGitHubRepository };
