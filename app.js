const STORAGE_KEYS = {
  supabaseUrl: "ghana_nfc_supabase_url",
  supabaseAnonKey: "ghana_nfc_supabase_anon_key",
  history: "ghana_nfc_scan_history",
};

const MAX_HISTORY_ITEMS = 25;

const state = {
  currentScan: null,
  scanAbortController: null,
  history: [],
};

const elements = {
  body: document.body,
  scanButton: document.getElementById("scanButton"),
  statusBadge: document.getElementById("statusBadge"),
  statusLabel: document.getElementById("statusLabel"),
  statusText: document.getElementById("statusText"),
  supportAlert: document.getElementById("supportAlert"),
  supportMessage: document.getElementById("supportMessage"),
  uidValue: document.getElementById("uidValue"),
  meterValue: document.getElementById("meterValue"),
  tokenValue: document.getElementById("tokenValue"),
  typeValue: document.getElementById("typeValue"),
  recordCount: document.getElementById("recordCount"),
  rawDataOutput: document.getElementById("rawDataOutput"),
  meterInput: document.getElementById("meterInput"),
  notesInput: document.getElementById("notesInput"),
  readyIndicator: document.getElementById("readyIndicator"),
  copyUidButton: document.getElementById("copyUidButton"),
  copyMeterButton: document.getElementById("copyMeterButton"),
  projectUrlInput: document.getElementById("projectUrlInput"),
  anonKeyInput: document.getElementById("anonKeyInput"),
  saveConfigButton: document.getElementById("saveConfigButton"),
  saveReadButton: document.getElementById("saveReadButton"),
  saveMessage: document.getElementById("saveMessage"),
  historyList: document.getElementById("historyList"),
  clearHistoryButton: document.getElementById("clearHistoryButton"),
};

document.addEventListener("DOMContentLoaded", initApp);

function initApp() {
  loadConfig();
  loadHistory();
  renderHistory();
  bindEvents();
  checkNfcSupport();
  renderCurrentScan();
}

function bindEvents() {
  elements.scanButton.addEventListener("click", startNfcScan);
  elements.copyUidButton.addEventListener("click", () => copyValue("UID", getCurrentUid()));
  elements.copyMeterButton.addEventListener("click", () => copyValue("Meter Number", elements.meterInput.value));
  elements.saveConfigButton.addEventListener("click", saveConfig);
  elements.saveReadButton.addEventListener("click", saveReadToSupabase);
  elements.clearHistoryButton.addEventListener("click", clearHistory);
  elements.meterInput.addEventListener("input", handleMeterEdit);
}

function checkNfcSupport() {
  const hasNfc = "NDEFReader" in window;
  const isSecure = window.isSecureContext;

  if (hasNfc && isSecure) {
    setStatus("idle", "Idle", "Ready. Tap Start NFC Scan and hold the card to the back of your phone.");
    return;
  }

  elements.supportAlert.classList.remove("hidden");

  if (!hasNfc && isLikelyIos()) {
    elements.supportMessage.textContent =
      "iPhone and iPad browsers do not currently expose Web NFC for this kind of browser scanning. Use Android Chrome.";
  } else if (!isSecure) {
    elements.supportMessage.textContent =
      "Web NFC requires a secure context. Use HTTPS or localhost on Android Chrome.";
  } else {
    elements.supportMessage.textContent =
      "This browser does not expose Web NFC. Android Chrome is the best supported option.";
  }

  elements.scanButton.disabled = true;
  setStatus("unsupported", "Unsupported", "Web NFC is unavailable in this browser or context.");
}

async function startNfcScan() {
  if (!("NDEFReader" in window)) {
    showMessage("error", "Web NFC is not supported in this browser.");
    setStatus("unsupported", "Unsupported", "Web NFC is unavailable in this browser.");
    return;
  }

  if (!window.isSecureContext) {
    showMessage("error", "Web NFC requires HTTPS or localhost.");
    setStatus("unsupported", "Unsupported", "Open this page from HTTPS or localhost to scan.");
    return;
  }

  try {
    elements.scanButton.disabled = true;
    elements.body.classList.add("is-scanning");
    setStatus("starting", "Starting", "Requesting NFC permission...");

    state.scanAbortController = new AbortController();
    const reader = new NDEFReader();

    reader.addEventListener("reading", handleNfcReading);
    reader.addEventListener("readingerror", () => {
      setStatus("error", "Read Error", "The card was detected but could not be read. Try holding it steady.");
      elements.scanButton.disabled = false;
      elements.body.classList.remove("is-scanning");
    });

    await reader.scan({ signal: state.scanAbortController.signal });
    setStatus("scanning", "Scanning", "NFC scan is active. Hold the card flat against the back of your phone.");
  } catch (error) {
    const message = formatNfcError(error);
    setStatus("error", "Error", message);
    showMessage("error", message);
    elements.scanButton.disabled = false;
    elements.body.classList.remove("is-scanning");
  }
}

