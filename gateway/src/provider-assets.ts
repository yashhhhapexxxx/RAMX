import { readFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../../", import.meta.url));
const crc32 = (buffer: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
};
/** Small source-only ZIP. This allow-list cannot include gateway envs, wallets or caches. */
export function providerBundle(): Buffer {
  const files: string[] = [];
  const walk = (path: string) => {
    if (lstatSync(path).isSymbolicLink()) throw new Error("helper source cannot contain symlinks");
    if (statSync(path).isDirectory()) {
      for (const child of readdirSync(path).sort()) if (!child.startsWith(".") && child !== "__pycache__") walk(resolve(path, child));
    } else if (path.endsWith(".py") || path.endsWith(".ts") || path.endsWith(".json")) files.push(path);
  };
  for (const dir of ["shared/src", "shared/config", "node-agent/src", "pool/hooks"]) walk(resolve(root, dir));
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "shared/package.json",
    "node-agent/pyproject.toml", "node-agent/uv.lock", "pool/lib.sh", "pool/join-node.sh", "pool/start-scheduler.sh", "pool/bootstrap/host.py"]) files.push(resolve(root, file));
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(relative(root, file));
    const data = readFileSync(file), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(0o100755 << 16 >>> 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const directories = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directories.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directories, end]);
}
export const providerAsset = (name: "helper.py" | "install.sh") => readFileSync(resolve(root, "pool/provider", name));
export const assetHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
