/* =========================================================================
   Microsoft Trainer Library — frontend logic
   - Animated canvas grid/particle backdrop
   - Fetches /api/library (categorized by "ai" / "copilot") and renders tabs
   - Real-time search across both families, accessible video/ebook modal
   No frameworks, no CDNs.
   ========================================================================= */

(function () {
  "use strict";

  const CATEGORIES = ["ai", "copilot"];
  const CATEGORY_LABELS = { ai: "AI", copilot: "Copilot" };

  // ------------------------------------------------------------ State ----
  // Raw data as returned by /api/library: { ai: {videos, ebooks}, copilot: {videos, ebooks} }
  let library = {
    ai: { videos: [], ebooks: [] },
    copilot: { videos: [], ebooks: [] },
  };
  let activeCategory = "ai";
  let lastFocused = null; // element to restore focus to when modal closes
  let modalType = null; // "video" | "ebook" — which element the modal is showing
  let videoObserver = null; // IntersectionObserver bound to the currently-rendered video previews

  // ------------------------------------------------------------ DOM ------
  const els = {
    status: document.getElementById("status"),
    search: document.getElementById("search"),
    modal: document.getElementById("modal"),
    modalPanel: document.querySelector("#modal .modal-panel"),
    modalTitle: document.getElementById("modal-title"),
    modalClose: document.getElementById("modal-close"),
    player: document.getElementById("player"),
    reader: document.getElementById("reader"),
    tabs: Array.from(document.querySelectorAll(".tab")),
    panels: {
      ai: document.getElementById("panel-ai"),
      copilot: document.getElementById("panel-copilot"),
    },
    badges: {
      ai: document.getElementById("badge-ai"),
      copilot: document.getElementById("badge-copilot"),
    },
    sections: {
      ai: {
        videos: {
          grid: document.getElementById("ai-videos-grid"),
          empty: document.getElementById("ai-videos-empty"),
        },
        ebooks: {
          grid: document.getElementById("ai-ebooks-grid"),
          empty: document.getElementById("ai-ebooks-empty"),
        },
      },
      copilot: {
        videos: {
          grid: document.getElementById("copilot-videos-grid"),
          empty: document.getElementById("copilot-videos-empty"),
        },
        ebooks: {
          grid: document.getElementById("copilot-ebooks-grid"),
          empty: document.getElementById("copilot-ebooks-empty"),
        },
      },
    },
  };

  // =====================================================================
  //  Animated backdrop — a subtle drifting particle grid on <canvas>
  // =====================================================================
  function initBackdrop() {
    const canvas = document.getElementById("bg-canvas");
    if (!canvas || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const ctx = canvas.getContext("2d");
    let w, h, dpr, particles;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.width = Math.floor(window.innerWidth * dpr);
      h = canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
      const count = Math.min(90, Math.floor((window.innerWidth * window.innerHeight) / 22000));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.25 * dpr,
        vy: (Math.random() - 0.5) * 0.25 * dpr,
      }));
    }

    function step() {
      ctx.clearRect(0, 0, w, h);
      const linkDist = 130 * dpr;

      // move + draw particles
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;

        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.4 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(34, 227, 255, 0.7)";
        ctx.fill();
      }

      // connect nearby particles with gradient lines
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i];
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist < linkDist) {
            const alpha = (1 - dist / linkDist) * 0.35;
            ctx.strokeStyle = `rgba(168, 85, 247, ${alpha})`;
            ctx.lineWidth = 0.6 * dpr;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      requestAnimationFrame(step);
    }

    resize();
    window.addEventListener("resize", resize);
    requestAnimationFrame(step);
  }

  // =====================================================================
  //  Rendering
  // =====================================================================

  // Escape user/blob-derived strings before inserting into markup.
  function esc(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function cardMarkup(item, type, category) {
    const title = esc(item.title || item.filename || "Untitled");
    const size = item.sizeMB != null ? `${esc(item.sizeMB)} MB` : "";
    const date = item.modified ? esc(formatDate(item.modified)) : "";
    const url = esc(item.url || "");
    const filename = esc(item.filename || (type === "ebook" ? "ebook.html" : "video.mp4"));
    const glyph = type === "ebook" ? "📖" : "▶";
    const actionLabel = type === "ebook" ? "📖 Read" : "▶ Play";
    const actionClass = type === "ebook" ? "btn-read" : "btn-play";
    const categoryLabel = esc(CATEGORY_LABELS[category] || category);
    // Note: no `src` is set here for either preview — video previews are mounted only while
    // on-screen (IntersectionObserver, see wireVideoPreviews) and ebook iframes are mounted
    // only on hover/focus (see wireEbookPreviews). This keeps previews "live" (a real video
    // frame / a real interactive page) without paying the cost for every card at once.
    const previewMarkup =
      type === "ebook"
        ? `<iframe class="card-preview-frame" data-preview-src="${url}" tabindex="-1"
             sandbox="allow-scripts" aria-hidden="true"></iframe>`
        : `<video class="card-preview" data-preview-src="${url}#t=0.75" muted playsinline
             preload="metadata" tabindex="-1" aria-hidden="true"></video>`;

    return `
      <article class="card card--${category}" data-preview-url="${url}">
        <span class="chip chip-${category}">${categoryLabel}</span>
        <div class="card-thumb">
          ${previewMarkup}
          <span class="play-glyph">${glyph}</span>
        </div>
        <h3 class="card-title">${title}</h3>
        <div class="card-meta">
          ${size ? `<span>◈ ${size}</span>` : ""}
          ${date ? `<span>◷ ${date}</span>` : ""}
        </div>
        <div class="card-actions">
          <button class="btn ${actionClass}" type="button"
                  data-url="${url}" data-title="${title}" data-type="${type}">${actionLabel}</button>
          <a class="btn btn-download" href="${url}"
             download="${filename}" rel="noopener">⬇ Download</a>
        </div>
      </article>`;
  }

  // Video cards: only mount the real <video src> while the card is actually on-screen, so a
  // long scrolling grid doesn't keep dozens of decoders resident. Debounced so fast scrolling
  // doesn't rapidly thrash elements in and out. Hover-to-play stays wired per card, but is a
  // no-op if the card happens not to be mounted (i.e. not actually visible to hover anyway).
  function wireVideoPreviews(grid) {
    if (videoObserver) {
      videoObserver.disconnect();
    }
    const pending = new WeakMap();

    videoObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const video = entry.target;
          const isVisible = entry.isIntersecting;
          const existingTimer = pending.get(video);
          if (existingTimer) clearTimeout(existingTimer);

          const timer = setTimeout(() => {
            pending.delete(video);
            const previewSrc = video.dataset.previewSrc;
            if (isVisible) {
              if (video.getAttribute("src") !== previewSrc) {
                video.src = previewSrc;
              }
            } else {
              video.pause();
              video.removeAttribute("src");
              video.load(); // actually release the decoder, not just pause
              video.classList.remove("is-ready");
            }
          }, 180);
          pending.set(video, timer);
        });
      },
      { rootMargin: "150px 0px", threshold: 0.01 }
    );

    grid.querySelectorAll(".card-preview").forEach((video) => {
      video.addEventListener("loadeddata", () => video.classList.add("is-ready"));
      videoObserver.observe(video);

      const card = video.closest(".card");
      card.addEventListener("mouseenter", () => {
        if (!video.getAttribute("src")) return; // not mounted — nothing to preview yet
        video.currentTime = 0.75;
        video.play().catch(() => {
          /* preview autoplay may be blocked; static frame still shows */
        });
      });
      card.addEventListener("mouseleave", () => {
        if (!video.getAttribute("src")) return;
        video.pause();
        video.currentTime = 0.75;
      });
    });
  }

  // Ebook cards: the live iframe is far more expensive than a video preview (a full page
  // load — HTML+CSS+JS+images — plus whatever timers/animations the ebook itself runs), so
  // visibility alone isn't a tight enough bound. Nothing loads until the user actually
  // hovers/focuses that specific card; a short grace period on the way out avoids reload
  // thrash when the mouse just passes across the card.
  function wireEbookPreviews(grid) {
    grid.querySelectorAll(".card").forEach((card) => {
      const frame = card.querySelector(".card-preview-frame");
      if (!frame) return;
      const previewSrc = frame.dataset.previewSrc;
      let hideTimer = null;

      const show = () => {
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
        if (frame.getAttribute("src") !== previewSrc) {
          frame.src = previewSrc;
        }
      };
      const scheduleHide = () => {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          frame.src = "about:blank"; // fully kill the JS context, not just hide it
          frame.classList.remove("is-ready");
          hideTimer = null;
        }, 400);
      };

      frame.addEventListener("load", () => {
        const src = frame.getAttribute("src");
        if (src && src !== "about:blank") {
          frame.classList.add("is-ready");
        }
      });

      card.addEventListener("mouseenter", show);
      card.addEventListener("mouseleave", scheduleHide);
      card.addEventListener("focusin", show);
      card.addEventListener("focusout", scheduleHide);
    });
  }

  function renderInto(grid, empty, list, type, category) {
    if (!list.length) {
      grid.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    grid.innerHTML = list.map((item) => cardMarkup(item, type, category)).join("");

    grid.querySelectorAll(".btn-play, .btn-read").forEach((btn) => {
      btn.addEventListener("click", () =>
        openModal(btn.dataset.type, btn.dataset.url, btn.dataset.title)
      );
    });

    // Live previews, cost-bounded: videos mount/unmount by scroll visibility; ebook iframes
    // mount only on hover/focus (see the two functions above for why they're gated differently).
    if (type === "video") {
      wireVideoPreviews(grid);
    } else {
      wireEbookPreviews(grid);
    }
  }


  // Filter a category's videos/ebooks by the current search query.
  function filterCategory(category, query) {
    const source = library[category];
    if (!query) return source;
    return {
      videos: source.videos.filter((v) => (v.title || "").toLowerCase().includes(query)),
      ebooks: source.ebooks.filter((v) => (v.title || "").toLowerCase().includes(query)),
    };
  }

  // Render only the currently active tab's panel (the other stays hidden,
  // but its data/badge counts are still kept up to date — nothing is lost).
  function renderActivePanel(query) {
    const filtered = filterCategory(activeCategory, query);
    const sections = els.sections[activeCategory];
    renderInto(sections.videos.grid, sections.videos.empty, filtered.videos, "video", activeCategory);
    renderInto(sections.ebooks.grid, sections.ebooks.empty, filtered.ebooks, "ebook", activeCategory);
  }

  // Show per-tab match-count badges while searching so matches in the
  // inactive tab are never silently hidden.
  function updateBadges(query) {
    CATEGORIES.forEach((category) => {
      const badge = els.badges[category];
      if (!query) {
        badge.hidden = true;
        badge.textContent = "";
        return;
      }
      const filtered = filterCategory(category, query);
      const count = filtered.videos.length + filtered.ebooks.length;
      badge.hidden = false;
      badge.textContent = `(${count})`;
    });
  }

  function updateStatus(query) {
    const totalVideos = library.ai.videos.length + library.copilot.videos.length;
    const totalEbooks = library.ai.ebooks.length + library.copilot.ebooks.length;
    const totalAll = totalVideos + totalEbooks;

    if (totalAll === 0) {
      els.status.textContent = "";
      return;
    }

    if (!query) {
      els.status.textContent =
        `${totalVideos} video${totalVideos === 1 ? "" : "s"} · ` +
        `${totalEbooks} ebook${totalEbooks === 1 ? "" : "s"} across AI and Copilot`;
      return;
    }

    const matchedAll = CATEGORIES.reduce((sum, category) => {
      const filtered = filterCategory(category, query);
      return sum + filtered.videos.length + filtered.ebooks.length;
    }, 0);
    els.status.textContent = `${matchedAll} of ${totalAll} items match "${query}"`;
  }

  // =====================================================================
  //  Search + tabs
  // =====================================================================
  function applyFilter() {
    const query = els.search.value.trim().toLowerCase();
    renderActivePanel(query);
    updateBadges(query);
    updateStatus(query);
  }

  function setActiveTab(category) {
    if (category === activeCategory) return;
    activeCategory = category;

    els.tabs.forEach((tab) => {
      const isActive = tab.dataset.category === category;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
      tab.tabIndex = isActive ? 0 : -1;
    });

    CATEGORIES.forEach((c) => {
      els.panels[c].hidden = c !== category;
    });

    applyFilter();
  }

  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => setActiveTab(tab.dataset.category));
  });

  // =====================================================================
  //  Accessible modal / lightbox (shared by video player and ebook reader)
  // =====================================================================
  function openModal(type, url, title) {
    if (!url) return;
    lastFocused = document.activeElement;
    modalType = type;
    els.modalTitle.textContent = title || (type === "ebook" ? "Reading" : "Playing");
    els.modal.hidden = false;
    document.body.style.overflow = "hidden";

    els.modalPanel.classList.toggle("modal-panel--reader", type === "ebook");

    if (type === "ebook") {
      els.player.hidden = true;
      els.player.pause();
      els.player.removeAttribute("src");
      els.reader.hidden = false;
      els.reader.src = url;
    } else {
      els.reader.hidden = true;
      els.reader.removeAttribute("src");
      els.player.hidden = false;
      els.player.src = url;
      els.player.play().catch(() => {
        /* autoplay may be blocked; user can press play */
      });
    }

    els.modalClose.focus();
    document.addEventListener("keydown", onKeydown);
  }

  function closeModal() {
    els.modal.hidden = true;
    els.player.pause();
    els.player.removeAttribute("src");
    els.player.load();
    els.reader.removeAttribute("src");
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKeydown);
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
  }

  function onKeydown(e) {
    if (e.key === "Escape") {
      closeModal();
      return;
    }
    // simple focus trap between close button and the active viewer element
    if (e.key === "Tab") {
      const active = modalType === "ebook" ? els.reader : els.player;
      const focusables = [els.modalClose, active];
      const idx = focusables.indexOf(document.activeElement);
      if (e.shiftKey && idx <= 0) {
        e.preventDefault();
        active.focus();
      } else if (!e.shiftKey && idx === focusables.length - 1) {
        e.preventDefault();
        els.modalClose.focus();
      }
    }
  }

  // close on backdrop / close-button click
  els.modal.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-close")) closeModal();
  });

  // =====================================================================
  //  Data loading
  // =====================================================================
  async function loadLibrary() {
    els.status.classList.remove("error");
    els.status.textContent = "Loading library…";
    try {
      const res = await fetch("/api/library", { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`API responded ${res.status} for /api/library`);
      const data = await res.json();

      library = {
        ai: {
          videos: Array.isArray(data.ai?.videos) ? data.ai.videos : [],
          ebooks: Array.isArray(data.ai?.ebooks) ? data.ai.ebooks : [],
        },
        copilot: {
          videos: Array.isArray(data.copilot?.videos) ? data.copilot.videos : [],
          ebooks: Array.isArray(data.copilot?.ebooks) ? data.copilot.ebooks : [],
        },
      };
      applyFilter();
    } catch (err) {
      console.error("Failed to load library:", err);
      library = { ai: { videos: [], ebooks: [] }, copilot: { videos: [], ebooks: [] } };
      CATEGORIES.forEach((category) => {
        const sections = els.sections[category];
        sections.videos.grid.innerHTML = "";
        sections.ebooks.grid.innerHTML = "";
        sections.videos.empty.hidden = true;
        sections.ebooks.empty.hidden = true;
        els.badges[category].hidden = true;
      });
      els.status.classList.add("error");
      els.status.textContent =
        "⚠ Could not load the library. Check that the API is running and app settings are configured.";
    }
  }

  // =====================================================================
  //  Init
  // =====================================================================
  function init() {
    initBackdrop();
    els.search.addEventListener("input", applyFilter);
    loadLibrary();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
