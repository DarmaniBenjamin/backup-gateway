// A small S3 client (AWS Signature Version 4), enough for off-site backups on any S3-compatible
// storage: Backblaze B2, Wasabi, Amazon S3, Cloudflare R2, MinIO... No outside packages.
//
// Only what the gateway needs: upload with Object Lock, extend a lock, read, list, and check
// that the bucket has Object Lock turned on. It never deletes anything.

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";

export class S3Error extends Error {
  constructor(status, code, message) {
    super(message || code || `Storage error ${status}`);
    this.status = status;
    this.code = code;
  }
}

const sha256hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

// RFC 3986 encoding, as SigV4 wants it (everything but A-Z a-z 0-9 - _ . ~)
function uriEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function xmlValue(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXml(m[1]) : null;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

// Sign a request. Exported for testing against the AWS reference implementation.
export function signRequest({ method, url, headers, body, region, accessKeyId, secretAccessKey, date = new Date() }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20261010T120000Z
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body ?? "");
  const all = { ...headers, host: url.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };

  const names = Object.keys(all).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalUri = url.pathname.split("/").map((seg) => uriEncode(decodeURIComponent(seg))).join("/");
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", key).update(stringToSign).digest("hex");

  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function createS3({ endpoint, region, bucket, accessKeyId, secretAccessKey, timeoutMs = 60_000 }) {
  const base = new URL(endpoint);

  function objectUrl(key = "", query = {}) {
    // Path style: https://endpoint/bucket/key — works on B2, Wasabi, AWS, R2 and MinIO
    const path = `/${uriEncode(bucket)}${key ? `/${key.split("/").map(uriEncode).join("/")}` : ""}`;
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  }

  function request(method, url, { headers = {}, body = null } = {}) {
    const signed = signRequest({ method, url, headers, body, region, accessKeyId, secretAccessKey });
    if (body) signed["content-length"] = String(body.length);
    const lib = url.protocol === "http:" ? http : https;
    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method, headers: signed, timeout: timeoutMs }, (res) => {
        const parts = [];
        res.on("data", (d) => parts.push(d));
        res.on("end", () => {
          const data = Buffer.concat(parts);
          if (res.statusCode >= 300) {
            const xml = data.toString("utf8");
            return reject(new S3Error(res.statusCode, xmlValue(xml, "Code"), xmlValue(xml, "Message")));
          }
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        });
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("The storage service didn't answer in time")));
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  const md5 = (body) => crypto.createHash("md5").update(body).digest("base64");
  const retentionXml = (mode, until) =>
    `<?xml version="1.0" encoding="UTF-8"?><Retention xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Mode>${mode}</Mode><RetainUntilDate>${until.toISOString()}</RetainUntilDate></Retention>`;

  return {
    // Upload, locked until `lockUntil` (nobody can delete or overwrite it before then)
    async putObject(key, body, { lockMode, lockUntil, contentType = "application/octet-stream" } = {}) {
      const headers = { "content-md5": md5(body), "content-type": contentType };
      if (lockMode) {
        headers["x-amz-object-lock-mode"] = lockMode;
        headers["x-amz-object-lock-retain-until-date"] = lockUntil.toISOString();
      }
      const res = await request("PUT", objectUrl(key), { headers, body });
      return { etag: res.headers.etag, versionId: res.headers["x-amz-version-id"] };
    },

    // Keep an object locked for longer. Locks can only ever be extended, never shortened.
    async extendLock(key, lockMode, lockUntil) {
      const body = Buffer.from(retentionXml(lockMode, lockUntil));
      await request("PUT", objectUrl(key, { retention: "" }), {
        headers: { "content-md5": md5(body), "content-type": "application/xml" },
        body,
      });
    },

    async getObject(key) {
      return (await request("GET", objectUrl(key))).body;
    },

    async headObject(key) {
      const res = await request("HEAD", objectUrl(key));
      return {
        size: Number(res.headers["content-length"]),
        lockMode: res.headers["x-amz-object-lock-mode"] ?? null,
        lockUntil: res.headers["x-amz-object-lock-retain-until-date"] ?? null,
      };
    },

    // One page of keys under a prefix
    async list(prefix, continuationToken) {
      const query = { "list-type": "2", prefix, "max-keys": "1000" };
      if (continuationToken) query["continuation-token"] = continuationToken;
      const xml = (await request("GET", objectUrl("", query))).body.toString("utf8");
      const items = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({
        key: xmlValue(m[1], "Key"),
        size: Number(xmlValue(m[1], "Size")),
        lastModified: xmlValue(m[1], "LastModified"),
      }));
      return { items, next: xmlValue(xml, "IsTruncated") === "true" ? xmlValue(xml, "NextContinuationToken") : null };
    },

    // Is Object Lock turned on for the bucket?
    async objectLockEnabled() {
      try {
        const xml = (await request("GET", objectUrl("", { "object-lock": "" }))).body.toString("utf8");
        return xmlValue(xml, "ObjectLockEnabled") === "Enabled";
      } catch (err) {
        if (err.code === "ObjectLockConfigurationNotFoundError" || err.code === "NoSuchObjectLockConfiguration") return false;
        throw err;
      }
    },
  };
}
