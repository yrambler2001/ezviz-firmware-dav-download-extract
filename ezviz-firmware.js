#!/usr/bin/env node
/*
 * EZVIZ firmware fetcher - logs in and downloads available firmware for every
 * camera visible to the account.
 *
 * No dependencies: uses only node:crypto, node:fs, node:stream and the global
 * fetch() (Node 18+).
 *
 * Usage:
 *   node ezviz-firmware.js <email> <password> [options]
 *
 * Options:
 *   --out <dir>    output directory          (default: ./firmware)
 *   --list         only list devices and available updates, download nothing
 *   --region <h>   force an API host         (default: from loginArea.apiDomain)
 *   --help
 *
 * The auth scheme is documented in AUTH-NOTES.md:
 *   md5hex        = md5(password)                       (unsalted, lowercase)
 *   v6 password   = base64(RSA_PKCS1(md5hex + "," + unix_seconds))
 *   v5 password   = md5hex                              (fallback)
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// ---------------------------------------------------------------- constants

const GLOBAL_HOST = "api.ezvizlife.com";
const CLIENT_VERSION = "7.6.1.0824";
const UA = "okhttp/4.9.0";

// A per-run device fingerprint. The session JWT embeds this in its "s" claim,
// so it must stay constant across login and every later request.
const FEATURE_CODE = crypto.randomBytes(16).toString("hex");

// ------------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function md5Hex(s) {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

/** UserPwdEncryptUtils.getEncryptPwd(): base64(RSA_PKCS1(md5hex + "," + unixSecs)) */
function encryptPassword(password, publicKeyBase64) {
  const key = crypto.createPublicKey({
    key: Buffer.from(publicKeyBase64, "base64"),
    format: "der",
    type: "spki",
  });
  const plaintext = `${md5Hex(password)},${Math.floor(Date.now() / 1000)}`;
  const ct = crypto.publicEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext, "utf8"),
  );
  return ct.toString("base64");
}

function headers(sessionId) {
  const h = {
    clientType: "3",
    osVersion: "14",
    clientVersion: CLIENT_VERSION,
    netType: "WIFI",
    customno: "1000001",
    clientNo: "NodeJS",
    appId: "ys7",
    featureCode: FEATURE_CODE,
    "User-Agent": UA,
  };
  if (sessionId) h.sessionId = sessionId;
  return h;
}

/** Node's fetch collapses every transport failure into "fetch failed"; dig out the real cause. */
function describeError(e) {
  const bits = [e.message];
  for (let c = e.cause; c; c = c.cause) {
    if (c.code) bits.push(c.code);
    else if (c.message && !bits.includes(c.message)) bits.push(c.message);
  }
  return bits.join(" / ");
}

/** Retry an async op on transient transport failures (the CDN occasionally drops a connection). */
async function withRetry(fn, { attempts = 3, label = "request", base = 500 } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts) {
        const wait = base * 2 ** (i - 1);
        process.stderr.write(`  ~ ${label} failed (${describeError(e)}), retrying in ${wait}ms\n`);
        await sleep(wait);
      }
    }
  }
  throw new Error(`${label}: ${describeError(last)}`);
}

/** GET/POST returning parsed JSON, or throwing on transport failure. */
async function api(host, method, endpoint, { sessionId, form, query } = {}) {
  let url = `https://${host}${endpoint}`;
  if (query) url += "?" + new URLSearchParams(query).toString();

  const init = { method, headers: headers(sessionId) };
  if (form) {
    init.body = new URLSearchParams(form).toString();
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  return withRetry(
    async () => {
      const res = await fetch(url, init);
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`${method} ${endpoint} -> HTTP ${res.status}, non-JSON body: ${text.slice(0, 200)}`);
      }
      return { status: res.status, json };
    },
    { label: `${method} ${endpoint}` },
  );
}

