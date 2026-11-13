import { HttpError } from './errors.js';

const UA = 'MC-Pulse/1.2 (https://github.com/)';
const CACHE = new Map();
const TTL = 5 * 60 * 1000;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export const SOFTWARE_CATALOG = [
  { id: 'vanilla', name: 'Vanilla', kind: 'jar', description: 'Official Mojang Java server. Includes releases and snapshots.' },
  { id: 'paper', name: 'Paper', kind: 'jar', description: 'High-performance plugin server. Stable builds.' },
  { id: 'purpur', name: 'Purpur', kind: 'jar', description: 'Configurable Paper fork with additional gameplay options.' },
  { id: 'folia', name: 'Folia', kind: 'jar', description: 'Regionised multithreading server based on Paper.' },
  { id: 'fabric', name: 'Fabric', kind: 'launcher', description: 'Lightweight mod loader. Downloads the executable Fabric server launcher.' },
  { id: 'quilt', name: 'Quilt', kind: 'installer', description: 'Open-source mod loader. Downloads the official installer and generates a Quilt server launcher.' },
  { id: 'spigot', name: 'Spigot (BuildTools)', kind: 'buildtool', description: 'Downloads the official BuildTools utility, which builds the selected Spigot server version locally.' },
  { id: 'forge', name: 'Forge', kind: 'installer', description: 'Downloads the official Forge installer; run it to generate server files.' },
  { id: 'neoforge', name: 'NeoForge', kind: 'installer', description: 'Downloads the official NeoForge installer; run it to generate server files.' }
];

async function fetchText(url, accept = 'application/json') {
  const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw new HttpError(502, 'SOFTWARE_UPSTREAM', `The official software provider returned HTTP ${response.status}.`);
  return response.text();
}
async function fetchJson(url) {
  const text = await fetchText(url);
  try { return JSON.parse(text); } catch { throw new HttpError(502, 'SOFTWARE_BAD_METADATA', 'The official software provider returned invalid metadata.'); }
}
async function cached(key, fn) {
  const item = CACHE.get(key);
  if (item && item.expires > Date.now()) return item.value;
  const value = await fn();
  CACHE.set(key, { value, expires: Date.now() + TTL });
  if (CACHE.size > 100) for (const [k, v] of CACHE) if (v.expires <= Date.now()) CACHE.delete(k);
  while (CACHE.size > 200) CACHE.delete(CACHE.keys().next().value);
  return value;
}
function assertLoader(loader) {
  if (!SOFTWARE_CATALOG.some(x => x.id === loader)) throw new HttpError(400, 'UNSUPPORTED_LOADER', 'Choose a supported server software type.');
}
function assertVersion(version) {
  if (typeof version !== 'string' || !SAFE_VERSION.test(version)) throw new HttpError(400, 'INVALID_VERSION', 'A valid Minecraft version is required.');
  return version;
}

async function vanillaVersions() {
  const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  return manifest.versions.map(v => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }));
}
async function paperVersions(project) {
  const data = await fetchJson(`https://fill.papermc.io/v3/projects/${project}`);
  return Object.values(data.versions || {}).flat().map(id => ({ id, type: 'release' }));
}
async function purpurVersions() {
  const data = await fetchJson('https://api.purpurmc.org/v2/purpur');
  return (data.versions || []).map(id => ({ id, type: 'release' }));
}
async function fabricVersions() {
  const data = await fetchJson('https://meta.fabricmc.net/v2/versions/game');
  return data.map(v => ({ id: v.version, type: v.stable ? 'release' : 'snapshot' }));
}
async function forgePromotions() { return fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'); }
async function quiltInstallerVersions() { return fetchJson('https://meta.quiltmc.org/v3/versions/installer'); }
async function forgeVersions() {
  const data = await forgePromotions();
  const ids = [...new Set(Object.keys(data.promos || {}).map(k => k.replace(/-(latest|recommended)$/, '')))];
  return ids.map(id => ({ id, type: 'release' }));
}
async function neoForgeVersions() {
  const xml = await fetchText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml', 'application/xml,text/xml');
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);
  const mapped = new Set();
  for (const v of versions) {
    const legacy = v.match(/^47\.(\d+)\./);
    const modern = v.match(/^(\d+)\.(\d+)\./);
    if (legacy) mapped.add('1.20.1');
    else if (modern) mapped.add(`1.${modern[1]}.${modern[2]}`);
  }
  return [...mapped].sort((a,b) => b.localeCompare(a, undefined, { numeric: true })).map(id => ({ id, type: 'release' }));
}

