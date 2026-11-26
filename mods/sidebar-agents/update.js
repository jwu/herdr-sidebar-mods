// Keep this file identical in both mod folders so each can be installed on its own.
//
// Tells the person when a newer release is out. At most once a day, one GET to
// GitHub's public releases API: no token, nothing about the person. Either
// panel asks; the answer lives in shared state, so the other panel, a restart
// and the settings dialog all reuse it. Nothing is downloaded or changed: the
// settings dialog links the release and offers a line for the person's agent.
import { notify, setShared, shared } from "herdr";

// The installed release. The release workflow refuses a tag that differs.
export const VERSION = "0.12.1";
export const REPO = "jwu/herdr-sidebar-mods";
export const RELEASES = `https://github.com/${REPO}/releases`;
export const AGENT_PROMPT = `Update the Herdr Ultimate Sidebar mods (sidebar-spaces, sidebar-agents, and pane-header if installed) in ~/.config/herdr-app/mods from github.com/${REPO} to its latest release.`;

export const CHECK_UPDATES = "sidebar.updates.check"; // false: only Check now asks GitHub
export const UPDATE_STATE = "sidebar.updates"; // { latest, url, checkedAt, toasted, seen, error }
const DAY = 24 * 3600 * 1000;
const RETRY = 3600 * 1000;
const RELEASE = /^v?\d+\.\d+\.\d+$/; // pre-releases are never offered

// "0.10.0" > "0.9.3"; a leading "v" is ignored.
export function newer(a, b) {
  const p = v => String(v ?? "").replace(/^v/, "").split(".").map(x => parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

const state = () => {
  const s = shared(UPDATE_STATE);
  return s && typeof s === "object" ? s : {};
};
const save = patch => setShared(UPDATE_STATE, { ...state(), ...patch });

// { current, latest, url, available, unseen, checking, checkedAt }
export function updateState() {
  const s = state();
  const latest = RELEASE.test(String(s.latest ?? "")) ? String(s.latest).replace(/^v/, "") : null;
  const available = Boolean(latest) && newer(latest, VERSION);
  return {
    current: VERSION, latest, available,
    url: available ? (s.url || `${RELEASES}/tag/v${latest}`) : RELEASES,
    unseen: available && s.seen !== latest,
    checking: Boolean(s.checking) && Date.now() - s.checking < 60000,
    checkedAt: Number(s.checkedAt) || 0,
    error: typeof s.error === "string" ? s.error : null,
  };
}

// The settings dialog was opened: the gear's dot is for news not yet seen.
export function markUpdateSeen() {
  const u = updateState();
  if (u.unseen) save({ seen: u.latest });
}

// Asks GitHub once a day while daily checks are on, or now when `force` (Check
// now). Quiet on any failure (offline, rate limited): it tries again in an
// hour. One toast per new version.
export async function checkForUpdate({ force = false, fetchImpl = globalThis.fetch } = {}) {
  if ((!force && shared(CHECK_UPDATES) === false) || typeof fetchImpl !== "function") return updateState();
  const s = state();
  const now = Date.now();
  if (!force && now - (Number(s.checkedAt) || 0) < DAY) return updateState();
  // Saved before asking, so the other panel, opened at the same time, waits.
  save({ checkedAt: now, checking: now });
  let tag = null;
  let url = null;
  let error = null;
  try {
    // GitHub's API refuses a request without a User-Agent (403), and Herdr's
    // fetch sends none of its own.
    const r = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `herdr-ultimate-sidebar/${VERSION}` },
    });
    if (!r?.ok) error = `GitHub answered ${r?.status ?? "nothing"}`;
    else {
      const rel = await r.json();
      if (RELEASE.test(String(rel?.tag_name ?? ""))) {
        tag = String(rel.tag_name).replace(/^v/, "");
        if (typeof rel.html_url === "string" && rel.html_url.startsWith(`https://github.com/${REPO}/`)) url = rel.html_url;
      } else error = "no release found";
    }
  } catch (e) {
    error = String(e?.message ?? e) || "network error";
  }
  if (!tag) {
    save({ checkedAt: now - DAY + RETRY, checking: 0, error });
    return updateState();
  }
  const toast = newer(tag, VERSION) && state().toasted !== tag;
  save({ latest: tag, url, checking: 0, error: null, ...(toast ? { toasted: tag } : {}) });
  if (toast) {
    notify({
      title: `Ultimate Sidebar ${tag} is available`,
      body: `You have ${VERSION}. Open Sidebar settings to see the release or copy the update line for your agent.`,
      level: "info",
      timeout: 10000,
    });
  }
  return updateState();
}