function human(bytes) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i ? 1 : 0)} ${u[i]}`;
}

// --------------------------------------------------------------------- login

async function fetchPublicKey(host) {
  const { json } = await api(host, "GET", "/v3/users/publickey");
  const key = json && json.publicKey;
  if (!key) throw new Error("no publicKey in /v3/users/publickey response");
  return key;
}

async function login(email, password, forcedHost) {
  const host = forcedHost || GLOBAL_HOST;
  let publicKey = null;
  try {
    publicKey = await fetchPublicKey(host);
  } catch (e) {
    // The v6 RSA layer is opportunistic - getEncryptPwd() falls back to the bare
    // md5 when it cannot fetch a key, so login can still proceed.
    process.stderr.write(`  ! could not fetch public key (${e.message}); will try bare md5\n`);
  }

  const digest = md5Hex(password);
  const form = {
    account: email,
    password: publicKey ? encryptPassword(password, publicKey) : digest,
    featureCode: FEATURE_CODE,
    msgType: "0",
    redirect: "0",
    zoneOffset: "0",
    bizType: "",
    smsCode: "",
    cuName: "",
    longitude: "",
    latitude: "",
    imageCode: "",
    pushRegisterJson: "",
    pushExtJson: "",
  };

  let { json } = await api(host, "POST", "/v3/users/login/v6", { form });
  let session = json?.loginSession?.sessionId;

  if (!session) {
    // Either the account is on the USER_PWD_NEED_USE_OLD_API grey list, or the
    // server rejected the wrapped form. Retry v5 with the plain digest.
    form.password = digest;
    ({ json } = await api(host, "POST", "/v3/users/login/v5", { form }));
    session = json?.loginSession?.sessionId;
  }

  if (!session) {
    const m = json?.meta || {};
    throw new Error(`login failed: code=${m.code} message=${m.message}`);
  }

  return {
    sessionId: session,
    host: json?.loginArea?.apiDomain || forcedHost || GLOBAL_HOST,
    user: json?.loginUser || {},
    area: json?.loginArea || {},
  };
}

// ------------------------------------------------------------------- devices

async function listDevices(host, sessionId) {
  const devices = [];
  const seen = new Set();
  let offset = 0;
  const limit = 100;

  for (;;) {
    const { json } = await api(host, "GET", "/v3/userdevices/v1/resources/pagelist", {
      sessionId,
      query: { limit, offset },
    });
    const page = json?.page || {};
    const batch = json?.resourceInfos || [];

    for (const d of batch) {
      const serial = d.deviceSerial || d.resourceId;
      if (!serial || seen.has(serial)) continue;
      seen.add(serial);
      devices.push({
        serial,
        name: d.resourceName || d.deviceName || "",
        type: d.resourceType,
        isShared: d.isShared,
      });
    }

    if (!page.hasNext) break;
    offset += limit;
    if (offset > 5000) break; // safety stop
    await sleep(120);
  }
  return devices;
}

async function checkUpgrade(host, sessionId, serial) {
  const { json } = await api(host, "GET", "/v3/deviceupgrade/package/checkUpgrade", {
    sessionId,
    query: { deviceSerial: serial },
  });
  const code = json?.meta?.code;
  if (code !== 0) return { ok: false, code, message: json?.meta?.message };
  return { ok: true, entry: (json?.data?.list || [])[0] || null };
}

/** Stream a package to disk, hashing as we go, then verify against the declared md5. */
async function download(url, dest, expectMd5) {
  const tmp = dest + ".part";
  const res = await withRetry(
    async () => {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return r;
    },
    { label: "firmware fetch", attempts: 4, base: 800 },
  );

  const declared = Number(res.headers.get("content-length") || 0);
  let written = 0;
  const hash = crypto.createHash("md5");

  const counter = new (require("node:stream").Transform)({
    transform(chunk, _enc, cb) {
      written += chunk.length;
      hash.update(chunk);
      if (declared && process.stdout.isTTY) {
        const pct = ((written / declared) * 100).toFixed(0);
        process.stdout.write(`\r    ${pct}%  ${human(written)} / ${human(declared)}   `);
      }
      cb(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
  if (process.stdout.isTTY) process.stdout.write("\r" + " ".repeat(50) + "\r");

  const got = hash.digest("hex");
  if (expectMd5 && got !== expectMd5) {
    fs.unlinkSync(tmp);
    throw new Error(`md5 mismatch: got ${got}, expected ${expectMd5}`);
  }
  fs.renameSync(tmp, dest);
  return { bytes: written, md5: got };
}

// ---------------------------------------------------------------------- main

function parseArgs(argv) {
  const out = { out: "firmware", list: false, region: null, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--list") out.list = true;
    else if (a === "--region") out.region = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else out._.push(a);
  }
  return out;
}

const USAGE = `
Usage: node ezviz-firmware.js <email> <password> [options]

  --out <dir>     output directory (default: ./firmware)
  --list          list devices and available updates only; download nothing
  --region <host> force an API host instead of the one login returns
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length < 2) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  const [email, password] = args._;

  console.log(`Authenticating ${email} ...`);
  const session = await login(email, password, args.region);
  console.log(`  session acquired   (${session.sessionId.slice(0, 24)}...)`);
  console.log(`  api host           ${session.host}`);
  console.log(`  region             ${session.area.areaName || "?"} (areaId ${session.area.areaId})`);
  console.log(`  userId             ${session.user.userId || "?"}`);

  console.log(`\nEnumerating devices ...`);
  const devices = await listDevices(session.host, session.sessionId);
  console.log(`  ${devices.length} device(s) visible to this account\n`);

  const outDir = path.resolve(args.out);
  if (!args.list) fs.mkdirSync(outDir, { recursive: true });

  const summary = [];

  for (const dev of devices) {
    console.log(`- ${dev.serial}  ${dev.name || ""}`);
    let res;
    try {
      res = await checkUpgrade(session.host, session.sessionId, dev.serial);
    } catch (e) {
      console.log(`    ! checkUpgrade failed: ${e.message}`);
      summary.push({ serial: dev.serial, status: "error", detail: e.message });
      continue;
    }

    if (!res.ok) {
      // code 20002 = "current user does not have this device" - it covers both
      // "not bound to you at all" and "shared to you". Only the owner may
      // query or push firmware.
      const shared = res.code === 20002;
      console.log(`    ${shared ? "shared/not owned" : `skipped (code ${res.code})`}${res.message ? ` - ${res.message}` : ""}`);
      summary.push({ serial: dev.serial, status: shared ? "not-owned" : "error", code: res.code });
      continue;
    }

    const entry = res.entry;
    const pkg = entry?.pkg;
    if (!entry) {
      console.log(`    no upgrade record returned`);
      summary.push({ serial: dev.serial, status: "no-record" });
      continue;
    }

    const model = entry.productModel || dev.name;
    if (!pkg || !pkg.url) {
      // Well-formed "already up to date" when productModel matches what the
      // device reports about itself; otherwise the profile lookup failed.
      const matches = !entry.productModel || dev.name.includes(entry.productModel);
      console.log(`    up to date?        ${entry.version || "?"}  (model ${model})${matches ? "" : "  [model mismatch - profile not resolved]"}`);
      summary.push({ serial: dev.serial, status: matches ? "current" : "unresolved", version: entry.version });
      continue;
    }

    console.log(`    update available   ${entry.version || "?"} -> ${pkg.firmwareVersion || "?"}  (${human(pkg.packageSize || 0)})`);
    const md5 = pkg.packageMd5 || "";
    const safeVer = String(pkg.firmwareVersion || entry.version || "fw").replace(/[^A-Za-z0-9._-]/g, "_");
    const dest = path.join(outDir, `${dev.serial}_${safeVer}.dav`);

    if (args.list) {
      console.log(`    [--list] would download ${pkg.url}`);
      summary.push({ serial: dev.serial, status: "update-available", dest, md5 });
      continue;
    }
    if (fs.existsSync(dest)) {
      console.log(`    already on disk    ${dest}`);
      summary.push({ serial: dev.serial, status: "exists", dest });
      continue;
    }

    try {
      const r = await download(pkg.url, dest, md5);
      console.log(`    ok                 ${dest}  (${human(r.bytes)}, md5 ${r.md5.slice(0, 12)}...)`);
      summary.push({ serial: dev.serial, status: "downloaded", dest, bytes: r.bytes, md5: r.md5 });
    } catch (e) {
      console.log(`    ! download failed: ${e.message}`);
      summary.push({ serial: dev.serial, status: "error", detail: e.message });
    }
    await sleep(150);
  }

  console.log("\n=== summary ===");
  for (const s of summary) {
    console.log(`  ${s.serial.padEnd(12)} ${s.status}${s.version ? " " + s.version : ""}${s.detail ? " - " + s.detail : ""}`);
  }
  const got = summary.filter((s) => s.status === "downloaded").length;
  if (!args.list) console.log(`\n${got} firmware image(s) written to ${outDir}`);
}

main().catch((e) => {
  console.error(`\nFatal: ${e.message}`);
  process.exit(1);
});
