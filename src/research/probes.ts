import { createHash } from "node:crypto";

export interface TrustedProbeProject {
  id: string;
  pageIds: string[];
  pageCardCount: number;
  expectedPageCount: number | null;
  paginationDetected: boolean;
}

export interface ProjectsRootProbe {
  host: string;
  route: string;
  href: string;
  authenticated: boolean;
  uiReady: boolean;
  projectIds: string[];
  projectCardCount: number;
  projectPaginationDetected: boolean;
  failures: Array<{ code: string }>;
}

export interface IdentityProbe {
  host: string;
  route: string;
  href: string;
  authenticated: boolean;
  uiReady: boolean;
  stableAccountIdentity: string | null;
  accountIdentitySource:
    | "identity_hidden_useruid"
    | "identity_global_username"
    | null;
}

export interface ProjectPagesProbe extends TrustedProbeProject {
  host: string;
  route: string;
  href: string;
  authenticated: boolean;
  uiReady: boolean;
  expectedProjectCount: number | null;
  failures: Array<{ code: string; projectId?: string }>;
}

export const PROJECTS_ROOT_DOM_PROBE = String.raw`(() => {
  const canonicalId = (value) => {
    const normalized = String(value == null ? '' : value).trim();
    return /^[1-9]\d*$/.test(normalized) ? normalized : null;
  };
  const parsedUrl = (value, base) => {
    try { return new URL(value, base); } catch { return null; }
  };
  const authenticated = Array.from(document.querySelectorAll('a[href]')).some((anchor) => {
    const url = parsedUrl(anchor.getAttribute('href'), location.href);
    return url && url.origin === location.origin && url.pathname === '/login/exit/';
  });
  const projectIds = new Set();
  for (const element of document.querySelectorAll('[data-project-id]')) {
    const id = canonicalId(element.getAttribute('data-project-id'));
    if (id) projectIds.add(id);
  }
  for (const anchor of document.querySelectorAll('a[href]')) {
    const url = parsedUrl(anchor.getAttribute('href'), location.href);
    if (!url || url.origin !== location.origin || url.pathname !== '/projects/') continue;
    const id = canonicalId(url.searchParams.get('projectid') || url.searchParams.get('projectId'));
    if (id) projectIds.add(id);
  }

  const failures = [];
  const projectCards = Array.from(document.querySelectorAll('.td-sites-grid__item'));
  const cardProjectIds = new Set();
  for (const card of projectCards) {
    const ids = new Set(Array.from(card.querySelectorAll('[data-project-id]'))
      .map((element) => canonicalId(element.getAttribute('data-project-id')))
      .filter(Boolean));
    if (ids.size !== 1) failures.push({ code: 'PROJECT_CARD_IDENTITY_AMBIGUOUS' });
    else cardProjectIds.add(Array.from(ids)[0]);
  }
  if (cardProjectIds.size !== projectIds.size || Array.from(cardProjectIds).some((id) => !projectIds.has(id))) {
    failures.push({ code: 'PROJECT_CARD_SET_MISMATCH' });
  }
  const projectPaginationDetected = Array.from(document.querySelectorAll('a[href]')).some((anchor) => {
    if ((anchor.getAttribute('rel') || '').split(/\s+/).includes('next')) return true;
    const url = parsedUrl(anchor.getAttribute('href'), location.href);
    if (!url || url.origin !== location.origin || url.pathname !== '/projects/' || url.searchParams.has('projectid') || url.searchParams.has('projectId')) return false;
    return ['offset', 'p', 'page', 'pagenum', 'start'].some((key) => url.searchParams.has(key));
  });
  return {
    host: location.hostname,
    route: location.pathname,
    href: location.href,
    authenticated,
    uiReady: document.readyState === 'complete' && Boolean(document.querySelector('.td-sites-grid, input[type="password"]') || /\/login|\/signin/i.test(location.pathname)),
    projectIds: Array.from(projectIds).sort((a, b) => a.length - b.length || a.localeCompare(b)),
    projectCardCount: projectCards.length,
    projectPaginationDetected,
    failures
  };
})()`;

export const IDENTITY_DOM_PROBE = String.raw`(() => {
  const canonicalId = (value) => {
    const normalized = String(value == null ? '' : value).trim();
    return /^[1-9]\d*$/.test(normalized) ? normalized : null;
  };
  const stableUsername = (value) => {
    if (typeof value !== 'string' || value.length < 1 || value.length > 256) return null;
    if (Array.from(value).length > 128 || value !== value.trim() || value !== value.normalize('NFC')) return null;
    return /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u.test(value) ? null : value;
  };
  const authenticated = Array.from(document.querySelectorAll('a[href]')).some((anchor) => {
    try {
      const url = new URL(anchor.getAttribute('href'), location.href);
      return url.origin === location.origin && url.pathname === '/login/exit/';
    } catch { return false; }
  });
  const hiddenInputs = Array.from(document.querySelectorAll('input[type="hidden"][name="useruid"]'));
  const hiddenValues = hiddenInputs.map((input) => canonicalId(input.getAttribute('value')));
  const hiddenCandidates = new Set(hiddenValues.filter(Boolean));
  const hiddenIdentity = hiddenInputs.length > 0 && hiddenValues.every(Boolean) && hiddenCandidates.size === 1
    ? Array.from(hiddenCandidates)[0]
    : null;
  const usernameDescriptor = hiddenInputs.length === 0
    ? Object.getOwnPropertyDescriptor(globalThis, 'username')
    : null;
  const usernameIdentity = usernameDescriptor && Object.prototype.hasOwnProperty.call(usernameDescriptor, 'value')
    ? stableUsername(usernameDescriptor.value)
    : null;
  return {
    host: location.hostname,
    route: location.pathname,
    href: location.href,
    authenticated,
    uiReady: document.readyState === 'complete' && Boolean(document.querySelector('input[name="useruid"], .td-maincontainer, [class*="identity" i], input[type="password"]') || /\/login|\/signin/i.test(location.pathname)),
    stableAccountIdentity: hiddenIdentity || usernameIdentity,
    accountIdentitySource: hiddenIdentity
      ? 'identity_hidden_useruid'
      : usernameIdentity
        ? 'identity_global_username'
        : null
  };
})()`;

