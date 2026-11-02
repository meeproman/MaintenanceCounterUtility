/**
 * Pure Frontend Controller for Waste Ink Maintenance Counter Utility (macOS WebUSB).
 * EUPL-1.2 licensed. No telemetry; all backups and logs remain on the user's device.
 */
import { WebPrinterSession } from "./epson_d4.js";

const TERMS_VERSION = 2;
const LOW_COUNTER_PCT = 50.0;

const USAGE_RENAME = {
  "Total print page counter": "Total printed pages (จำนวนหน้าที่พิมพ์ทั้งหมด)",
  "Total scan counter": "Total scans (จำนวนการสแกนทั้งหมด)",
  "Total print pass counter": "Print-head passes (จำนวนรอบหัวพิมพ์)",
  "Manual cleaning counter": "Manual cleanings (ล้างหัวพิมพ์แบบสั่งเอง)",
  "Timer cleaning counter": "Timer cleanings (ล้างหัวพิมพ์ตามเวลา)",
  "Power cleaning counter": "Power cleanings (ล้างหัวพิมพ์ขั้นสูง)",
};

let lastState = null;

function logEvent(event, fields = {}) {
  const now = new Date();
  const ts = now.toISOString().replace("T", " ").slice(0, 19);
  const parts = [ts, `event=${event}`];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`${k}=${v}`);
  }
  const line = parts.join(" | ");
  try {
    const logs = JSON.parse(localStorage.getItem("ewr_oplogs") || "[]");
    logs.unshift(line);
    if (logs.length > 200) logs.length = 200;
    localStorage.setItem("ewr_oplogs", JSON.stringify(logs));
  } catch (_) {}
  renderLogs();
  return line;
}

function renderLogs() {
  const el = document.getElementById("logOutput");
  if (!el) return;
  try {
    const logs = JSON.parse(localStorage.getItem("ewr_oplogs") || "[]");
    el.textContent = logs.length ? logs.join("\n") : "ยังไม่มีประวัติการทำงานในเบราว์เซอร์นี้";
  } catch (_) {
    el.textContent = "";
  }
}

