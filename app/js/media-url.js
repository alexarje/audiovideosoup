const PIPED_INSTANCES_FALLBACK = [
  "https://api.piped.private.coffee",
  "https://pipedapi.kavin.rocks",
  "https://pipedapi-libre.kavin.rocks",
  "https://api.piped.yt",
  "https://pipedapi.leptons.xyz",
  "https://pipedapi.nosebs.ru",
  "https://pipedapi.darkness.services",
  "https://pipedapi.orangenet.cc",
  "https://pipedapi.owo.si",
  "https://pipedapi.ducks.party",
];

const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://invidious.f5.si",
  "https://yt.chocolatemoo53.com",
  "https://inv.thepixora.com",
];

const CORS_PROXIES = [
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

const DIRECT_MEDIA_PATTERN = /\.(mp4|webm|mov|m4v|mkv|ogv|ogg|mp3|m4a|wav|aac|flac)(\?|#|$)/i;

const MIME_BY_EXT = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/mp4",
  mkv: "video/webm",
  ogv: "video/ogg",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
  flac: "audio/flac",
};

let pipedInstancesPromise = null;

async function getPipedInstances() {
  if (!pipedInstancesPromise) {
    pipedInstancesPromise = fetch("https://piped-instances.kavin.rocks/")
      .then(async (response) => {
        if (!response.ok) return PIPED_INSTANCES_FALLBACK;
        const data = await parseJsonResponse(response);
        if (!Array.isArray(data)) return PIPED_INSTANCES_FALLBACK;
        const discovered = data
          .map((entry) => entry.api_url?.trim())
          .filter(Boolean);
        return [...new Set([...discovered, ...PIPED_INSTANCES_FALLBACK])];
      })
      .catch(() => PIPED_INSTANCES_FALLBACK);
  }
  return pipedInstancesPromise;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  const requests = [
    url,
    ...CORS_PROXIES.map((proxy) => proxy(url)),
    `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  ];

  for (const requestUrl of requests) {
    try {
      const response = await fetch(requestUrl);
      if (!response.ok) continue;

      const data = await parseJsonResponse(response);
      if (!data) continue;

      if (typeof data.contents === "string" && data.contents.trim()) {
        try {
          return JSON.parse(data.contents);
        } catch {
          continue;
        }
      }

      if (typeof data === "object") return data;
    } catch {
      continue;
    }
  }

  return null;
}

function isResolverError(data) {
  return Boolean(data?.error || (data?.message && !data?.videoStreams && !data?.formatStreams));
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

function guessMimeType(url, fallback = "video/mp4") {
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
    return MIME_BY_EXT[ext] ?? fallback;
  } catch {
    return fallback;
  }
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
  const combined = (data.videoStreams ?? []).filter((s) => !s.videoOnly && s.url);
  if (combined.length) {
    const preferred = ["720p", "480p", "360p", "240p"];
    for (const quality of preferred) {
      const match = combined.find((s) => s.quality === quality);
      if (match) return match;
    }
    return combined[0];
  }

  const audio = (data.audioStreams ?? []).find((s) => s.url);
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
    return combined[0];
  }

  const audio = (data.adaptiveFormats ?? []).find((s) => s.type?.startsWith("audio/") && s.url);
  if (audio) return { ...audio, isAudioOnly: true };

  throw new Error("No playable streams found for this video");
}

function normalizeStreamResult(stream, title, videoId, source) {
  const mimeType = stream.mimeType || stream.type || guessMimeType(stream.url);
  return {
    streamUrl: stream.url,
    title: title || `YouTube ${videoId}`,
    mimeType,
    isAudioOnly: Boolean(stream.isAudioOnly),
    remote: true,
    source,
  };
}

async function resolveYouTubeViaInvidious(videoId) {
  let lastError = "Could not reach a video resolver";

  for (const instance of INVIDIOUS_INSTANCES) {
    const data = await fetchJson(`${instance}/api/v1/videos/${videoId}`);
    if (!data || isResolverError(data)) continue;
    if (!data.formatStreams && !data.adaptiveFormats) continue;

    try {
      const stream = pickInvidiousStream(data);
      return normalizeStreamResult(stream, data.title, videoId, instance);
    } catch (error) {
      lastError = error.message;
    }
  }

  throw new Error(lastError);
}

async function resolveYouTubeViaPiped(videoId) {
  const instances = await getPipedInstances();
  let lastError = "Could not reach a video resolver";
  let blockedByYouTube = false;

  for (const instance of instances) {
    const data = await fetchJson(`${instance}/streams/${videoId}`);
    if (!data) continue;

    if (isResolverError(data)) {
      if (/bot|login_required|sign in/i.test(String(data.message ?? data.error))) {
        blockedByYouTube = true;
      }
      continue;
    }

    if (!data.videoStreams && !data.audioStreams) continue;

    try {
      const stream = pickPipedStream(data);
      return normalizeStreamResult(stream, data.title, videoId, instance);
    } catch (error) {
      lastError = error.message;
    }
  }

  if (blockedByYouTube) {
    throw new Error("YouTube blocked the public resolver. Download the video and use Load media.");
  }

  throw new Error(lastError);
}

async function resolveYouTube(videoId) {
  const resolvers = [resolveYouTubeViaPiped, resolveYouTubeViaInvidious];
  let lastError = "Could not resolve YouTube video. Download the file and use Load media.";

  for (const resolve of resolvers) {
    try {
      return await resolve(videoId);
    } catch (error) {
      lastError = error.message;
    }
  }

  throw new Error(lastError);
}

export function isDirectCdnUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host.includes("googlevideo.com") || host.endsWith("youtube.com");
  } catch {
    return false;
  }
}

export async function resolveMediaUrl(input) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a URL");

  const youtubeId = parseYouTubeId(trimmed);
  if (youtubeId) return resolveYouTube(youtubeId);

  if (isDirectMediaUrl(trimmed)) {
    return {
      streamUrl: trimmed,
      title: trimmed,
      mimeType: guessMimeType(trimmed),
      remote: true,
    };
  }

  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("URL must start with http:// or https://");
    }
    return {
      streamUrl: trimmed,
      title: url.hostname,
      mimeType: guessMimeType(trimmed),
      remote: true,
    };
  } catch (error) {
    if (error.message.startsWith("URL must")) throw error;
    throw new Error("Enter a valid URL");
  }
}

async function fetchViaProxies(url) {
  for (const proxy of CORS_PROXIES) {
    try {
      const response = await fetch(proxy(url));
      if (response.ok && Number(response.headers.get("content-length") ?? 1) !== 0) {
        return response;
      }
    } catch {
      continue;
    }
  }
  throw new Error("Could not download media (proxy fetch failed)");
}

export async function fetchMediaBlob(streamUrl, mimeType, onProgress) {
  onProgress?.("Downloading media…");

  let response = null;
  try {
    const direct = await fetch(streamUrl);
    if (direct.ok) response = direct;
  } catch {
    response = null;
  }

  if (!response) {
    onProgress?.("Downloading media via proxy…");
    response = await fetchViaProxies(streamUrl);
  }

  const blob = await response.blob();
  if (blob.size === 0) throw new Error("Downloaded file is empty");

  if (!blob.type && mimeType) {
    return new Blob([blob], { type: mimeType });
  }

  return blob;
}

export function assertCanvasAccess(video) {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, 1, 1);
  ctx.getImageData(0, 0, 1, 1);
}