export const PROJECT_PAGES_DOM_PROBE = String.raw`(() => {
  const canonicalId = (value) => {
    const normalized = String(value == null ? '' : value).trim();
    return /^[1-9]\d*$/.test(normalized) ? normalized : null;
  };
  const parsedUrl = (value, base) => {
    try { return new URL(value, base); } catch { return null; }
  };
  const currentUrl = new URL(location.href);
  const projectId = canonicalId(currentUrl.searchParams.get('projectid') || currentUrl.searchParams.get('projectId'));
  const authenticated = Array.from(document.querySelectorAll('a[href]')).some((anchor) => {
    const url = parsedUrl(anchor.getAttribute('href'), location.href);
    return url && url.origin === location.origin && url.pathname === '/login/exit/';
  });
  const failures = [];
  const pageIds = new Set();
  const pageCards = Array.from(document.querySelectorAll('.td-page[id^="page"]'));
  for (const card of pageCards) {
    const cardPageId = canonicalId(String(card.id || '').replace(/^page/, ''));
    const linkedPageIds = new Set(Array.from(card.querySelectorAll('a[href]'))
      .map((anchor) => {
        const url = parsedUrl(anchor.getAttribute('href'), location.href);
        if (!url || url.origin !== location.origin || url.pathname !== '/page/') return null;
        const explicitProjectId = canonicalId(url.searchParams.get('projectid') || url.searchParams.get('projectId'));
        if (explicitProjectId && explicitProjectId !== projectId) return 'OWNER_MISMATCH';
        return canonicalId(url.searchParams.get('pageid') || url.searchParams.get('pageId'));
      })
      .filter(Boolean));
    if (
      cardPageId === null ||
      linkedPageIds.has('OWNER_MISMATCH') ||
      linkedPageIds.size !== 1 ||
      !linkedPageIds.has(cardPageId)
    ) {
      failures.push({ code: 'PAGE_CARD_IDENTITY_AMBIGUOUS', projectId });
    } else {
      pageIds.add(cardPageId);
    }
  }

  const pageCountCandidates = new Set();
  const projectCountCandidates = new Set();
  for (const element of document.querySelectorAll('.td-plan__text')) {
    const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
    const usedIndex = Math.max(
      text.toLocaleLowerCase('ru').lastIndexOf('использовано'),
      text.toLocaleLowerCase('en').lastIndexOf('used')
    );
    if (usedIndex < 0) continue;
    const usedText = text.slice(usedIndex);
    const pageMatch = usedText.match(/страниц(?:ы|а)?\s*[—–\-:]\s*(\d+)/i) || usedText.match(/pages?\s*[—–\-:]\s*(\d+)/i);
    const projectMatch = usedText.match(/сайтов?\s*[—–\-:]\s*(\d+)/i) || usedText.match(/sites?\s*[—–\-:]\s*(\d+)/i);
    if (pageMatch && pageMatch[1] !== undefined) pageCountCandidates.add(Number(pageMatch[1]));
    if (projectMatch && projectMatch[1] !== undefined) projectCountCandidates.add(Number(projectMatch[1]));
  }
  const paginationDetected = Array.from(document.querySelectorAll('a[href]')).some((anchor) => {
    if ((anchor.getAttribute('rel') || '').split(/\s+/).includes('next')) return true;
    const url = parsedUrl(anchor.getAttribute('href'), location.href);
    if (!url || url.origin !== location.origin || url.pathname !== '/projects/' || url.searchParams.get('projectid') !== projectId) return false;
    return ['offset', 'p', 'page', 'pagenum', 'start'].some((key) => url.searchParams.has(key));
  });
  return {
    host: location.hostname,
    route: location.pathname,
    href: location.href,
    authenticated,
    uiReady: document.readyState === 'complete' && Boolean(document.querySelector('.td-plan__text, input[type="password"]') || /\/login|\/signin/i.test(location.pathname)),
    id: projectId,
    pageIds: Array.from(pageIds).sort((a, b) => a.length - b.length || a.localeCompare(b)),
    pageCardCount: pageCards.length,
    expectedPageCount: pageCountCandidates.size === 1 ? Array.from(pageCountCandidates)[0] : null,
    expectedProjectCount: projectCountCandidates.size === 1 ? Array.from(projectCountCandidates)[0] : null,
    paginationDetected,
    failures
  };
})()`;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export const TRUSTED_PROBE_HASHES = Object.freeze({
  projectsRoot: sha256(PROJECTS_ROOT_DOM_PROBE),
  identity: sha256(IDENTITY_DOM_PROBE),
  projectPages: sha256(PROJECT_PAGES_DOM_PROBE),
});