async function handleNfcReading(event) {
  try {
    const rawData = await normalizeNdefEvent(event);
    const parsed = parseCardData(rawData);

    state.currentScan = {
      id: createId(),
      timestamp: new Date().toISOString(),
      card_uid: event.serialNumber || rawData.serialNumber || "Unavailable",
      card_type: parsed.cardType,
      meter_number: parsed.meterNumber || "",
      token: parsed.token || "",
      raw_data: rawData,
      notes: elements.notesInput.value.trim(),
    };

    elements.meterInput.value = state.currentScan.meter_number;
    renderCurrentScan();
    addHistoryItem(state.currentScan);

    setStatus("success", "Scanned", "Card data captured. Review the details before saving.");
  } catch (error) {
    setStatus("error", "Parse Error", error.message || "Card was read, but the payload could not be decoded.");
    showMessage("error", error.message || "Card was read, but the payload could not be decoded.");
  } finally {
    elements.scanButton.disabled = false;
    elements.body.classList.remove("is-scanning");

    if (state.scanAbortController) {
      state.scanAbortController.abort();
      state.scanAbortController = null;
    }
  }
}

async function normalizeNdefEvent(event) {
  const records = [];

  for (const record of event.message.records) {
    const bytes = getRecordBytes(record.data);
    const decoded = await decodeRecordPayload(record, bytes);

    records.push({
      recordType: record.recordType,
      mediaType: record.mediaType || "",
      id: record.id || "",
      encoding: record.encoding || "",
      lang: record.lang || "",
      data: decoded,
      byteLength: bytes.byteLength,
      hex: bytesToHex(bytes),
    });
  }

  return {
    serialNumber: event.serialNumber || "",
    recordCount: records.length,
    records,
    scannedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
  };
}

async function decodeRecordPayload(record, bytes) {
  if (!record.data || bytes.byteLength === 0) {
    return "";
  }

  try {
    if (record.recordType === "text") {
      return new TextDecoder(record.encoding || "utf-8").decode(bytes).replace(/\u0000/g, "").trim();
    }

    if (record.recordType === "url" || record.mediaType?.startsWith("text/")) {
      return new TextDecoder(record.encoding || "utf-8").decode(bytes);
    }

    if (record.mediaType?.includes("json")) {
      const text = new TextDecoder("utf-8").decode(bytes);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }

    return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\u0000/g, "").trim();
  } catch {
    return bytesToHex(bytes);
  }
}

function parseCardData(rawData) {
  const searchText = buildSearchText(rawData);
  const compactSearchText = searchText.replace(/\s+/g, " ");

  /*
    ECG parsing is intentionally best-effort. Browser Web NFC exposes NDEF
    records and sometimes a serial number; it cannot bypass protected card
    sectors or read APDU-only smartcard data. These patterns look for common
    operator labels and long numeric values that may appear in readable NDEF
    payloads, receipts, tags, or utility card metadata.
  */
  const meterNumber =
    findFirstMatch(compactSearchText, [
      /\b(?:meter|meterno|meter\s*no|meter\s*number|meter\s*id|mtr)\D{0,12}(\d{6,16})\b/i,
      /\b(?:account|acct|account\s*number|customer\s*number)\D{0,12}(\d{6,16})\b/i,
      /\becg\D{0,18}(\d{6,16})\b/i,
    ]) || "";

  const token =
    findFirstMatch(compactSearchText, [
      /\b(?:token|credit|topup|top-up|prepaid)\D{0,16}(\d(?:[\s-]?\d){15,24})\b/i,
      /\b(\d{20})\b/,
      /\b(\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4})\b/,
    ]) || "";

  const hasEcgSignal =
    /\b(ecg|electricity\s+company\s+of\s+ghana|prepaid|meter|meterno|top[-\s]?up|token)\b/i.test(searchText) ||
    Boolean(meterNumber || token);

  const hasGhanaCardSignal =
    /\b(ghana\s*card|national\s+identification\s+authority|nia|ecowas|personal\s*id)\b/i.test(searchText) ||
    /\bGHA[-\s]?\d{8,12}[-\s]?\d\b/i.test(searchText);

  let cardType = "Other";
  if (hasEcgSignal) {
    cardType = "ECG Prepaid";
  } else if (hasGhanaCardSignal) {
    cardType = "Ghana Card";
  }

  return {
    cardType,
    meterNumber: normalizeNumber(meterNumber),
    token: normalizeToken(token),
  };
}

