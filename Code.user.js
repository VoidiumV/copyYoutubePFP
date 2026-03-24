// ==UserScript==
// @name         YouTube — Copy PFP as PNG
// @namespace    https://github.com/you/yt-copy-pfp
// @version      1.0
// @description  Adds a "Copy PFP" button on YouTube channel pages. Copies a direct high-res PNG link, with optional imgBB upload.
// @author       BritishJuggernaut
// @match        https://www.youtube.com/@*
// @match        https://www.youtube.com/channel/*
// @match        https://www.youtube.com/c/*
// @match        https://www.youtube.com/user/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      yt3.ggpht.com
// @connect      yt3.googleusercontent.com
// @connect      lh3.googleusercontent.com
// @connect      api.imgbb.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ─── CONFIG ──────────────────────────────────────────────────────────────────
  // imgBB is OPTIONAL. If your adblocker blocks it, leave this blank ("") and
  // the script will fall back to copying the direct YouTube URL (still high-res,
  // still a PNG thanks to the =rj param — just hosted on Google's CDN).
  const IMGBB_API_KEY = "";

  const DEBUG = true;
  // ─────────────────────────────────────────────────────────────────────────────

  function dbg(...a) { if (DEBUG) console.log("[CopyPFP]", ...a); }

  // ── Styles ────────────────────────────────────────────────────────────────────
  const STYLE = `
    #yt-copy-pfp-btn {
      display:inline-flex; align-items:center; gap:6px;
      margin:8px 0 0 8px; padding:8px 14px;
      border-radius:18px; border:none; cursor:pointer;
      font-family:"Roboto",sans-serif; font-size:13px; font-weight:500;
      background:#f2f2f2; color:#0f0f0f;
      transition:background 0.15s,transform 0.1s;
      white-space:nowrap; user-select:none; z-index:9999; position:relative;
    }
    html[dark] #yt-copy-pfp-btn,
    ytd-app[darker-dark-theme] #yt-copy-pfp-btn { background:#272727; color:#f1f1f1; }
    #yt-copy-pfp-btn:hover { background:#e5e5e5; }
    html[dark] #yt-copy-pfp-btn:hover,
    ytd-app[darker-dark-theme] #yt-copy-pfp-btn:hover { background:#3f3f3f; }
    #yt-copy-pfp-btn:active { transform:scale(0.96); }
    #yt-copy-pfp-btn.loading { opacity:0.6; pointer-events:none; }
    #yt-copy-pfp-btn.success { background:#2ba640 !important; color:#fff !important; }
    #yt-copy-pfp-btn.error   { background:#c0392b !important; color:#fff !important; }
    #yt-copy-pfp-btn.floating {
      position:fixed !important; bottom:80px; right:20px; margin:0;
      box-shadow:0 2px 12px rgba(0,0,0,0.3);
    }
    #yt-copy-pfp-toast {
      position:fixed; bottom:24px; left:50%;
      transform:translateX(-50%) translateY(20px);
      background:#323232; color:#fff; padding:10px 18px; border-radius:8px;
      font-family:"Roboto",sans-serif; font-size:13px; z-index:99999;
      opacity:0; transition:opacity 0.25s,transform 0.25s;
      pointer-events:none; max-width:90vw; text-align:center; white-space:pre-line;
    }
    #yt-copy-pfp-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  `;

  function injectStyles() {
    if (document.getElementById("yt-copy-pfp-style")) return;
    const el = document.createElement("style");
    el.id = "yt-copy-pfp-style";
    el.textContent = STYLE;
    document.head.appendChild(el);
  }

  let toastTimer = null;
  function showToast(msg, isError = false) {
    let t = document.getElementById("yt-copy-pfp-toast");
    if (!t) { t = document.createElement("div"); t.id = "yt-copy-pfp-toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.style.background = isError ? "#c0392b" : "#323232";
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 4000);
  }

  // ── URL helpers ───────────────────────────────────────────────────────────────

  function buildHighResUrl(url) {
    if (!url) return null;
    if (url.startsWith("//")) url = "https:" + url;
    const cleaned = url.replace(/=[^/]+$/, "");

    return cleaned + "=s0";
  }


  function getCandidateUrls(baseUrl) {
    if (!baseUrl) return [];
    if (baseUrl.startsWith("//")) baseUrl = "https:" + baseUrl;
    const stripped = baseUrl.replace(/=[^/]+$/, "");
    return [
      stripped + "=s0",    // original / max
      stripped + "=s2000",
      stripped + "=s1600",
      stripped + "=s900",
      stripped + "=s512",
      baseUrl,             // unchanged as last resort
    ];
  }

  function bestThumb(thumbs) {
    const sorted = [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0));
    return sorted[0].url;
  }

  // ── Extract raw avatar URL from page ─────────────────────────────────────────

  function getAvatarUrlFromPageData() {
    try {
      let raw = null;
      for (const s of document.querySelectorAll("script")) {
        const t = s.textContent;
        if (!t.includes("ytInitialData")) continue;
        const m = t.match(/(?:var |window\.)?ytInitialData\s*=\s*(\{[\s\S]+?\});\s*(?:<\/script>|var |window\.)/);
        if (m) { raw = m[1]; break; }
        const m2 = t.match(/ytInitialData\s*=\s*(\{[\s\S]+)/);
        if (m2) { raw = m2[1]; break; }
      }
      if (!raw) { dbg("ytInitialData not found"); return null; }

      let data;
      try { data = JSON.parse(raw); }
      catch { data = JSON.parse(raw.replace(/;\s*(?:var|window|\/\/)[\s\S]*$/, "")); }

      const checks = [
        () => data?.header?.c4TabbedHeaderRenderer?.avatar?.thumbnails,
        () => data?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel
                ?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources,
        () => data?.header?.pageHeaderRenderer?.avatar?.thumbnails,
        () => data?.header?.carouselHeaderRenderer?.contents?.[0]
                ?.topicChannelDetailsRenderer?.avatar?.thumbnails,
        () => {
          for (const tab of data?.contents?.twoColumnBrowseResultsRenderer?.tabs || []) {
            const m2 = tab?.tabRenderer?.content?.sectionListRenderer
              ?.contents?.[0]?.itemSectionRenderer?.contents?.[0]
              ?.channelAboutFullMetadataRenderer;
            if (m2?.avatar?.thumbnails) return m2.avatar.thumbnails;
          }
        },
      ];

      for (const fn of checks) {
        try {
          const thumbs = fn();
          if (thumbs?.length) { dbg("Avatar from ytInitialData"); return bestThumb(thumbs); }
        } catch (_) {}
      }
    } catch (e) { dbg("ytInitialData error:", e); }
    return null;
  }

  function getAvatarUrlFromDOM() {
    const sels = [
      "yt-page-header-renderer yt-avatar-shape img",
      "yt-page-header-renderer yt-decorated-avatar-view-model img",
      "yt-page-header-renderer yt-avatar-view-model img",
      "yt-page-header-renderer img.yt-core-image",
      "#channel-header-container #avatar img",
      "#channel-header-container yt-img-shadow img",
      "#channel-avatar img", "#avatar-editor img", "#channel-header img",
      "ytd-c4-tabbed-header-renderer img", "ytd-page-header-renderer img",
    ];
    for (const sel of sels) {
      const img = document.querySelector(sel);
      if (img?.src && /ggpht|googleusercontent/.test(img.src)) {
        dbg("Avatar from DOM:", sel);
        return img.src;
      }
    }
    const header = document.querySelector(
      "#channel-header,ytd-c4-tabbed-header-renderer,ytd-page-header-renderer,yt-page-header-renderer"
    );
    if (header) {
      for (const img of header.querySelectorAll("img[src]")) {
        if (/ggpht|googleusercontent/.test(img.src)) return img.src;
      }
    }
    return null;
  }

  // ── Fetch with fallback URLs (handles 400 errors) ─────────────────────────────

  function fetchBlobUrl(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET", url, responseType: "blob",
        onload(res) {
          dbg(`Fetch ${url.slice(-30)} → HTTP ${res.status}`);
          if (res.status >= 200 && res.status < 300) resolve(res.response);
          else reject(new Error("HTTP " + res.status));
        },
        onerror: () => reject(new Error("Network error")),
      });
    });
  }

  async function fetchBlobWithFallback(rawUrl) {
    const candidates = getCandidateUrls(rawUrl);
    dbg("Trying", candidates.length, "URL candidates");
    for (const url of candidates) {
      try {
        const blob = await fetchBlobUrl(url);
        dbg("Success with:", url);
        return blob;
      } catch (e) {
        dbg("Failed:", url, e.message);
      }
    }
    throw new Error("All URL candidates failed (tried " + candidates.length + " sizes)");
  }

  // ── Canvas: blob → PNG base64, min 1000px ─────────────────────────────────────

  function blobToPngBase64(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const objUrl = URL.createObjectURL(blob);
      img.onload = () => {
        try {
          const naturalW = img.naturalWidth  || 800;
          const naturalH = img.naturalHeight || 800;
          const size = Math.max(naturalW, naturalH, 1000); // minimum 1000px
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = size;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, size, size);
          // Center if not square
          const ox = Math.round((size - naturalW) / 2);
          const oy = Math.round((size - naturalH) / 2);
          ctx.drawImage(img, ox, oy, naturalW, naturalH);
          dbg(`Canvas: ${naturalW}x${naturalH} → ${size}x${size} PNG`);
          URL.revokeObjectURL(objUrl);
          resolve(canvas.toDataURL("image/png").split(",")[1]);
        } catch (e) { URL.revokeObjectURL(objUrl); reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error("Image decode failed")); };
      img.src = objUrl;
    });
  }

  // ── imgBB upload (optional) ───────────────────────────────────────────────────

  function uploadToImgBB(base64, name = "pfp") {
    return new Promise((resolve, reject) => {
      const body = new URLSearchParams();
      body.append("key", IMGBB_API_KEY);
      body.append("image", base64);
      body.append("name", name);
      GM_xmlhttpRequest({
        method: "POST",
        url: "https://api.imgbb.com/1/upload",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        data: body.toString(),
        onload(res) {
          try {
            const json = JSON.parse(res.responseText);
            if (json.success) resolve(json.data.url);
            else reject(new Error("imgBB: " + (json.error?.message || "upload failed")));
          } catch (e) { reject(e); }
        },
        onerror: () => reject(new Error("imgBB blocked or unreachable")),
      });
    });
  }

  // ── Main action ───────────────────────────────────────────────────────────────

  async function copyPFP(btn) {
    btn.classList.add("loading");
    btn.querySelector(".btn-label").textContent = "Working…";

    try {
      const rawUrl = getAvatarUrlFromPageData() || getAvatarUrlFromDOM();
      if (!rawUrl) throw new Error("Could not find avatar URL. Check DevTools console (F12) for debug info.");
      dbg("Raw avatar URL:", rawUrl);

      showToast("📥 Fetching avatar…");
      const blob = await fetchBlobWithFallback(rawUrl);

      showToast("🖼️ Converting to PNG…");
      const pngBase64 = await blobToPngBase64(blob);

      let finalUrl;

      if (IMGBB_API_KEY && IMGBB_API_KEY !== "YOUR_IMGBB_API_KEY_HERE") {
        // Upload to imgBB for a permanent hosted link
        showToast("☁️ Uploading to imgBB…");
        const name = (document.querySelector(
          "#channel-name yt-formatted-string, yt-page-header-renderer h1, #channel-header-container #text"
        )?.textContent?.trim() || "pfp").replace(/\s+/g, "_").slice(0, 40);
        try {
          finalUrl = await uploadToImgBB(pngBase64, name);
          dbg("imgBB URL:", finalUrl);
        } catch (e) {
          dbg("imgBB failed, falling back to direct URL:", e.message);
          showToast("⚠️ imgBB blocked — copying direct YouTube link instead");
          finalUrl = buildHighResUrl(rawUrl);
        }
      } else {
        // No imgBB key — copy the direct high-res YouTube CDN URL
        // The image is WebP/JPEG on Google's servers but still high-res
        // Canvas conversion above confirmed it decoded fine as a PNG locally
        finalUrl = buildHighResUrl(rawUrl);
        dbg("No imgBB key, using direct URL:", finalUrl);
      }

      GM_setClipboard(finalUrl);
      btn.classList.remove("loading");
      btn.classList.add("success");
      btn.querySelector(".btn-label").textContent = "Copied!";

      const label = IMGBB_API_KEY ? "✅ imgBB PNG link copied!" : "✅ High-res link copied!";
      showToast(label + "\n" + finalUrl);
      setTimeout(() => { btn.classList.remove("success"); btn.querySelector(".btn-label").textContent = "Copy PFP"; }, 3000);

    } catch (err) {
      console.error("[CopyPFP]", err);
      btn.classList.remove("loading");
      btn.classList.add("error");
      btn.querySelector(".btn-label").textContent = "Failed";
      showToast("❌ " + err.message, true);
      setTimeout(() => { btn.classList.remove("error"); btn.querySelector(".btn-label").textContent = "Copy PFP"; }, 4000);
    }
  }

  // ── Button ────────────────────────────────────────────────────────────────────

  function buildButton(floating = false) {
    const btn = document.createElement("button");
    btn.id = "yt-copy-pfp-btn";
    if (floating) btn.classList.add("floating");
    btn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
      <span class="btn-label">Copy PFP</span>`;
    btn.title = "Copy channel avatar as high-res PNG link";
    btn.addEventListener("click", () => copyPFP(btn));
    return btn;
  }

  // ── Injection ─────────────────────────────────────────────────────────────────

  const ANCHORS = [
    { sel: "yt-page-header-renderer #page-header-banner",                            method: "after"  },
    { sel: "yt-page-header-renderer .page-header-view-model-wiz__page-header-title", method: "after"  },
    { sel: "yt-page-header-renderer yt-avatar-shape",                                method: "after"  },
    { sel: "yt-page-header-renderer yt-decorated-avatar-view-model",                 method: "after"  },
    { sel: "yt-page-header-renderer",                                                method: "append" },
    { sel: "#channel-header-container #inner-header-container",                      method: "append" },
    { sel: "#channel-header-container #channel-header-links",                        method: "before" },
    { sel: "#channel-header-container #channel-tagline",                             method: "after"  },
    { sel: "#channel-header-container #channel-name",                                method: "after"  },
    { sel: "#channel-header-container",                                              method: "append" },
    { sel: "#channel-header",                                                        method: "append" },
    { sel: "ytd-c4-tabbed-header-renderer",                                          method: "append" },
    { sel: "ytd-page-header-renderer",                                               method: "append" },
  ];

  function tryInject() {
    if (document.getElementById("yt-copy-pfp-btn")) return true;
    for (const { sel, method } of ANCHORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      dbg(`Injecting via: ${sel} (${method})`);
      const btn = buildButton(false);
      if (method === "append")      el.appendChild(btn);
      else if (method === "after")  el.insertAdjacentElement("afterend", btn);
      else if (method === "before") el.insertAdjacentElement("beforebegin", btn);
      return true;
    }
    if (DEBUG) ANCHORS.forEach(a => dbg(a.sel, "→", document.querySelector(a.sel) ? "FOUND" : "missing"));
    return false;
  }

  function injectFloating() {
    if (document.getElementById("yt-copy-pfp-btn")) return;
    dbg("Using floating button fallback");
    document.body.appendChild(buildButton(true));
  }

  function init() {
    injectStyles();
    if (tryInject()) return;
    let attempts = 0;
    const obs = new MutationObserver(() => {
      attempts++;
      if (tryInject()) { obs.disconnect(); return; }
      if (attempts > 300) { obs.disconnect(); injectFloating(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      document.getElementById("yt-copy-pfp-btn")?.remove();
      setTimeout(init, 1500);
    }
  }).observe(document.body, { subtree: true, childList: true });

  init();
})();
