import {
  applyLedgerStates,
  clearHistory,
  OUTCOME,
  pendingJobIds,
  readHistory,
  record,
} from "./history.js";
import {
  clearOutbox,
  enqueue,
  flushOutbox,
  OUTBOX_ALARM,
  outboxCount,
  scheduleFlush,
} from "./outbox.js";
import {
  fetchShareStates,
  hasHostPermission,
  isRetryable,
  loadConfig,
  postShare,
} from "./shared.js";

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

const FLASH_MS = 4000;

/**
 * While a flash is on screen the badge belongs to it, and its own timer
 * restores the standing state afterwards. Without this a background drain
 * lands between the flash and its timer and clears the outcome the user was
 * meant to read.
 */
let flashUntil = 0;

/** A pending outbox is standing state, so it owns the badge until it drains. */
async function refreshBadge() {
  if (Date.now() < flashUntil) return;
  const pending = await outboxCount();
  if (pending === 0) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#b45309" });
  await chrome.action.setBadgeText({ text: String(pending) });
}

/**
 * Badges the toolbar button briefly so the common case needs no notification
 * click-through, while still surfacing the detail for failures. The pending
 * count is restored afterwards rather than cleared.
 */
async function flashBadge(text, color) {
  flashUntil = Date.now() + FLASH_MS;
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => {
    flashUntil = 0;
    void refreshBadge();
  }, FLASH_MS);
}

function describe(payload) {
  return payload.url ?? payload.title ?? "the shared selection";
}

const DROP_TITLE = {
  expired: "Share abandoned",
  overflow: "Share discarded",
  rejected: "Share rejected",
};

const DROP_DETAIL = {
  expired: (entry) =>
    `Agentbrain never became reachable for ${describe(entry.payload)}.`,
  overflow: (entry) =>
    `The outbox is full, so ${describe(entry.payload)} was dropped as the oldest waiting share.`,
  rejected: (entry, result) =>
    `${describe(entry.payload)}: ${result?.message ?? "the ingress refused it."}`,
};

const DROP_OUTCOME = {
  expired: OUTCOME.ABANDONED,
  overflow: OUTCOME.DISCARDED,
  rejected: OUTCOME.REJECTED,
};

async function reportDropped(dropped) {
  for (const { entry, reason, result } of dropped) {
    notify(DROP_TITLE[reason], DROP_DETAIL[reason](entry, result));
    await record({
      id: entry.id,
      payload: entry.payload,
      outcome: DROP_OUTCOME[reason],
      message: result?.message ?? DROP_DETAIL[reason](entry, result),
    });
  }
}

/** The history's word for what the ingress answered. */
function outcomeFor(status) {
  if (status === "duplicate") return OUTCOME.DUPLICATE;
  if (status === "already_indexed") return OUTCOME.INDEXED;
  return OUTCOME.SENT;
}

/**
 * Delivers what the outbox holds. Serialized within this worker instance: two
 * concurrent rounds would attempt the same entries, and while the ingress
 * deduplicates that, the second round's commit could resurrect an entry the
 * first had just delivered.
 */
let flushing = null;

async function drainOutbox({ force = false } = {}) {
  const config = await loadConfig();
  // Unconfigured is not undeliverable. Entries wait for a server to be named
  // and for the permission that lets a background fetch reach it.
  if (config === null || !(await hasHostPermission(config.serverUrl))) {
    return { pending: await outboxCount(), unconfigured: true };
  }

  const run = async () => {
    const summary = await flushOutbox((payload) => postShare(config, payload), {
      force,
    });
    for (const { entry, result } of summary.settled) {
      await record({
        id: entry.id,
        payload: entry.payload,
        outcome: outcomeFor(result.data?.status),
        job: result.data?.job_id ?? null,
      });
    }
    await reportDropped(summary.dropped);
    await scheduleFlush();
    await refreshBadge();
    return summary;
  };

  flushing = flushing ? flushing.then(run, run) : run();
  return flushing;
}

/**
 * Holds a share the ingress has not accepted and tells the user it is kept, not
 * saved: nothing is durable in Agentbrain until Admission answers.
 */