function buildSearchText(rawData) {
  const values = [];

  values.push(rawData.serialNumber || "");
  for (const record of rawData.records || []) {
    values.push(record.recordType, record.mediaType, record.id, record.lang);

    if (typeof record.data === "string") {
      values.push(record.data);
    } else if (record.data) {
      values.push(JSON.stringify(record.data));
    }

    values.push(record.hex || "");
  }

  return values.filter(Boolean).join(" ");
}

function findFirstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "";
}

function normalizeNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeToken(value) {
  return String(value || "").replace(/\D/g, "");
}

function renderCurrentScan() {
  const scan = state.currentScan;
  const meterNumber = elements.meterInput.value.trim() || scan?.meter_number || "";
  const hasScan = Boolean(scan);

  elements.uidValue.textContent = scan?.card_uid || "No card scanned";
  elements.meterValue.textContent = meterNumber || "Not detected";
  elements.tokenValue.textContent = scan?.token || "Not found";
  elements.typeValue.textContent = scan?.card_type || "Other";
  elements.recordCount.textContent = `${scan?.raw_data?.recordCount || 0} records`;
  elements.rawDataOutput.textContent = scan ? JSON.stringify(scan.raw_data, null, 2) : "No NFC data yet.";

  elements.readyIndicator.textContent = meterNumber ? "Top-up Ready" : "Not Ready";
  elements.readyIndicator.className = meterNumber ? "ready-indicator ready-indicator-ready" : "ready-indicator";

  elements.copyUidButton.disabled = !hasScan || !scan.card_uid || scan.card_uid === "Unavailable";
  elements.copyMeterButton.disabled = !meterNumber;
  elements.saveReadButton.disabled = !hasScan;
}

function handleMeterEdit() {
  const meterNumber = elements.meterInput.value.trim();
  if (state.currentScan) {
    state.currentScan.meter_number = meterNumber;
  }
  renderCurrentScan();
}

function addHistoryItem(scan) {
  const snapshot = {
    ...scan,
    notes: elements.notesInput.value.trim(),
    meter_number: elements.meterInput.value.trim() || scan.meter_number || "",
  };

  state.history = [
    snapshot,
    ...state.history.filter((item) => item.card_uid !== snapshot.card_uid || item.timestamp !== snapshot.timestamp),
  ].slice(0, MAX_HISTORY_ITEMS);
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(state.history));
  renderHistory();
}

function loadHistory() {
  try {
    state.history = JSON.parse(localStorage.getItem(STORAGE_KEYS.history) || "[]");
  } catch {
    state.history = [];
  }
}

function renderHistory() {
  elements.clearHistoryButton.disabled = state.history.length === 0;

  if (state.history.length === 0) {
    elements.historyList.innerHTML = '<p class="empty-history">No scans saved locally yet.</p>';
    return;
  }

  elements.historyList.innerHTML = state.history
    .map((item) => {
      const date = formatDateTime(item.timestamp);
      const uid = escapeHtml(item.card_uid || "Unavailable");
      const type = escapeHtml(item.card_type || "Other");
      const meter = escapeHtml(item.meter_number || "No meter");
      const token = escapeHtml(item.token ? `Token ${item.token}` : "No token");
      const notes = item.notes ? `<p class="history-notes">${escapeHtml(item.notes)}</p>` : "";

      return `
        <article class="history-card">
          <div class="history-card-header">
            <div class="history-primary">
              <p class="history-uid">${uid}</p>
              <p class="history-date">${date}</p>
            </div>
            <span class="history-type">${type}</span>
          </div>
          <div class="history-meta-grid">
            <span>${meter}</span>
            <span>${token}</span>
          </div>
          ${notes}
        </article>
      `;
    })
    .join("");
}

function clearHistory() {
  if (!window.confirm("Clear all local scan history?")) {
    return;
  }

  state.history = [];
  localStorage.removeItem(STORAGE_KEYS.history);
  renderHistory();
  showMessage("success", "Local scan history cleared.");
}

function loadConfig() {
  elements.projectUrlInput.value = localStorage.getItem(STORAGE_KEYS.supabaseUrl) || "";
  elements.anonKeyInput.value = localStorage.getItem(STORAGE_KEYS.supabaseAnonKey) || "";
}

