import { EXTENSION_NAME } from './constants';
import { ensureLocalSettings, updateLocalString } from './settings';
import { state } from './state';
import { getCtx, getRequestHeaders, log } from './st-context';

type ExtensionType = 'global' | 'local' | 'system';

type ExtensionVersionInfo = {
  externalId: string;
  type: ExtensionType | null;
  global: boolean;
  currentBranchName?: string;
  currentCommitHash?: string;
  isUpToDate?: boolean;
  remoteUrl?: string;
};

const REPO_URLS = Object.freeze([
  'https://github.com/Lianues/cocktail-plus',
  'https://gitee.com/lianues/cocktail-plus',
]);
const DEFAULT_REMOTE_MANIFEST_URLS = Object.freeze([
  'https://raw.githubusercontent.com/Lianues/cocktail-plus/main/manifest.json',
  'https://gitee.com/lianues/cocktail-plus/raw/main/manifest.json',
  'https://raw.giteeusercontent.com/lianues/cocktail-plus/raw/main/manifest.json',
]);

let promptedUpdateVersionThisSession = '';

function normalizeVersionString(version: unknown) {
  return String(version ?? '').trim();
}

function parseSemver(version: unknown) {
  const v = normalizeVersionString(version);
  const m = v.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}

function compareSemver(a: unknown, b: unknown) {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  if (!av || !bv) return 0;
  for (let i = 0; i < 3; i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function toast(type: 'success' | 'info' | 'warning' | 'error', message: string, title = '鸡尾酒+') {
  try { (globalThis as any).toastr?.[type]?.(message, title, { timeOut: type === 'error' ? 6000 : 3500 }); } catch { /* ignore */ }
}

async function fetchJsonWithTimeout(url: string, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function getLocalManifestUrl() {
  try {
    const url = new URL(import.meta.url);
    url.pathname = url.pathname.replace(/\/dist\/index\.js$/, '/manifest.json');
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return `${location.origin}/scripts/extensions/third-party/${EXTENSION_NAME}/manifest.json`;
  }
}

export function getUpdateRepoUrl() {
  return REPO_URLS[0];
}

export function getUpdateRepoUrls() {
  return [...REPO_URLS];
}

async function getCurrentVersion() {
  const local = await fetchJsonWithTimeout(getLocalManifestUrl(), 5000);
  const version = normalizeVersionString(local?.version);
  return version || null;
}

function encodePathPart(value: string) {
  return value.split('/').map(part => encodeURIComponent(part)).join('/');
}

function normalizeBranchName(branch: unknown) {
  const value = normalizeVersionString(branch).replace(/^origin\//, '');
  return value || 'main';
}

function parseRemoteRepo(remoteUrl: unknown) {
  const raw = normalizeVersionString(remoteUrl)
    .replace(/[?#].*$/, '')
    .replace(/\.git$/, '');
  if (!raw) return null;

  const github = raw.match(/github\.com[:/]([^/\s:]+)\/([^/\s]+)$/i);
  if (github) return { provider: 'github' as const, owner: github[1], repo: github[2] };

  const gitee = raw.match(/gitee\.com[:/]([^/\s:]+)\/([^/\s]+)$/i);
  if (gitee) return { provider: 'gitee' as const, owner: gitee[1], repo: gitee[2] };

  return null;
}

function uniqueUrls(groups: string[][]) {
  const seen = new Set<string>();
  return groups
    .map(group => group.filter(url => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    }))
    .filter(group => group.length > 0);
}

function getRemoteManifestUrlGroups(info?: ExtensionVersionInfo | null) {
  const remote = parseRemoteRepo(info?.remoteUrl);
  const branch = encodePathPart(normalizeBranchName(info?.currentBranchName));
  const fallback = [...DEFAULT_REMOTE_MANIFEST_URLS];

  if (!remote) return [fallback];

  if (remote.provider === 'github') {
    return uniqueUrls([
      [`https://raw.githubusercontent.com/${remote.owner}/${remote.repo}/${branch}/manifest.json`],
      fallback,
    ]);
  }

  return uniqueUrls([
    [
      `https://gitee.com/${remote.owner}/${remote.repo}/raw/${branch}/manifest.json`,
      `https://raw.giteeusercontent.com/${remote.owner}/${remote.repo}/raw/${branch}/manifest.json`,
    ],
    fallback,
  ]);
}

async function getLatestVersion(info?: ExtensionVersionInfo | null) {
  for (const group of getRemoteManifestUrlGroups(info)) {
    for (const url of group) {
      try {
        const remote = await fetchJsonWithTimeout(url, 8000);
        const version = normalizeVersionString(remote?.version);
        if (version) return { version, raw: remote, source: url };
      } catch {
        // Try next URL in this source group, then fallback group.
      }
    }
  }
  return null;
}

function guessExternalId() {
  try {
    const path = new URL(import.meta.url).pathname || '';
    const marker = '/scripts/extensions/third-party/';
    const idx = path.indexOf(marker);
    if (idx === -1) return `/${EXTENSION_NAME}`;
    const rest = path.slice(idx + marker.length);
    const folder = rest.split('/')[0];
    return folder ? `/${folder}` : `/${EXTENSION_NAME}`;
  } catch {
    return `/${EXTENSION_NAME}`;
  }
}

function externalIdToDiscoverName(externalId: string) {
  const folder = String(externalId || '').replace(/^\//, '').trim();
  return folder ? `third-party/${folder}` : null;
}

async function discoverExtensionType(externalId: string) {
  const name = externalIdToDiscoverName(externalId);
  if (!name) return null;
  try {
    const response = await fetch('/api/extensions/discover', {
      method: 'GET',
      headers: getRequestHeaders(),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const list = await response.json();
    if (!Array.isArray(list)) return null;
    const hit = list.find(item => item && typeof item === 'object' && item.name === name);
    const type = hit?.type;
    return type === 'global' || type === 'local' || type === 'system' ? type as ExtensionType : null;
  } catch {
    return null;
  }
}

async function getInstalledExtensionInfo(): Promise<ExtensionVersionInfo> {
  const externalId = guessExternalId();
  const type = await discoverExtensionType(externalId);
  const base: ExtensionVersionInfo = { externalId, type, global: type === 'global' };

  if (type === 'system') return base;

  try {
    const response = await fetch('/api/extensions/version', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({ extensionName: externalId, global: type === 'global' }),
      cache: 'no-store',
    });
    if (!response.ok) return base;
    const data = await response.json().catch(() => ({}));
    return { ...base, ...data };
  } catch {
    return base;
  }
}

async function updateFrontendViaApi() {
  const externalId = guessExternalId();
  const type = await discoverExtensionType(externalId);
  const response = await fetch('/api/extensions/update', {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({ extensionName: externalId, global: type === 'global' }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || response.statusText || String(response.status));
  }
  const data = await response.json().catch(() => ({}));
  return { ...data, externalId, type, global: type === 'global' };
}

export async function checkForUpdates(options: { manual?: boolean; prompt?: boolean } = {}) {
  if (state.update.checking) return state.update;
  state.update.checking = true;
  state.update.error = null;

  try {
    ensureLocalSettings();
    const currentVersion = await getCurrentVersion();
    const installedInfo = await getInstalledExtensionInfo();
    const latest = await getLatestVersion(installedInfo);
    const latestVersion = latest?.version ?? null;
    const updateAvailable = !!currentVersion && !!latestVersion && compareSemver(latestVersion, currentVersion) > 0;

    state.update = {
      ...state.update,
      checking: false,
      checked: true,
      currentVersion,
      latestVersion,
      updateAvailable,
      error: null,
      lastCheckedAt: Date.now(),
    };

    if (updateAvailable) {
      const skipped = normalizeVersionString(state.localSettings.skippedUpdateVersion);
      if (skipped && skipped === latestVersion && !options.manual) return state.update;
      if (skipped && compareSemver(latestVersion, skipped) > 0) updateLocalString('skippedUpdateVersion', '');
      if (options.prompt) {
        if (!options.manual && promptedUpdateVersionThisSession === latestVersion) return state.update;
        promptedUpdateVersionThisSession = latestVersion;
        await promptAndMaybeUpdate(currentVersion, latestVersion);
      }
    } else if (options.manual) {
      toast('info', currentVersion ? `当前已是最新版本：${currentVersion}` : '无法读取本地版本。');
    }

    return state.update;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.update = {
      ...state.update,
      checking: false,
      checked: true,
      error: message,
      lastCheckedAt: Date.now(),
    };
    if (options.manual) toast('error', message, '检查更新失败');
    return state.update;
  }
}

async function promptAndMaybeUpdate(currentVersion: string | null, latestVersion: string) {
  const ctx = getCtx();
  const Popup = ctx?.Popup;
  const POPUP_RESULT = ctx?.POPUP_RESULT;
  const skipResult = Number(POPUP_RESULT?.CUSTOM1 ?? 1001);
  const title = '鸡尾酒+ 发现新版本';
  const text = `当前版本：${currentVersion || '-'}\n最新版本：${latestVersion}\n\n是否现在更新前端扩展？\n后端扩展是全局服务，如需更新/卸载后端，请使用面板中的后端插件脚本助手。`;

  let action: 'update' | 'skip' | 'later' = 'later';
  try {
    if (Popup?.show?.confirm && POPUP_RESULT) {
      const result = await Popup.show.confirm(title, text, {
        okButton: '更新并刷新',
        cancelButton: '稍后',
        customButtons: [{ text: '跳过此版本', result: skipResult, appendAtEnd: true }],
        defaultResult: POPUP_RESULT.NEGATIVE,
      });
      if (result === POPUP_RESULT.AFFIRMATIVE) action = 'update';
      else if (result === skipResult) action = 'skip';
    } else {
      action = globalThis.confirm(`${title}\n\n${text}`) ? 'update' : 'later';
    }
  } catch {
    action = 'later';
  }

  if (action === 'skip') {
    updateLocalString('skippedUpdateVersion', latestVersion);
    toast('info', `已跳过 ${latestVersion}，此版本将不再自动提醒。`);
    return;
  }
  if (action === 'update') await performUpdate();
}

export async function performUpdate() {
  if (state.update.checking) return;
  state.update.checking = true;
  state.update.error = null;

  try {
    const expectedVersion = normalizeVersionString(state.update.latestVersion);
    toast('info', '开始更新前端扩展…');
    const frontendResult = await updateFrontendViaApi();
    log('frontend update result', frontendResult);

    await sleep(300);
    const currentAfterUpdate = await getCurrentVersion().catch(() => null);
    if (expectedVersion && currentAfterUpdate && compareSemver(currentAfterUpdate, expectedVersion) < 0) {
      const reason = frontendResult?.isUpToDate
        ? '更新接口认为当前安装源已经是最新，但检查源显示还有更新。'
        : '更新接口返回成功，但当前页面加载的扩展副本仍是旧版本。';
      const message = `${reason}\n当前仍为 ${currentAfterUpdate}，目标为 ${expectedVersion}。常见原因：GitHub/Gitee 安装源或分支不同步，或同时存在 local/global 两个 cocktail-plus 副本。若扩展管理里需要卸载两次，通常就是双副本；请删除旧副本或等待对应安装源同步后再更新。`;
      state.update = {
        ...state.update,
        checking: false,
        checked: true,
        currentVersion: currentAfterUpdate,
        latestVersion: expectedVersion,
        updateAvailable: true,
        error: message,
        lastCheckedAt: Date.now(),
      };
      toast('warning', message, '前端扩展更新未生效');
      return;
    }

    updateLocalString('skippedUpdateVersion', '');
    if (currentAfterUpdate) {
      state.update.currentVersion = currentAfterUpdate;
      state.update.updateAvailable = expectedVersion ? compareSemver(expectedVersion, currentAfterUpdate) > 0 : false;
    }

    toast('success', '前端扩展已更新。后端扩展是全局服务，如需更新请使用“后端插件脚本助手”。');

    await sleep(800);
    try { globalThis.location?.reload?.(); } catch { /* ignore */ }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.update.error = message;
    toast('error', message, '扩展更新失败');
  } finally {
    state.update.checking = false;
  }
}

export async function startAutoUpdateCheck(onDone?: () => void) {
  ensureLocalSettings();
  if (!state.localSettings.autoCheckUpdates) return;
  await sleep(1200);
  void checkForUpdates({ manual: false, prompt: true })
    .catch(error => log('auto update check failed', error instanceof Error ? error.message : String(error)))
    .finally(() => { try { onDone?.(); } catch { /* ignore */ } });
}