function downloadJsonFile(filename, dataObj) {
  const blob = new Blob([JSON.stringify(dataObj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function saveBackupToLocal(filename, payload) {
  try {
    const list = JSON.parse(localStorage.getItem("ewr_backups") || "[]");
    list.unshift({ filename, payload });
    if (list.length > 20) list.length = 20;
    localStorage.setItem("ewr_backups", JSON.stringify(list));
  } catch (_) {}
  downloadJsonFile(filename, payload);
}

function setBusy(busy, message = "") {
  const btns = document.querySelectorAll("button.action-btn");
  btns.forEach((b) => (b.disabled = busy));
  const spinner = document.getElementById("busyStatus");
  if (spinner) {
    spinner.textContent = busy ? message || "กำลังสื่อสารกับเครื่องพิมพ์ผ่าน WebUSB..." : "";
    spinner.style.display = busy ? "block" : "none";
  }
}

function getManualModel() {
  const sel = document.getElementById("modelSelect");
  return sel ? sel.value : "";
}

function renderState(st) {
  lastState = st;
  const modelEl = document.getElementById("modelTitle");
  const badgeEl = document.getElementById("modelBadge");
  const statusEl = document.getElementById("printerStatus");

  modelEl.textContent = `${st.model} (โปรไฟล์ ${st.key}) — ${st.transport}`;
  if (st.experimental) {
    badgeEl.textContent = "⚠ EXPERIMENTAL model (ข้อมูลจากคอมมูนิตี้ โปรดใช้ด้วยความระมัดระวัง)";
    badgeEl.className = "badge warn";
  } else {
    badgeEl.textContent = "✔ Verified model (ผ่านการทดสอบบนฮาร์ดแวร์จริง)";
    badgeEl.className = "badge ok";
  }

  if (st.status.includes("IDLE") && st.status.includes("NONE")) {
    statusEl.textContent = "สถานะเครื่อง: ปกติ (IDLE)";
    statusEl.className = "status-line normal";
  } else {
    statusEl.textContent = `สถานะเครื่อง: ${st.status}`;
    statusEl.className = "status-line alert";
  }

  for (let i = 0; i < 3; i++) {
    const rowEl = document.getElementById(`wasteRow${i}`);
    const nameEl = document.getElementById(`wasteName${i}`);
    const barEl = document.getElementById(`wasteBar${i}`);
    const valEl = document.getElementById(`wasteVal${i}`);

    if (i < st.waste.length) {
      const w = st.waste[i];
      rowEl.style.opacity = "1";
      nameEl.textContent = w.name;
      const clamped = Math.min(100, Math.max(0, w.pct));
      barEl.style.width = `${clamped.toFixed(1)}%`;
      barEl.className =
        w.pct >= 90 ? "bar-fill danger" : w.pct >= 50 ? "bar-fill warn" : "bar-fill ok";
      valEl.textContent = `${w.raw} / ${w.max} (${w.pct.toFixed(1)}%)`;
    } else {
      rowEl.style.opacity = "0.45";
      nameEl.textContent = `Counter ${i + 1} (ไม่มีในรุ่นนี้)`;
      barEl.style.width = "0%";
      barEl.className = "bar-fill ok";
      valEl.textContent = "--";
    }
  }

  const usageBody = document.getElementById("usageBody");
  usageBody.innerHTML = "";
  if (st.usage && st.usage.length > 0) {
    for (const u of st.usage) {
      const tr = document.createElement("tr");
      const tdName = document.createElement("td");
      tdName.textContent = USAGE_RENAME[u.name] || u.name;
      const tdVal = document.createElement("td");
      tdVal.className = "num";
      tdVal.textContent = u.value === null ? "n/a" : u.value.toLocaleString();
      tr.appendChild(tdName);
      tr.appendChild(tdVal);
      usageBody.appendChild(tr);
    }
  } else {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="2" class="muted">ไม่มีข้อมูลสถิติการใช้งานสำหรับรุ่นนี้</td>`;
    usageBody.appendChild(tr);
  }
}

async function handleConnectAndRead(forceChooser = false) {
  setBusy(true, "กำลังเชื่อมต่อและอ่านค่า EEPROM ผ่าน WebUSB...");
  try {
    const st = await WebPrinterSession.withSession(
      { forceChooser, manualModel: getManualModel() },
      async (session) => {
        return await session.readState();
      }
    );
    renderState(st);
    logEvent("read_state", {
      model: st.model,
      profile: st.key,
      counters: st.waste.map((w) => `${w.name}:${w.raw}/${w.max}`).join(";"),
    });
  } catch (err) {
    if (err && err.name === "NotFoundError") {
      // User cancelled the WebUSB chooser popup
      return;
    }
    alert(`เกิดข้อผิดพลาด:\n${err.message || err}`);
    const statusEl = document.getElementById("printerStatus");
    statusEl.textContent = `ข้อผิดพลาด: ${err.message || err}`;
    statusEl.className = "status-line alert";
  } finally {
    setBusy(false);
  }
}

async function handleManualBackup() {
  setBusy(true, "กำลังอ่านค่า EEPROM เพื่อสร้างไฟล์ Backup...");
  try {
    const bk = await WebPrinterSession.withSession(
      { forceChooser: false, manualModel: getManualModel() },
      async (session) => {
        return await session.createBackupPayload("manual");
      }
    );
    saveBackupToLocal(bk.filename, bk.payload);
    logEvent("manual_backup", { model: bk.payload.model, file: bk.filename });
    alert(`บันทึกไฟล์ Backup เรียบร้อยแล้ว:\n${bk.filename}`);
  } catch (err) {
    if (err && err.name === "NotFoundError") return;
    alert(`ไม่สามารถสร้างไฟล์ Backup ได้:\n${err.message || err}`);
  } finally {
    setBusy(false);
  }
}

function showResetConsentModal() {
  return new Promise((resolve) => {
    const modal = document.getElementById("resetModal");
    const chk = document.getElementById("ackPhysicalChk");
    const btnContinue = document.getElementById("resetContinueBtn");
    const btnCancel = document.getElementById("resetCancelBtn");

    chk.checked = false;
    btnContinue.disabled = true;
    modal.classList.add("open");

    const onCheck = () => {
      btnContinue.disabled = !chk.checked;
    };

    const cleanup = () => {
      chk.removeEventListener("change", onCheck);
      btnContinue.onclick = null;
      btnCancel.onclick = null;
      modal.classList.remove("open");
    };

    chk.addEventListener("change", onCheck);
    btnCancel.onclick = () => {
      cleanup();
      resolve(false);
    };
    btnContinue.onclick = () => {
      if (!chk.checked) return;
      const secondOk = window.confirm(
        "ยืนยันครั้งที่ 2:\n" +
          "ฉันเข้าใจว่าการดำเนินการนี้เป็นการแก้ไขค่าตัวนับในหน่วยความจำเครื่องพิมพ์ และฉันขอรับผิดชอบทั้งหมดในการตรวจสอบว่าได้ทำความสะอาด/เปลี่ยนแผ่นซับหมึกจริงเรียบร้อยแล้ว\n\n" +
          "ต้องการดำเนินการรีเซ็ตตัวนับตอนนี้หรือไม่?"
      );
      cleanup();
      resolve(secondOk);
    };
  });
}

async function handleResetFlow() {
  setBusy(true, "กำลังตรวจสอบสถานะตัวนับปัจจุบัน...");
  let st = null;
  try {
    st = await WebPrinterSession.withSession(
      { forceChooser: false, manualModel: getManualModel() },
      async (session) => await session.readState()
    );
    renderState(st);
  } catch (err) {
    setBusy(false);
    if (err && err.name === "NotFoundError") return;
    alert(`ไม่สามารถอ่านค่าจากเครื่องพิมพ์ได้:\n${err.message || err}`);
    return;
  }
  setBusy(false);

  const maxPct = Math.max(0, ...st.waste.map((w) => w.pct));
  if (maxPct < LOW_COUNTER_PCT) {
    const okLow = window.confirm(
      `ตัวนับแผ่นซับหมึกปัจจุบันยังอยู่ในระดับต่ำ (${maxPct.toFixed(1)}%)\n` +
        "โดยปกติไม่จำเป็นต้องรีเซ็ตหากยังไม่ได้ทำความสะอาดหรือเปลี่ยนแผ่นซับหมึก\n\n" +
        "ต้องการดำเนินการต่อหรือไม่?"
    );
    if (!okLow) return;
  }

  if (st.experimental) {
    const okExp = window.confirm(
      `รุ่น ${st.model} (โปรไฟล์ ${st.key}) อยู่ในหมวด EXPERIMENTAL\n` +
        "ต้องการดำเนินการต่อด้วยความระมัดระวังหรือไม่?"
    );
    if (!okExp) return;
  }

  const consented = await showResetConsentModal();
  if (!consented) {
    logEvent("reset_cancelled", { model: st.model });
    return;
  }

  setBusy(true, "กำลังสำรองข้อมูล EEPROM อัตโนมัติและรีเซ็ตตัวนับ...");
  try {
    const result = await WebPrinterSession.withSession(
      { forceChooser: false, manualModel: getManualModel() },
      async (session) => {
        const before = await session.readWaste();
        logEvent("reset_attempt", {
          model: session.model,
          ack_physical: true,
          ack_responsibility: true,
          before: before.map((w) => `${w.name}:${w.raw}/${w.max}`).join(";"),
        });

        let backupFile = null;
        try {
          const bk = await session.createBackupPayload("pre-reset");
          saveBackupToLocal(bk.filename, bk.payload);
          backupFile = bk.filename;
          logEvent("backup_ok", { model: session.model, file: backupFile });
        } catch (bkErr) {
          logEvent("backup_failed", { model: session.model, error: bkErr.message });
          const override = window.confirm(
            `การสำรองข้อมูล EEPROM ก่อนรีเซ็ตล้มเหลว (${bkErr.message})\n\n` +
              "คุณต้องการบังคับรีเซ็ตต่อโดยไม่มีไฟล์สำรองข้อมูลหรือไม่? (ไม่แนะนำ)"
          );
          if (!override) {
            throw new Error("ยกเลิกการรีเซ็ตเนื่องจากไม่สามารถสร้างไฟล์ Backup ได้");
          }
        }

        await session.resetCounters();
        const afterState = await session.readState();
        logEvent("reset_success", {
          model: session.model,
          backup: backupFile || "overridden",
          after: afterState.waste.map((w) => `${w.name}:${w.raw}/${w.max}`).join(";"),
        });
        return { backupFile, afterState };
      }
    );

    renderState(result.afterState);
    alert(
      "รีเซ็ตตัวนับซับหมึกเรียบร้อยแล้ว!\n\n" +
        `ไฟล์ Backup: ${result.backupFile || "(ไม่มี)"}\n\n` +
        "สำคัญมาก: กรุณากดปุ่มปิดเครื่องพิมพ์ (Power Off) รอประมาณ 5 วินาที แล้วเปิดเครื่องใหม่อีกครั้งเพื่อให้เครื่องพิมพ์บันทึกค่าใหม่"
    );
  } catch (err) {
    logEvent("reset_failed", { error: err.message || String(err) });
    alert(`การรีเซ็ตล้มเหลว:\n${err.message || err}`);
  } finally {
    setBusy(false);
  }
}

async function handleRestoreFile(file) {
  if (!file) return;
  let data = null;
  try {
    const text = await file.text();
    data = JSON.parse(text);
    if (!data || typeof data.eeprom !== "object") {
      throw new Error("โครงสร้างไฟล์ JSON ไม่ถูกต้อง (ไม่พบข้อมูล eeprom)");
    }
  } catch (err) {
    alert(`ไม่สามารถอ่านไฟล์ Backup ได้:\n${err.message || err}`);
    return;
  }

  const count = Object.keys(data.eeprom).length;
  const ok = window.confirm(
    `ต้องการกู้คืนค่า EEPROM จากไฟล์ Backup นี้หรือไม่?\n\n` +
      `รุ่นในไฟล์: ${data.model || "?"}\n` +
      `เวลาที่สำรอง: ${data.timestamp || "?"}\n` +
      `จำนวนข้อมูล: ${count} ไบต์\n\n` +
      "ระบบจะเขียนค่าเดิมกลับลงไปในเครื่องพิมพ์"
  );
  if (!ok) return;

  setBusy(true, "กำลังเขียนข้อมูลจากไฟล์ Backup กลับเข้าเครื่องพิมพ์...");
  try {
    const res = await WebPrinterSession.withSession(
      { forceChooser: false, manualModel: getManualModel() },
      async (session) => {
        const r = await session.restoreBackup(data);
        const st = await session.readState();
        return { ...r, st };
      }
    );
    renderState(res.st);
    logEvent("restore_ok", { file: file.name, bytes: `${res.written}/${res.total}` });
    alert(
      `กู้คืนข้อมูลสำเร็จ (${res.written}/${res.total} ไบต์)\n` +
        "กรุณาปิดและเปิดเครื่องพิมพ์ใหม่ (Power-cycle) เพื่อยืนยันค่า"
    );
  } catch (err) {
    alert(`การกู้คืนข้อมูลล้มเหลว:\n${err.message || err}`);
  } finally {
    setBusy(false);
  }
}

function populateModelSelector() {
  const sel = document.getElementById("modelSelect");
  if (!sel || !window.MODEL_DB) return;
  const priority = ["L3210", "L3250", "L3110", "L3150"];
  const allKeys = Object.keys(window.MODEL_DB).sort();

  const optAuto = document.createElement("option");
  optAuto.value = "";
  optAuto.textContent = "🔍 ตรวจจับรุ่นอัตโนมัติผ่าน USB (แนะนำ)";
  sel.appendChild(optAuto);

  const grpPop = document.createElement("optgroup");
  grpPop.label = "รุ่นยอดนิยม (L-Series)";
  for (const k of priority) {
    if (window.MODEL_DB[k]) {
      const opt = document.createElement("option");
      opt.value = k;
      const aliases = (window.MODEL_DB[k].names || []).slice(0, 6).join(", ").toUpperCase();
      opt.textContent = `${k} Series (${aliases})`;
      grpPop.appendChild(opt);
    }
  }
  sel.appendChild(grpPop);

  const grpAll = document.createElement("optgroup");
  grpAll.label = `รุ่นทั้งหมดที่รองรับ (${allKeys.length} โปรไฟล์)`;
  for (const k of allKeys) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k;
    grpAll.appendChild(opt);
  }
  sel.appendChild(grpAll);
}

function setupTermsModal() {
  const modal = document.getElementById("termsModal");
  const chk = document.getElementById("termsAgreeChk");
  const btn = document.getElementById("termsAcceptBtn");

  const accepted = Number(localStorage.getItem("ewr_terms_accepted") || "0") === TERMS_VERSION;
  if (accepted) {
    modal.classList.remove("open");
    return;
  }
  modal.classList.add("open");
  chk.checked = false;
  btn.disabled = true;

  chk.addEventListener("change", () => {
    btn.disabled = !chk.checked;
  });
  btn.addEventListener("click", () => {
    if (!chk.checked) return;
    localStorage.setItem("ewr_terms_accepted", String(TERMS_VERSION));
    modal.classList.remove("open");
  });
}

function checkEnvironment() {
  const warnEl = document.getElementById("envWarning");
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const hasWebUsb = Boolean(navigator.usb);

  const msgs = [];
  if (!hasWebUsb) {
    msgs.push(
      "⚠️ เบราว์เซอร์ที่คุณกำลังใช้ (เช่น Safari หรือ Firefox) ไม่รองรับ WebUSB API — กรุณาเปิดหน้าเว็บนี้ด้วย Google Chrome, Microsoft Edge หรือ Brave บน macOS"
    );
  }
  if (!isMac) {
    msgs.push(
      "ℹ️ หน้าเว็บนี้ออกแบบมาสำหรับ macOS โดยเฉพาะ (บน Windows ไดรเวอร์ usbprint.sys จะบล็อก WebUSB แนะนำให้ใช้โปรแกรม .exe สำหรับ Windows)"
    );
  }
  if (msgs.length > 0) {
    warnEl.innerHTML = msgs.map((m) => `<div>${m}</div>`).join("");
    warnEl.style.display = "block";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  checkEnvironment();
  populateModelSelector();
  setupTermsModal();
  renderLogs();

  document.getElementById("btnConnect").addEventListener("click", () => handleConnectAndRead(true));
  document.getElementById("btnRefresh").addEventListener("click", () => handleConnectAndRead(false));
  document.getElementById("btnBackup").addEventListener("click", handleManualBackup);
  document.getElementById("btnReset").addEventListener("click", handleResetFlow);

  const fileInput = document.getElementById("restoreFileInput");
  document.getElementById("btnRestore").addEventListener("click", () => {
    fileInput.value = "";
    fileInput.click();
  });
  fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleRestoreFile(file);
  });

  document.getElementById("btnDownloadLog").addEventListener("click", () => {
    const logs = JSON.parse(localStorage.getItem("ewr_oplogs") || "[]");
    const blob = new Blob([logs.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "operations.log";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  document.getElementById("btnClearLog").addEventListener("click", () => {
    localStorage.removeItem("ewr_oplogs");
    renderLogs();
  });
});