async function hold(payload, reason) {
  const { entry, dropped, pending } = await enqueue(payload);
  await record({
    id: entry.id,
    payload,
    outcome: OUTCOME.HELD,
    message: reason,
  });
  await reportDropped(dropped.map((entry) => ({ entry, reason: "overflow" })));
  await scheduleFlush();
  await refreshBadge();
  notify(
    "Held for later",
    `${reason} It will be sent when Agentbrain answers (${pending} waiting).`,
  );
}

async function report(result, payload) {
  if (result.ok) {
    await record({
      payload,
      outcome: outcomeFor(result.data.status),
      job: result.data.job_id ?? null,
    });
    const queued = result.data.status === "queued";
    await flashBadge(queued ? "OK" : "DUP", queued ? "#1b7f4b" : "#6b6b6b");
    if (!queued) {
      notify(
        "Already saved",
        `Agentbrain already has this as job ${result.data.job_id}.`,
      );
    }
    // The server just answered, so anything held from an earlier outage can go.
    // Only when something is actually held: the common share holds nothing, and
    // a drain that has no work still costs a read and a badge write.
    if ((await outboxCount()) > 0) void drainOutbox({ force: true });
    return;
  }
  if (isRetryable(result)) {
    await hold(payload, result.message);
    return;
  }
  await flashBadge("ERR", "#a32020");
  await record({
    payload,
    outcome: OUTCOME.REJECTED,
    message: result.message,
  });
  notify(
    "Agentbrain share failed",
    result.recovery ? `${result.message} ${result.recovery}` : result.message,
  );
}

async function send(payload) {
  const config = await loadConfig();
  // An unconfigured or ungranted extension cannot send, but the share is still
  // worth keeping: configuring one drains what was held meanwhile.
  if (config === null) {
    await hold(payload, "Agentbrain has no server URL or token yet.");
    await chrome.runtime.openOptionsPage();
    return;
  }
  if (!(await hasHostPermission(config.serverUrl))) {
    await hold(
      payload,
      "The extension has no permission to reach that server.",
    );
    await chrome.runtime.openOptionsPage();
    return;
  }
  await report(await postShare(config, payload), payload);
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
  void drainOutbox();
});

// A browser restart is the likeliest moment for a machine that was asleep to
// find the ingress up again, and the alarm may not survive it.
chrome.runtime.onStartup.addListener(() => {
  void drainOutbox();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === OUTBOX_ALARM) void drainOutbox();
});

// The toolbar button opens the popover (manifest `action.default_popup`), so
// there is no onClicked here. Sharing the current page stays one keystroke
// away on the command, and one click away inside the popover.
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

/**
 * Refreshes what the ingress says became of the jobs still in flight, and
 * returns the history either way. The popover calls this on a short cadence
 * while it is open; nothing here is scheduled in the background, because a
 * status nobody is looking at is not worth a request.
 */
async function refreshHistory() {
  const entries = await readHistory();
  const ids = pendingJobIds(entries);
  const config = await loadConfig();
  if (config === null || ids.length === 0) return { entries, reachable: null };
  if (!(await hasHostPermission(config.serverUrl))) {
    return { entries, reachable: null };
  }
  const { ok, states } = await fetchShareStates(config, ids);
  if (!ok) return { entries, reachable: false };
  return { entries: await applyLedgerStates(states), reachable: true };
}

/** The Options page and the popover drive the client through these messages. */
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "outbox-status") {
    void outboxCount().then((pending) => respond({ pending }));
    return true;
  }
  if (message?.type === "outbox-flush") {
    void drainOutbox({ force: true }).then((summary) => respond(summary));
    return true;
  }
  if (message?.type === "history-refresh") {
    void refreshHistory().then(async (result) =>
      respond({ ...result, pending: await outboxCount() }),
    );
    return true;
  }
  if (message?.type === "history-clear") {
    void clearHistory().then((discarded) => respond({ discarded }));
    return true;
  }
  if (message?.type === "share-current-page") {
    void shareCurrentPage().then(() => respond({ done: true }));
    return true;
  }
  if (message?.type === "outbox-clear") {
    void clearOutbox().then(async (discarded) => {
      await scheduleFlush();
      await refreshBadge();
      respond({ discarded });
    });
    return true;
  }
  return false;
});

void refreshBadge();
