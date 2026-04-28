const STORAGE_KEYS = {
  openaiApiKey: "openaiApiKey",
  openaiModel: "openaiModel"
};

function $(id) {
  return document.getElementById(id);
}

function showStatus(text, kind) {
  const el = $("status");
  el.style.display = "block";
  el.textContent = text;
  el.className = `notice ${kind || ""}`.trim();
}

async function load() {
  const data = await chrome.storage.sync.get([STORAGE_KEYS.openaiApiKey, STORAGE_KEYS.openaiModel]);
  $("openaiKey").value = data[STORAGE_KEYS.openaiApiKey] || "";
  $("openaiModel").value = data[STORAGE_KEYS.openaiModel] || "";
}

async function save() {
  const key = String($("openaiKey").value || "").trim();
  const model = String($("openaiModel").value || "").trim();
  await chrome.storage.sync.set({
    [STORAGE_KEYS.openaiApiKey]: key,
    [STORAGE_KEYS.openaiModel]: model
  });
  showStatus("Saved.", "ok");
}

async function clearKey() {
  $("openaiKey").value = "";
  await chrome.storage.sync.set({ [STORAGE_KEYS.openaiApiKey]: "" });
  showStatus("Key cleared.", "ok");
}

document.addEventListener("DOMContentLoaded", () => {
  load().catch((e) => showStatus(`Failed to load settings: ${String(e)}`, "err"));
  $("saveBtn").addEventListener("click", () => {
    save().catch((e) => showStatus(`Failed to save: ${String(e)}`, "err"));
  });
  $("clearBtn").addEventListener("click", () => {
    clearKey().catch((e) => showStatus(`Failed to clear: ${String(e)}`, "err"));
  });
});