function saveConfig() {
  const projectUrl = cleanProjectUrl(elements.projectUrlInput.value);
  const anonKey = elements.anonKeyInput.value.trim();

  if (!projectUrl || !anonKey) {
    showMessage("error", "Enter both Supabase Project URL and Anon Key.");
    return;
  }

  localStorage.setItem(STORAGE_KEYS.supabaseUrl, projectUrl);
  localStorage.setItem(STORAGE_KEYS.supabaseAnonKey, anonKey);
  elements.projectUrlInput.value = projectUrl;
  showMessage("success", "Supabase configuration saved on this device.");
}

async function saveReadToSupabase() {
  if (!state.currentScan) {
    showMessage("error", "Scan a card before saving.");
    return;
  }

  const projectUrl = cleanProjectUrl(elements.projectUrlInput.value || localStorage.getItem(STORAGE_KEYS.supabaseUrl));
  const anonKey = elements.anonKeyInput.value.trim() || localStorage.getItem(STORAGE_KEYS.supabaseAnonKey);

  if (!projectUrl || !anonKey) {
    showMessage("error", "Enter and save your Supabase URL and Anon Key first.");
    return;
  }

  localStorage.setItem(STORAGE_KEYS.supabaseUrl, projectUrl);
  localStorage.setItem(STORAGE_KEYS.supabaseAnonKey, anonKey);

  const payload = {
    card_uid: state.currentScan.card_uid || "",
    card_type: state.currentScan.card_type || "Other",
    meter_number: elements.meterInput.value.trim() || state.currentScan.meter_number || "",
    token: state.currentScan.token || "",
    raw_data: state.currentScan.raw_data || {},
    notes: elements.notesInput.value.trim(),
  };

  elements.saveReadButton.disabled = true;
  elements.saveReadButton.textContent = "Saving...";
  showMessage("loading", "Saving NFC read to Supabase...");

  try {
    const response = await fetch(`${projectUrl}/rest/v1/nfc_reads`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const details = await readResponseDetails(response);
      throw new Error(`Supabase save failed (${response.status}): ${details}`);
    }

    const savedRows = await response.json();
    state.currentScan = {
      ...state.currentScan,
      ...payload,
      supabase_response: savedRows,
    };
    addHistoryItem(state.currentScan);
    showMessage("success", "NFC read saved to Supabase.");
  } catch (error) {
    showMessage("error", error.message || "Could not save NFC read to Supabase.");
  } finally {
    elements.saveReadButton.textContent = "Save Read";
    renderCurrentScan();
  }
}

async function readResponseDetails(response) {
  try {
    const json = await response.json();
    return json.message || json.details || JSON.stringify(json);
  } catch {
    return response.statusText || "Unknown error";
  }
}

function cleanProjectUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

async function copyValue(label, value) {
  const text = String(value || "").trim();
  if (!text) {
    showMessage("error", `${label} is empty.`);
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    showMessage("success", `${label} copied.`);
  } catch {
    showMessage("error", `Could not copy ${label}. Select and copy it manually.`);
  }
}

function getCurrentUid() {
  return state.currentScan?.card_uid || "";
}

function setStatus(kind, label, detail) {
  elements.statusBadge.className = `status-badge status-${kind}`;
  elements.statusLabel.textContent = label;
  elements.statusText.textContent = detail;
}

function showMessage(kind, message) {
  const allowedKinds = new Set(["success", "error", "loading"]);
  const messageKind = allowedKinds.has(kind) ? kind : "loading";

  elements.saveMessage.className = `save-message save-message-${messageKind}`;
  elements.saveMessage.textContent = message;
  elements.saveMessage.classList.remove("hidden");
}

function formatNfcError(error) {
  if (error?.name === "NotAllowedError") {
    return "NFC permission was denied. Allow NFC access and try again.";
  }
  if (error?.name === "NotSupportedError") {
    return "This device or browser does not support Web NFC scanning.";
  }
  if (error?.name === "NotReadableError") {
    return "NFC is unavailable or disabled. Turn on NFC and try again.";
  }
  if (error?.name === "AbortError") {
    return "NFC scan was stopped.";
  }
  return error?.message || "Could not start NFC scan.";
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function createId() {
  return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getRecordBytes(data) {
  if (!data) {
    return new Uint8Array();
  }

  if (data instanceof DataView) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  return new Uint8Array();
}

function formatDateTime(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value || "";
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isLikelyIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
