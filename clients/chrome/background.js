import { hasHostPermission, loadConfig, postShare } from "./shared.js";

const MENU_PAGE = "agentbrain-share-page";
const MENU_LINK = "agentbrain-share-link";
const MENU_SELECTION = "agentbrain-share-selection";

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon128.png",
    title,
    message,
  });
}

/**
 * Badges the toolbar button briefly so the common case needs no notification
 * click-through, while still surfacing the detail for failures.
 */
async function flashBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
}

async function report(result) {
  if (result.ok) {
    const queued = result.data.status === "queued";
    await flashBadge(queued ? "OK" : "DUP", queued ? "#1b7f4b" : "#6b6b6b");
    if (!queued) {
      notify(
        "Already saved",
        `Agentbrain already has this as job ${result.data.job_id}.`,
      );
    }
    return;
  }
  await flashBadge("ERR", "#a32020");
  notify(
    "Agentbrain share failed",
    result.recovery ? `${result.message} ${result.recovery}` : result.message,
  );
}

async function send(payload) {
  const config = await loadConfig();
  if (config === null) {
    notify(
      "Agentbrain is not configured",
      "Open the extension options and set the server URL and token.",
    );
    await chrome.runtime.openOptionsPage();
    return;
  }
  if (!(await hasHostPermission(config.serverUrl))) {
    notify(
      "Permission needed",
      "Open the extension options and grant access to the Agentbrain server.",
    );
    await chrome.runtime.openOptionsPage();
    return;
  }
  await report(await postShare(config, payload));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return tab ?? null;
}

/**
 * Shares whatever tab is in front. Chrome pages (chrome://, the Web Store)
 * cannot be ingested and are rejected here rather than queued as a job that
 * would fail later in the worker.
 */
async function shareCurrentPage() {
  const tab = await activeTab();
  if (!tab || !tab.url) {
    notify("Nothing to share", "No active tab URL was available.");
    return;
  }
  if (!/^https?:/i.test(tab.url)) {
    notify("Cannot share this page", "Only http(s) pages can be sent.");
    return;
  }
  await send({ url: tab.url, ...(tab.title ? { title: tab.title } : {}) });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: "Send this page to Agentbrain",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: "Send this link to Agentbrain",
      contexts: ["link"],
    });
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: "Send selection to Agentbrain",
      contexts: ["selection"],
    });
  });
});

chrome.action.onClicked.addListener(() => {
  void shareCurrentPage();
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "share-current-page") void shareCurrentPage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_LINK && info.linkUrl) {
    void send({ url: info.linkUrl });
    return;
  }
  if (info.menuItemId === MENU_SELECTION && info.selectionText) {
    // Selections go over as text. The server extracts a URL when the selection
    // contains one, and otherwise keeps it as a text note.
    void send({
      text: info.selectionText,
      ...(tab?.title ? { title: tab.title } : {}),
    });
    return;
  }
  if (info.menuItemId === MENU_PAGE) void shareCurrentPage();
});
