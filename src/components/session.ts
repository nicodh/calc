// The collaborative engine identifies a replica by a u32 session id and needs
// it to be *deterministic*: the same peer must always present the same one,
// because it breaks ties between concurrent writes and orders concurrent
// inserts. It is derived from the device uuid we already persist.

// The device's identity, stable for as long as its storage is. Also used as
// the `sender` of every update, to recognize our own echoes.
export function getDeviceUuid(): string {
  const uuid = localStorage.getItem("uuid");
  if (uuid) {
    return uuid;
  }
  const newUuid = crypto.randomUUID();
  localStorage.setItem("uuid", newUuid);
  return newUuid;
}

export function sessionIdFromUuid(uuid: string): number {
  // FNV-1a, 32 bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < uuid.length; i += 1) {
    hash ^= uuid.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // 0 is reserved: it is the session suffix of the engine's virtual keys.
  return hash >>> 0 || 1;
}

export function getSessionId(): number {
  return sessionIdFromUuid(getDeviceUuid());
}