export async function listSoftwareVersions(loader) {
  assertLoader(loader);
  return cached(`versions:${loader}`, async () => {
    let versions;
    if (loader === 'vanilla') versions = await vanillaVersions();
    else if (loader === 'paper' || loader === 'folia') versions = await paperVersions(loader);
    else if (loader === 'purpur') versions = await purpurVersions();
    else if (loader === 'fabric') versions = await fabricVersions();
    else if (loader === 'quilt') {
      const data = await fetchJson('https://meta.quiltmc.org/v3/versions/game');
      versions = data.map(v => ({ id: typeof v === 'string' ? v : v.version, type: typeof v === 'string' || v.stable ? 'release' : 'snapshot' }));
    }
    else if (loader === 'spigot') versions = (await vanillaVersions()).filter(v => v.type === 'release');
    else if (loader === 'forge') versions = await forgeVersions();
    else versions = await neoForgeVersions();
    return versions;
  });
}

async function paperBuilds(loader, version) {
  const data = await fetchJson(`https://fill.papermc.io/v3/projects/${loader}/versions/${encodeURIComponent(version)}/builds?channel=STABLE&limit=50`);
  return (Array.isArray(data) ? data : []).map(b => ({ id: String(b.id), label: `Build ${b.id} · ${b.channel}`, channel: b.channel, fileName: b.downloads?.['server:default']?.name || `${loader}-${version}-${b.id}.jar`, sha256: b.downloads?.['server:default']?.checksums?.sha256 || null, size: b.downloads?.['server:default']?.size || null }));
}
async function fabricLoaders(version) {
  const [loaders, installers] = await Promise.all([
    fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`),
    fetchJson('https://meta.fabricmc.net/v2/versions/installer')
  ]);
  const stableInstaller = installers.find(v => v.stable) || installers[0];
  return loaders.filter(v => v.loader?.stable).slice(0, 30).map(v => ({ id: v.loader.version, label: `Loader ${v.loader.version}`, installer: stableInstaller?.version || 'latest' }));
}
async function forgeBuilds(version) {
  const data = await forgePromotions();
  const promos = data.promos || {};
  return ['recommended', 'latest'].filter(kind => promos[`${version}-${kind}`]).map(kind => ({ id: `${kind}:${promos[`${version}-${kind}`]}`, label: `${kind === 'recommended' ? 'Recommended' : 'Latest'} · ${promos[`${version}-${kind}`]}` }));
}
async function neoForgeBuilds(version) {
  const xml = await fetchText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml', 'application/xml,text/xml');
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);
  let matches;
  if (version === '1.20.1') matches = versions.filter(v => v.startsWith('47.1.'));
  else {
    const match = version.match(/^1\.(\d+)\.(\d+)$/);
    if (!match) return [];
    matches = versions.filter(v => v.startsWith(`${match[1]}.${match[2]}.`));
  }
  return matches.slice(-40).reverse().map(id => ({ id, label: `NeoForge ${id}` }));
}
export async function listSoftwareBuilds(loader, version) {
  assertLoader(loader); assertVersion(version);
  return cached(`builds:${loader}:${version}`, async () => {
  if (loader === 'vanilla') return [{ id: 'official', label: 'Official server.jar' }];
  if (loader === 'paper' || loader === 'folia') return paperBuilds(loader, version);
  if (loader === 'purpur') {
    const data = await fetchJson(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}`);
    return (data.builds?.all || []).slice(-50).reverse().map(id => ({ id: String(id), label: `Build ${id}` }));
  }
  if (loader === 'fabric') return fabricLoaders(version);
  if (loader === 'quilt') {
    const [loaders, installers] = await Promise.all([fetchJson(`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(version)}`), quiltInstallerVersions()]);
    const installer = installers.find(v => v.stable) || installers[0];
    return loaders.filter(v => v.stable).slice(0, 30).map(v => ({ id: v.version, label: `Quilt Loader ${v.version}`, installer: installer?.version || 'latest' }));
  }
  if (loader === 'spigot') return [{ id: 'buildtools', label: 'Official Spigot BuildTools' }];
  if (loader === 'forge') return forgeBuilds(version);
  return neoForgeBuilds(version);
  });
}

