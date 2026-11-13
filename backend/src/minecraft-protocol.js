function encodeVarInt(value) {
  let n = value >>> 0; const out = [];
  do { let byte = n & 0x7f; n >>>= 7; if (n !== 0) byte |= 0x80; out.push(byte); } while (n !== 0);
  return Uint8Array.from(out);
}
export function readVarInt(buffer, offset = 0) {
  let value = 0; let position = offset; let byte;
  do { if (position >= buffer.length) { const e = new Error('Incomplete VarInt.'); e.code = 'INCOMPLETE_PACKET'; throw e; } if (position - offset >= 5) throw new Error('Invalid VarInt.'); byte = buffer[position++]; value |= (byte & 0x7f) << (7 * (position - offset - 1)); } while ((byte & 0x80) !== 0);
  return { value: value >>> 0, size: position - offset };
}
function concat(parts) { const total = parts.reduce((n, p) => n + p.length, 0); const out = new Uint8Array(total); let offset = 0; for (const p of parts) { out.set(p, offset); offset += p.length; } return out; }
export function javaStatusPacket(host, port) {
  const hostBytes = new TextEncoder().encode(host);
  const handshake = concat([encodeVarInt(0), encodeVarInt(-1), encodeVarInt(hostBytes.length), hostBytes, Uint8Array.of((port >>> 8) & 255, port & 255), encodeVarInt(1)]);
  return concat([encodeVarInt(handshake.length), handshake, Uint8Array.of(1, 0)]);
}
export function parseJavaResponse(buffer) {
  const frame = readVarInt(buffer, 0);
  if (frame.value > 65536) throw new Error('Response too large.');
  if (buffer.length < frame.size + frame.value) { const e = new Error('Incomplete response.'); e.code = 'INCOMPLETE_PACKET'; throw e; }
  const packet = buffer.subarray(frame.size, frame.size + frame.value);
  const packetId = readVarInt(packet, 0); if (packetId.value !== 0) throw new Error('Unexpected packet.');
  const length = readVarInt(packet, packetId.size); const start = packetId.size + length.size;
  if (packet.length < start + length.value) { const e = new Error('Incomplete JSON.'); e.code = 'INCOMPLETE_PACKET'; throw e; }
  const json = new TextDecoder().decode(packet.subarray(start, start + length.value));
  if (!json || json.length > 65536) throw new Error('Invalid status payload.');
  return JSON.parse(json);
}
