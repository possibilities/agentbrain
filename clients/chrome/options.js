import { healthEndpoint, originPatternFor } from "./shared.js";

const serverInput = document.getElementById("serverUrl");
const tokenInput = document.getElementById("token");
const statusEl = document.getElementById("status");

function show(message, ok) {
  statusEl.textContent = message;
  statusEl.className = ok ? "ok" : "err";
}

function normalizedServerUrl() {
  const raw = serverInput.value.trim().replace(/\/+$/, "");
  if (raw === "") throw new Error("Enter the Agentbrain server URL.");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The server URL must be http or https.");
  }
  return raw;
}

async function restore() {
  const stored = await chrome.storage.sync.get(["serverUrl", "token"]);
  serverInput.value = stored.serverUrl ?? "";
  tokenInput.value = stored.token ?? "";
}

document.getElementById("save").addEventListener("click", async () => {
  let serverUrl;
  try {
    serverUrl = normalizedServerUrl();
  } catch (error) {
    show(error.message, false);
    return;
  }
  const token = tokenInput.value.trim();
  if (token === "") {
    show("Enter the share token.", false);
    return;
  }

  // Host permission must be requested from a user gesture, which this click is.
  const granted = await chrome.permissions.request({
    origins: [originPatternFor(serverUrl)],
  });
  if (!granted) {
    show(
      "Permission was declined, so the extension cannot reach that server.",
      false,
    );
    return;
  }
  await chrome.storage.sync.set({ serverUrl, token });
  show("Saved. Try 'Test connection' to confirm the server answers.", true);
});

document.getElementById("test").addEventListener("click", async () => {
  let serverUrl;
  try {
    serverUrl = normalizedServerUrl();
  } catch (error) {
    show(error.message, false);
    return;
  }
  const token = tokenInput.value.trim();
  try {
    const response = await fetch(healthEndpoint(serverUrl), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 401) {
      show("Reached the server, but the token was rejected.", false);
      return;
    }
    if (!response.ok) {
      show(`Server answered HTTP ${response.status}.`, false);
      return;
    }
    show("Connected. Agentbrain is ready to receive shares.", true);
  } catch {
    show(
      "Could not reach the server. Check the tailnet and that 'agentbrain share serve' is running.",
      false,
    );
  }
});

void restore();