async function vanillaDownload(version) {
  const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  const item = manifest.versions.find(v => v.id === version);
  if (!item) throw new HttpError(404, 'VERSION_NOT_FOUND', 'That Minecraft version is not present in Mojang’s version manifest.');
  let metadataUrl;
  try { metadataUrl = new URL(item.url); } catch { throw new HttpError(502, 'SOFTWARE_BAD_METADATA', 'Mojang returned an invalid version metadata URL.'); }
  if (metadataUrl.protocol !== 'https:' || metadataUrl.hostname !== 'piston-meta.mojang.com' || (metadataUrl.port && metadataUrl.port !== '443') || metadataUrl.username || metadataUrl.password) throw new HttpError(502, 'SOFTWARE_BAD_METADATA', 'Mojang returned an unsupported metadata host.');
  const detail = await fetchJson(metadataUrl.href);
  const url = detail.downloads?.server?.url;
  if (!url || !url.startsWith('https://')) throw new HttpError(404, 'DOWNLOAD_UNAVAILABLE', 'Mojang does not provide a server jar for this version.');
  return { url, fileName: `minecraft_server.${version}.jar`, kind: 'jar', instructions: 'Run the downloaded jar once to generate the server files.' };
}
export async function resolveSoftwareDownload(loader, version, build) {
  assertLoader(loader); assertVersion(version);
  if (typeof build !== 'string' || build.length > 80 || !/^[A-Za-z0-9._:+-]+$/.test(build)) throw new HttpError(400, 'INVALID_BUILD', 'The selected build is invalid.');
  if (loader === 'vanilla') return vanillaDownload(version);
  if (loader === 'paper' || loader === 'folia') {
    const builds = await listSoftwareBuilds(loader, version);
    const found = builds.find(b => b.id === build);
    if (!found) throw new HttpError(404, 'BUILD_NOT_FOUND', 'That stable build is unavailable. Refresh the build list.');
    const data = await fetchJson(`https://fill.papermc.io/v3/projects/${loader}/versions/${encodeURIComponent(version)}/builds/${encodeURIComponent(build)}`);
    const file = data.downloads?.['server:default'];
    if (!file?.url?.startsWith('https://fill-data.papermc.io/')) throw new HttpError(502, 'DOWNLOAD_UNAVAILABLE', 'PaperMC did not return a valid server download.');
    return { url: file.url, fileName: file.name || found.fileName, kind: 'jar', sha256: file.checksums?.sha256 || null, instructions: 'Run the downloaded jar once to generate the server files.' };
  }
  if (loader === 'purpur') {
    const builds = await listSoftwareBuilds(loader, version);
    if (!builds.some(b => b.id === build)) throw new HttpError(404, 'BUILD_NOT_FOUND', 'That Purpur build is unavailable.');
    return { url: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/${encodeURIComponent(build)}/download`, fileName: `purpur-${version}-${build}.jar`, kind: 'jar', instructions: 'Run the downloaded jar once to generate the server files.' };
  }
  if (loader === 'fabric') {
    const options = await listSoftwareBuilds(loader, version);
    const selected = options.find(x => x.id === build);
    if (!selected) throw new HttpError(404, 'BUILD_NOT_FOUND', 'That Fabric Loader version is unavailable.');
    return { url: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(build)}/${encodeURIComponent(selected.installer)}/server/jar`, fileName: `fabric-server-mc.${version}-loader.${build}-launcher.${selected.installer}.jar`, kind: 'launcher', instructions: 'Run this executable server launcher. It downloads the required Minecraft and Fabric files on first start.' };
  }
  if (loader === 'quilt') {
    const options = await listSoftwareBuilds(loader, version);
    const selected = options.find(x => x.id === build);
    if (!selected) throw new HttpError(404, 'BUILD_NOT_FOUND', 'That Quilt Loader version is unavailable.');
    const installer = selected.installer;
    return { url: `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/${encodeURIComponent(installer)}/quilt-installer-${encodeURIComponent(installer)}.jar`, fileName: `quilt-installer-${installer}.jar`, kind: 'installer', instructions: `Run: java -jar quilt-installer-${installer}.jar install server ${version} ${build} --download-server. Then start the generated server with: java -jar server/quilt-server-launch.jar nogui` };
  }
  if (loader === 'spigot') {
    const available = await listSoftwareVersions('spigot');
    if (!available.some(v => v.id === version)) throw new HttpError(404, 'VERSION_NOT_FOUND', 'That Minecraft version is not available in the official release manifest.');
    if (build !== 'buildtools') throw new HttpError(404, 'BUILD_NOT_FOUND', 'The Spigot BuildTools option is invalid.');
    return { url: 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar', fileName: 'BuildTools.jar', kind: 'buildtool', instructions: `Run: java -jar BuildTools.jar --rev ${version}. BuildTools compiles Spigot locally; it does not download a prebuilt Spigot server jar.` };
  }
  if (loader === 'forge') {
    const [kind, forgeVersion] = build.split(':');
    const options = await listSoftwareBuilds(loader, version);
    if (!options.some(x => x.id === build)) throw new HttpError(404, 'BUILD_NOT_FOUND', 'That Forge installer version is unavailable.');
    const artifact = `${version}-${forgeVersion}`;
    return { url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${artifact}/forge-${artifact}-installer.jar`, fileName: `forge-${artifact}-installer.jar`, kind: 'installer', instructions: 'Run: java -jar forge-installer.jar --installServer. This installer generates the server files; the installer itself is not the final server jar.' };
  }
  const options = await listSoftwareBuilds(loader, version);
  if (!options.some(x => x.id === build)) throw new HttpError(404, 'BUILD_NOT_FOUND', 'That NeoForge installer version is unavailable.');
  return { url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${encodeURIComponent(build)}/neoforge-${encodeURIComponent(build)}-installer.jar`, fileName: `neoforge-${build}-installer.jar`, kind: 'installer', instructions: 'Run: java -jar neoforge-installer.jar --installServer. This installer generates the server files; the installer itself is not the final server jar.' };
}
