import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rename, rm, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../.local-mcp/", import.meta.url));
const version = "4.1.0";
const checksum = "e8ffd4b85f08b2c96790cbb8c7679ec29c41f10e4add8a72ca2047ca56b450e198c0671ca0517c977c00d3a95a9c08dc0b026ee9379e67d35e92425487c8745d";
const destination = join(root, "tika");
await mkdir(root, { recursive: true });
try {
  await access(join(destination, `tika-app-${version}.jar`));
  console.log(`Tika ${version} is already installed at ${destination}`);
} catch {
  const temporary = await mkdtemp(join(root, ".tika-install-"));
  try {
    const url = `https://downloads.apache.org/tika/${version}/tika-app-${version}.zip`;
    let response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (response.status === 404) response = await fetch(url.replace("downloads.apache.org", "archive.apache.org/dist"), { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Tika download returned ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha512").update(bytes).digest("hex") !== checksum) throw new Error("Tika checksum mismatch");
    const zip = join(temporary, "tika.zip");
    const unpacked = join(temporary, "unpacked");
    await writeFile(zip, bytes);
    const result = spawnSync("unzip", ["-q", zip, "-d", unpacked], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Tika unzip failed");
    await access(join(unpacked, `tika-app-${version}.jar`));
    await rename(unpacked, destination);
    console.log(`Installed Tika ${version} at ${destination}. Java 17+ is required.`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
