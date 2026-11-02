/**
 * Independent Epson WebUSB + IEEE 1284.4 (D4) + EPSON-CTRL stack for macOS (Chromium).
 * Ported directly from epson_d4.py & printer_core.py — EUPL-1.2 licensed.
 */

const EPSON_VID = 0x04b8;
const USB_CLASS_PRINTER = 0x07;
const USB_REQ_GET_DEVICE_ID = 0x00;
const USB_REQ_SOFT_RESET = 0x02;

const CMD_INIT = 0x00;
const CMD_OPEN = 0x01;
const CMD_CLOSE = 0x02;
const CMD_CREDIT = 0x03;
const CMD_CREDIT_REQ = 0x04;
const CMD_GET_SOCKET = 0x09;

const STATE_MAP = {
  0x00: "ERROR",
  0x01: "SELF_PRINTING",
  0x02: "BUSY",
  0x03: "WAITING",
  0x04: "IDLE",
  0x05: "PAUSE",
  0x06: "INK_DRYING",
  0x07: "CLEANING",
  0x08: "FACTORY",
  0x0a: "SHUTDOWN",
};

const ERROR_MAP = {
  0x00: "FATAL",
  0x05: "INK_OUT",
  0x06: "PAPER_OUT",
  0x10: "SERVICE_REQUIRED",
  0x22: "NO_MAINTENANCE_BOX",
  0x25: "COVER_OPEN",
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("ascii");

function asciiBytes(str) {
  return textEncoder.encode(str);
}

function asciiDecode(bytes) {
  return textDecoder.decode(bytes);
}

function concatBytes(...arrays) {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normModelName(name) {
  return (name || "")
    .toLowerCase()
    .trim()
    .replace(/\bseries\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function resolveModel(mdl) {
  const target = normModelName(mdl);
  if (!target || !window.MODEL_DB) return [null, null];
  for (const [key, entry] of Object.entries(window.MODEL_DB)) {
    if (normModelName(key) === target || (entry.names && entry.names.includes(target))) {
      return [key, entry];
    }
  }
  return [null, null];
}

export function parseStatus(resp) {
  let state = "UNKNOWN";
  let error = "NONE";
  const head = asciiBytes("@BDC ST2\r\n");
  if (resp.length < head.length + 2) return { state, error };
  for (let i = 0; i < head.length; i++) {
    if (resp[i] !== head[i]) return { state, error };
  }
  const data = resp.slice(head.length);
  const length = data[0] | (data[1] << 8);
  let i = 2;
  const end = Math.min(data.length, length + 2);
  while (i + 2 <= end) {
    const hdr = data[i];
    const n = data[i + 1];
    const body = data.slice(i + 2, i + 2 + n);
    i += 2 + n;
    if (hdr === 0x01 && body.length > 0) {
      state = STATE_MAP[body[0]] || `0x${body[0].toString(16).toUpperCase().padStart(2, "0")}`;
    } else if (hdr === 0x02 && body.length > 0) {
      error =
        body[0] === 0xff
          ? "NONE"
          : ERROR_MAP[body[0]] || `0x${body[0].toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return { state, error };
}

/**
 * WebUSB transport to an Epson USB Printer Class (0x07) interface.
 */
export class WebUsbTransport {
  constructor(device) {
    this.device = device;
    this.intfNumber = null;
    this.epOut = null;
    this.epIn = null;
    this._buf = new Uint8Array(0);
  }

  static async requestOrGetDevice(forceChooser = false) {
    if (!navigator.usb) {
      throw new Error(
        "เบราว์เซอร์นี้ไม่รองรับ WebUSB API กรุณาเปิดเว็บนี้ด้วย Google Chrome, Microsoft Edge หรือ Brave บน macOS"
      );
    }
    if (!forceChooser) {
      const existing = await navigator.usb.getDevices();
      const epson = existing.find((d) => d.vendorId === EPSON_VID);
      if (epson) return epson;
    }
    return await navigator.usb.requestDevice({
      filters: [{ vendorId: EPSON_VID }],
    });
  }

  _findPrinterInterface() {
    let fallback = null;
    for (const cfg of this.device.configurations) {
      for (const intf of cfg.interfaces) {
        for (const alt of intf.alternates) {
          const epOut = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
          const epIn = alt.endpoints.find((e) => e.direction === "in" && e.type === "bulk");
          if (epOut && epIn) {
            if (alt.interfaceClass === USB_CLASS_PRINTER) {
              return { cfg, intf, alt, epOut, epIn };
            }
            if (!fallback) {
              fallback = { cfg, intf, alt, epOut, epIn };
            }
          }
        }
      }
    }
    return fallback;
  }

  async open() {
    await this.device.open();
    const found = this._findPrinterInterface();
    if (!found) {
      throw new Error("ไม่พบ USB Printer Bulk Endpoints บนอุปกรณ์ Epson นี้");
    }
    if (
      !this.device.configuration ||
      this.device.configuration.configurationValue !== found.cfg.configurationValue
    ) {
      await this.device.selectConfiguration(found.cfg.configurationValue);
    }
    try {
      await this.device.claimInterface(found.intf.interfaceNumber);
    } catch (err) {
      throw new Error(
        `ไม่สามารถเข้าถึงพอร์ต USB ของเครื่องพิมพ์ได้ (${err.message}) — กรุณาปิดหน้าต่างคิวพิมพ์หรือ Epson Status Monitor แล้วลองใหม่`
      );
    }
    if (found.alt.alternateSetting !== 0) {
      try {
        await this.device.selectAlternateInterface(
          found.intf.interfaceNumber,
          found.alt.alternateSetting
        );
      } catch (_) {}
    }
    this.intfNumber = found.intf.interfaceNumber;
    this.epOut = found.epOut.endpointNumber;
    this.epIn = found.epIn.endpointNumber;

    // Best-effort USB Printer Class SOFT_RESET (bmRequestType=0x21, bRequest=0x02)
    try {
      await this.device.controlTransferOut({
        requestType: "class",
        recipient: "interface",
        request: USB_REQ_SOFT_RESET,
        value: 0,
        index: this.intfNumber,
      });
    } catch (_) {}
    return this;
  }

  async close() {
    if (this.device && this.device.opened) {
      try {
        if (this.intfNumber !== null) {
          await this.device.releaseInterface(this.intfNumber);
        }
      } catch (_) {}
      try {
        await this.device.close();
      } catch (_) {}
    }
  }

  async get1284Id() {
    try {
      const res = await this.device.controlTransferIn(
        {
          requestType: "class",
          recipient: "interface",
          request: USB_REQ_GET_DEVICE_ID,
          value: 0,
          index: this.intfNumber,
        },
        1024
      );
      if (res.status === "ok" && res.data && res.data.byteLength > 2) {
        const raw = new Uint8Array(res.data.buffer, res.data.byteOffset + 2, res.data.byteLength - 2);
        const zeroIdx = raw.indexOf(0);
        const slice = zeroIdx >= 0 ? raw.slice(0, zeroIdx) : raw;
        const text = asciiDecode(slice);
        if (text.includes("MDL:") || text.includes(";")) {
          return text;
        }
      }
    } catch (_) {}

    if (this.device.productName) {
      return `MFG:EPSON;MDL:${this.device.productName};`;
    }
    return "";
  }

  async write(data) {
    const res = await this.device.transferOut(this.epOut, data);
    if (res.status !== "ok") {
      throw new Error(`USB transferOut failed with status: ${res.status}`);
    }
  }

  async _pull(timeoutMs = 150) {
    try {
      const res = await Promise.race([
        this.device.transferIn(this.epIn, 16384),
        new Promise((_, reject) => setTimeout(() => reject(new Error("POLL_TIMEOUT")), timeoutMs)),
      ]);
      if (res && res.status === "ok" && res.data && res.data.byteLength > 0) {
        return new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
      }
      return new Uint8Array(0);
    } catch (err) {
      if (err && err.message === "POLL_TIMEOUT") {
        return new Uint8Array(0);
      }
      throw err;
    }
  }

  async read(n, timeoutMs = 8000) {
    let deadline = null;
    while (this._buf.length < n) {
      const chunk = await this._pull(250);
      if (chunk.length > 0) {
        this._buf = concatBytes(this._buf, chunk);
        deadline = null;
      } else {
        const now = performance.now();
        if (deadline === null) {
          deadline = now + timeoutMs;
        } else if (now > deadline) {
          throw new Error("USB read timed out (เครื่องพิมพ์ไม่ตอบกลับตามเวลาที่กำหนด)");
        }
        await sleep(15);
      }
    }
    const out = this._buf.slice(0, n);
    this._buf = this._buf.slice(n);
    return out;
  }

  async drain() {
    for (let i = 0; i < 4; i++) {
      const chunk = await this._pull(60);
      if (chunk.length === 0) break;
    }
    this._buf = new Uint8Array(0);
  }
}

/**
 * IEEE 1284.4 (D4) transaction layer in JavaScript.
 */
export class D4 {
  constructor(transport) {
    this.t = transport;
    this._chan = {};
  }

  static async connect(transport) {
    const d4 = new D4(transport);
    await d4.t.drain();
    // Leave any prior mode and enter 1284.4 mode
    const ejl = concatBytes(
      new Uint8Array([0x00, 0x00, 0x00, 0x1b, 0x01]),
      asciiBytes("@EJL 1284.4\n@EJL\n@EJL\n")
    );
    await d4.t.write(ejl);
    await d4.t.read(8);
    await d4._init();
    return d4;
  }

  async _sendPacket(psid, ssid, credit, control, payload) {
    const len = 6 + payload.length;
    const header = new Uint8Array([
      psid & 0xff,
      ssid & 0xff,
      (len >> 8) & 0xff,
      len & 0xff,
      credit & 0xff,
      control & 0xff,
    ]);
    await this.t.write(concatBytes(header, payload));
  }

  async _recvPacket() {
    const hdr = await this.t.read(6);
    const psid = hdr[0];
    const ssid = hdr[1];
    const length = (hdr[2] << 8) | hdr[3];
    const credit = hdr[4];
    const control = hdr[5];
    const payload = length > 6 ? await this.t.read(length - 6) : new Uint8Array(0);
    return { psid, ssid, credit, control, payload };
  }

  async _control(cmd, payload = new Uint8Array(0)) {
    const body = concatBytes(new Uint8Array([cmd & 0xff]), payload);
    await this._sendPacket(0, 0, 1, 0, body);
    const { payload: reply } = await this._recvPacket();
    if (!reply || reply.length === 0 || reply[0] !== (cmd | 0x80)) {
      throw new Error(`D4 command 0x${cmd.toString(16)} failed`);
    }
    return reply.slice(2);
  }

  async _init() {
    const resp = await this._control(CMD_INIT, new Uint8Array([0x10]));
    if (resp.length !== 1 || resp[0] !== 0x10) {
      throw new Error("D4 Init rejected by printer");
    }
  }

  async _socketId(name) {
    const resp = await this._control(CMD_GET_SOCKET, asciiBytes(name));
    return resp[0];
  }

  async openChannel(serviceName) {
    const ssid = await this._socketId(serviceName);
    const req = new Uint8Array([
      ssid & 0xff,
      ssid & 0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    const resp = await this._control(CMD_OPEN, req);
    const psid = resp[0];
    const mtu = (resp[2] << 8) | resp[3];
    const credit = (resp[6] << 8) | resp[7];
    const ch = { psid, ssid, mtu, tx: credit, rx: 0 };
    this._chan[psid] = ch;
    // Grant the printer 1 credit so it can reply
    await this._control(CMD_CREDIT, new Uint8Array([psid & 0xff, ssid & 0xff, 0x00, 0x01]));
    ch.rx += 1;
    return ch;
  }

  async closeChannel(ch) {
    try {
      await this._control(CMD_CLOSE, new Uint8Array([ch.psid & 0xff, ch.ssid & 0xff]));
    } catch (_) {}
    delete this._chan[ch.psid];
  }

  async _ensureTx(ch) {
    while (ch.tx < 1) {
      const resp = await this._control(
        CMD_CREDIT_REQ,
        new Uint8Array([ch.psid & 0xff, ch.ssid & 0xff, 0xff, 0xff])
      );
      const amount = (resp[2] << 8) | resp[3];
      ch.tx += amount;
      if (amount === 0) {
        await sleep(50);
      }
    }
  }

  async transact(ch, data) {
    const mtu = ch.mtu || 512;
    let offset = 0;
    while (offset < data.length) {
      const chunk = data.slice(offset, offset + (mtu - 6));
      offset += chunk.length;
      const grant = Math.max(0, 1 - ch.rx);
      await this._ensureTx(ch);
      await this._sendPacket(ch.psid, ch.ssid, grant, 0x02, chunk);
      ch.rx += grant;
      ch.tx -= 1;
    }
    while (true) {
      const { psid, credit, payload } = await this._recvPacket();
      if (this._chan[psid]) {
        this._chan[psid].tx += credit;
        this._chan[psid].rx -= 1;
      }
      if (psid === ch.psid) {
        return payload;
      }
    }
  }
}

function actionCode(action) {
  return new Uint8Array([
    action & 0xff,
    (action ^ 0xff) & 0xff,
    (((action >> 1) & 0x7f) | ((action << 7) & 0x80)) & 0xff,
  ]);
}

/**
 * Reads/writes the printer EEPROM and status over the EPSON-CTRL channel.
 */
export class EpsonControl {
  constructor(transport, modelEntry, d4, ch) {
    this.t = transport;
    this.entry = modelEntry;
    this.factory = new Uint8Array(modelEntry.factory);
    this.keyword = new Uint8Array(modelEntry.keyword || []);
    this._d4 = d4;
    this._ch = ch;
  }

  static async create(transport, modelEntry) {
    const d4 = await D4.connect(transport);
    const ch = await d4.openChannel("EPSON-CTRL");
    return new EpsonControl(transport, modelEntry, d4, ch);
  }

  async close() {
    try {
      await this._d4.closeChannel(this._ch);
    } catch (_) {}
  }

  async _command(ccStr, payload) {
    const cc = asciiBytes(ccStr);
    const lenLE = new Uint8Array([payload.length & 0xff, (payload.length >> 8) & 0xff]);
    const frame = concatBytes(cc, lenLE, payload);
    return await this._d4.transact(this._ch, frame);
  }

  async readByte(addr) {
    const addrLE = new Uint8Array([addr & 0xff, (addr >> 8) & 0xff]);
    const payload = concatBytes(this.factory, actionCode(0x41), addrLE);
    const resp = await this._command("||", payload);
    const prefix = asciiDecode(resp.slice(0, 9));
    if (prefix !== "@BDC PS\r\n") {
      throw new Error(`EEPROM read rejected at 0x${addr.toString(16)}: ${asciiDecode(resp)}`);
    }
    const hex = asciiDecode(resp.slice(16, 18));
    return parseInt(hex, 16);
  }

  async writeByte(addr, value) {
    const addrLE = new Uint8Array([addr & 0xff, (addr >> 8) & 0xff]);
    const valByte = new Uint8Array([value & 0xff]);
    const payload = concatBytes(this.factory, actionCode(0x42), addrLE, valByte, this.keyword);
    const resp = await this._command("||", payload);
    const text = asciiDecode(resp);
    if (text.includes(":NA;")) {
      throw new Error(`EEPROM write refused at 0x${addr.toString(16)}: ${text}`);
    }
    return resp;
  }

  async getStatus() {
    return await this._command("st", new Uint8Array([0x01]));
  }
}

/**
 * High-level session equivalent to printer_core.UsbBackend
 */
export class WebPrinterSession {
  constructor(transport, ctrl, model, key, entry) {
    this.t = transport;
    this.ctrl = ctrl;
    this.model = model;
    this.key = key;
    this.entry = entry;
    this.transport = "WebUSB (D4)";
    this.experimental = !(
      window.VALIDATED_MODELS && window.VALIDATED_MODELS.has(normModelName(key))
    );
  }

  static async withSession(options, fn) {
    const { forceChooser = false, manualModel = "" } = options || {};
    const device = await WebUsbTransport.requestOrGetDevice(forceChooser);
    const transport = new WebUsbTransport(device);
    await transport.open();
    let ctrl = null;
    try {
      const idStr = await transport.get1284Id();
      const ident = {};
      for (const field of idStr.split(";")) {
        const idx = field.indexOf(":");
        if (idx > 0) {
          ident[field.slice(0, idx).trim()] = field.slice(idx + 1).trim();
        }
      }
      const detectedMdl = ident.MDL || device.productName || "";
      const targetMdl = manualModel || detectedMdl;
      const [key, entry] = resolveModel(targetMdl);
      if (!entry) {
        throw new Error(
          `ไม่พบรุ่นเครื่องพิมพ์ '${targetMdl || "Unknown"}' ในฐานข้อมูล (คุณสามารถเลือกรุ่นที่เทียบเท่าจากเมนูด้านบนได้)`
        );
      }
      ctrl = await EpsonControl.create(transport, entry);
      const session = new WebPrinterSession(
        transport,
        ctrl,
        detectedMdl || key,
        key,
        entry
      );
      return await fn(session);
    } finally {
      if (ctrl) {
        await ctrl.close();
      }
      await transport.close();
    }
  }

  allAddresses() {
    const set = new Set();
    for (const [a] of this.entry.reset) {
      set.add(Number(a));
    }
    for (const c of this.entry.counters) {
      for (const a of c.addresses) {
        set.add(Number(a));
      }
    }
    return Array.from(set).sort((a, b) => a - b);
  }

  async readWaste() {
    const rows = [];
    for (const c of this.entry.counters) {
      let raw = 0;
      for (let i = 0; i < c.addresses.length; i++) {
        const b = await this.ctrl.readByte(c.addresses[i]);
        raw |= (b & 0xff) << (8 * i);
      }
      const mx = c.max || 0;
      const pct = mx ? (raw / mx) * 100 : 0.0;
      rows.push({
        name: c.name || "Waste pad",
        raw,
        max: mx,
        pct,
      });
    }
    return rows;
  }

  async readUsage() {
    const rows = [];
    for (const [name, groups] of this.entry.usage || []) {
      let total = 0;
      let ok = true;
      for (const regs of groups) {
        let val = 0;
        for (const a of regs) {
          try {
            const b = await this.ctrl.readByte(a);
            val = val * 256 + (b & 0xff);
          } catch (_) {
            ok = false;
          }
        }
        total += val;
      }
      rows.push({ name, value: ok ? total : null });
    }
    return rows;
  }

  async readStatus() {
    try {
      const raw = await this.ctrl.getStatus();
      const { state, error } = parseStatus(raw);
      return `${state} / ${error}`;
    } catch (_) {
      return "unknown";
    }
  }

  async readState() {
    const status = await this.readStatus();
    const waste = await this.readWaste();
    const usage = await this.readUsage();
    return {
      model: this.model,
      key: this.key,
      transport: this.transport,
      experimental: this.experimental,
      status,
      waste,
      usage,
    };
  }

  async createBackupPayload(note = "pre-reset") {
    const addrs = this.allAddresses();
    const eeprom = {};
    for (const a of addrs) {
      eeprom[String(a)] = await this.ctrl.readByte(a);
    }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const safeModel = (this.model || "printer").replace(/[^a-zA-Z0-9]/g, "_");
    return {
      filename: `${safeModel}_${stamp}.json`,
      payload: {
        model: this.model,
        transport: this.transport,
        note,
        timestamp: stamp,
        eeprom,
      },
    };
  }

  async resetCounters() {
    for (const [addr, value] of this.entry.reset) {
      await this.ctrl.writeByte(Number(addr), Number(value));
    }
  }

  async restoreBackup(backupData) {
    const eeprom = (backupData && backupData.eeprom) || {};
    const entries = Object.entries(eeprom);
    let written = 0;
    for (const [addrStr, value] of entries) {
      await this.ctrl.writeByte(Number(addrStr), Number(value));
      written += 1;
    }
    return { written, total: entries.length };
  }
}
