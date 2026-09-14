import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

// Keep this normalization in sync with the server-side window validator.
// Rounding is fingerprint-only and never changes stored annotation geometry.
export function canonicalWindowFingerprintValue(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("指纹包含非有限数值");
    const fixed = value.toFixed(10);
    return fixed === "-0.0000000000" ? "0.0000000000" : fixed;
  }
  if (Array.isArray(value)) return value.map(canonicalWindowFingerprintValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalWindowFingerprintValue(value[key])]),
    );
  }
  return value;
}

export function windowFingerprint(value) {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(canonicalWindowFingerprintValue(value)))));
}
