const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.syncpundit.io",
];

const INVIDIOUS_INSTANCES_FALLBACK = [
  "https://inv.thepixora.com",
];

const DIRECT_MEDIA_PATTERN = /\.(mp4|webm|mov|m4v|mkv|ogv|ogg|mp3|m4a|wav|aac|flac)(\?|#|$)/i;

let invidiousInstancesPromise = null;

async function getInvidiousInstances() {
  if (!invidiousInstancesPromise) {
    invidiousInstancesPromise = fetch("https://api.invidious.io/instances.json?sort_by=health")
      .then((response) => (response.ok ? response.json() : []))
      .then((entries) => {
        const discovered = entries
          .filter(([, meta]) => meta.type === "https" && meta.api)
          .sort((a, b) => Number(b[1].cors) - Number(a[1].cors))
          .map(([host]) => `https://${host}`);
        return [...new Set([...discovered, ...INVIDIOUS_INSTANCES_FALLBACK])];
      })
      .catch(() => INVIDIOUS_INSTANCES_FALLBACK);
  }
  return invidiousInstancesPromise;
}

export function parseYouTubeId(input) {
  try {
    const url = new URL(input.trim());
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return url.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      const embed = url.pathname.match(/^\/(embed|shorts|live)\/([^/?]+)/);
      if (embed) return embed[2];
    }
  } catch {
    return null;
  }
  return null;
}

function isDirectMediaUrl(input) {
  try {
    const url = new URL(input.trim());
    return DIRECT_MEDIA_PATTERN.test(url.pathname);
  } catch {
    return false;
  }
}

function pickPipedStream(data) {
  const combined = (data.videoStreams ?? []).filter((s) => !s.videoOnly);
  if (combined.length) {
    const preferred = ["720p", "480p", "360p", "240p"];
    for (const quality of preferred) {
      const match = combined.find((s) => s.quality === quality);
      if (match) return match;
    }
    return combined[Math.floor(combined.length / 2)];
  }

  const audio = data.audioStreams?.[0];
  if (audio) return { ...audio, isAudioOnly: true };

  throw new Error("No playable streams found for this video");
}

function pickInvidiousStream(data) {
  const combined = (data.formatStreams ?? []).filter((s) => s.url);
  if (combined.length) {
    const preferred = ["720p", "480p", "360p", "240p"];
    for (const quality of preferred) {
      const match = combined.find((s) => s.quality === quality || s.qualityLabel === quality);
      if (match) return match;
    }
    return combined[Math.floor(combined.length / 2)];
  }

  const audio = (data.adaptiveFormats ?? []).find((s) => s.type?.startsWith("audio/") && s.url);
  if (audio) return { ...audio, isAudioOnly: true };

  throw new Error("No playable streams found for this video");
}

async function resolveYouTubeViaInvidious(videoId) {
  const instances = await getInvidiousInstances();
  let lastError = "Could not reach a video resolver";

  for (const instance of instances) {
    try {
      const response = await fetch(`${instance}/api/v1/videos/${videoId}`);
      if (!response.ok) continue;
      const data = await response.json();
      const stream = pickInvidiousStream(data);
      return {
        streamUrl: stream.url,
        title: data.title || `YouTube ${videoId}`,
        isAudioOnly: Boolean(stream.isAudioOnly),
      };
    } catch (error) {
      lastError = error.message;
    }
  }

  throw new Error(lastError);
}

async function resolveYouTubeViaPiped(videoId) {
  let lastError = "Could not reach a video resolver";

  for (const instance of PIPED_INSTANCES) {
    try {
      const response = await fetch(`${instance}/streams/${videoId}`);
      if (!response.ok) continue;
      const data = await response.json();
      const stream = pickPipedStream(data);
      return {
        streamUrl: stream.url,
        title: data.title || `YouTube ${videoId}`,
        isAudioOnly: Boolean(stream.isAudioOnly),
      };
    } catch (error) {
      lastError = error.message;
    }
  }

  throw new Error(lastError);
}

async function resolveYouTube(videoId) {
  const resolvers = [resolveYouTubeViaInvidious, resolveYouTubeViaPiped];
  let lastError = "Could not resolve YouTube video";

  for (const resolve of resolvers) {
    try {
      return await resolve(videoId);
    } catch (error) {
      lastError = error.message;
    }
  }

  throw new Error(lastError);
}

export async function resolveMediaUrl(input) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a URL");

  const youtubeId = parseYouTubeId(trimmed);
  if (youtubeId) return resolveYouTube(youtubeId);

  if (isDirectMediaUrl(trimmed)) {
    return { streamUrl: trimmed, title: trimmed };
  }

  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("URL must start with http:// or https://");
    }
    return { streamUrl: trimmed, title: url.hostname };
  } catch (error) {
    if (error.message.startsWith("URL must")) throw error;
    throw new Error("Enter a valid URL");
  }
}

async function fetchViaProxy(url) {
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  const response = await fetch(proxyUrl);
  if (!response.ok) throw new Error(`Proxy fetch failed (${response.status})`);
  return response.blob();
}

export async function fetchMediaBlob(streamUrl, onProgress) {
  onProgress?.("Fetching media…");

  try {
    const response = await fetch(streamUrl);
    if (response.ok) return response.blob();
  } catch {
    // Fall through to proxy fetch.
  }

  onProgress?.("Fetching media via proxy…");
  return fetchViaProxy(streamUrl);
}

export function assertCanvasAccess(video) {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, 1, 1);
  ctx.getImageData(0, 0, 1, 1);
}
