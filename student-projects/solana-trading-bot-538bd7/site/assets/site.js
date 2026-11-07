/* ---------------------------------------------------------------------------
   USF landing page.

   The hero is a scroll-scrubbed video. Everything here exists to make that
   feel smooth and to make the page complete when the video never arrives:

     - the video is fetched as a Blob, because many hosts do not support
       partial downloads and every seek would otherwise clamp to zero;
     - the displayed time is eased toward the target in a rAF loop that rests
       when it converges and when the hero is off screen;
     - seeks are gated so two never overlap, which is the difference between
       smooth and choppy in Chrome;
     - every DOM write is delta-gated;
     - five media queries decide who gets the static hero instead, and they are
       re-evaluated live rather than once at load.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  /**
   * Two encodes of the same shot, both with a keyframe every eight frames.
   * H.264 first because it decodes in hardware nearly everywhere, VP9 second
   * for builds without the proprietary codecs (Chromium without H.264, some
   * Linux distributions). Whichever the browser admits to supporting wins.
   */
  var VIDEO_SOURCES = [
    { url: 'assets/hero-scrub.mp4', type: 'video/mp4; codecs="avc1.640028"' },
    { url: 'assets/hero-scrub.webm', type: 'video/webm; codecs="vp9"' }
  ];
  var POSTER_URL = 'assets/hero-poster.jpg';
  var ENDING_URL = 'assets/hero-ending.jpg';
  // Fallback when the server does not send Content-Length.
  var VIDEO_BYTES = 4200000;

  function pickSource() {
    for (var i = 0; i < VIDEO_SOURCES.length; i += 1) {
      var candidate = VIDEO_SOURCES[i];
      // canPlayType returns 'probably', 'maybe' or ''. Only '' is a real no.
      if (document.createElement('video').canPlayType(candidate.type)) return candidate;
    }
    return null;
  }

  var stage = document.getElementById('stage');
  var video = document.getElementById('hero');
  var poster = document.getElementById('poster');
  var ring = document.getElementById('ring');
  var hero = document.querySelector('.hero');
  var bandEls = Array.prototype.slice.call(document.querySelectorAll('.band'));
  var hudLabel = document.getElementById('hud-label');
  var hudDepth = document.getElementById('hud-depth');

  // ---- text splitting, done once at load ----------------------------------

  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function splitLine(el, index) {
    var text = el.textContent.trim();
    var effect = el.getAttribute('data-effect') || 'scatter';
    var spread = parseFloat(el.getAttribute('data-spread') || '0.45');
    var random = rng(9781 + index * 137);
    var words = text.split(/\s+/);

    el.textContent = '';
    // Screen readers get the whole sentence; the visual copy is decorative.
    var sr = document.createElement('span');
    sr.className = 'sr';
    sr.textContent = text;
    el.appendChild(sr);

    var visual = document.createElement('span');
    visual.setAttribute('aria-hidden', 'true');

    var totalChars = text.replace(/\s+/g, '').length;
    var charIndex = 0;

    words.forEach(function (word, wi) {
      var w = document.createElement('span');
      w.className = 'w';
      // Emphasise the last word of a punch line, so it hangs a beat longer.
      if (effect === 'punch' && wi === words.length - 1) w.classList.add('em');
      w.style.setProperty('--th', String((wi / Math.max(1, words.length)) * spread));

      for (var i = 0; i < word.length; i += 1) {
        var c = document.createElement('span');
        c.className = 'c';
        c.textContent = word[i];
        if (effect === 'scatter') {
          c.style.setProperty('--th', String(random() * 0.55));
          c.style.setProperty('--jx', (random() * 60 - 30).toFixed(1) + 'px');
          c.style.setProperty('--jy', (random() * 50 - 25).toFixed(1) + 'px');
          c.style.setProperty('--jr', (random() * 40 - 20).toFixed(1) + 'deg');
        } else {
          c.style.setProperty('--th', String((charIndex / Math.max(1, totalChars)) * spread));
        }
        charIndex += 1;
        w.appendChild(c);
      }
      visual.appendChild(w);
      if (wi < words.length - 1) visual.appendChild(document.createTextNode(' '));
    });

    el.appendChild(visual);
  }

  Array.prototype.slice.call(document.querySelectorAll('.split')).forEach(splitLine);

  // ---- band model ----------------------------------------------------------

  var bands = bandEls.map(function (el) {
    var range = (el.getAttribute('data-band') || '0,1').split(',').map(Number);
    var rampAttr = el.getAttribute('data-ramp');
    return {
      el: el,
      a: range[0],
      b: range[1],
      ramp: rampAttr ? parseFloat(rampAttr) : null,
      // Cached last-written values, so nothing touches the DOM unnecessarily.
      op: -1,
      k: -1,
      settle: el.classList.contains('settle'),
      first: false,
      last: false,
    };
  });
  if (bands.length > 0) {
    bands[0].first = true;
    bands[bands.length - 1].last = true;
  }

  function smoothstep(p, e0, e1) {
    var t = Math.min(1, Math.max(0, (p - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }

  function clamp01(v) {
    return Math.min(1, Math.max(0, v));
  }

  // Band one assembles on load and then hands over to scroll, so the hero
  // never opens on footage with no words on it.
  var loadK = 0;
  var loadStart = 0;

  function updateCaptions(p) {
    for (var i = 0; i < bands.length; i += 1) {
      var band = bands[i];
      var f = Math.min(0.02, (band.b - band.a) / 3);
      var inRamp = band.first ? 1 : smoothstep(p, band.a, band.a + f);
      var outRamp = band.last ? 0 : smoothstep(p, band.b - f, band.b);
      var opacity = inRamp * (1 - outRamp);

      var ramp = band.ramp || Math.min(0.025, (band.b - band.a) * 0.35);
      var scrollK = clamp01((p - band.a) / ramp);
      var k = band.first ? Math.max(scrollK, loadK) : scrollK;

      // Delta gate: only write when the value has actually moved.
      if (Math.abs(opacity - band.op) > 0.004) {
        band.op = opacity;
        band.el.style.opacity = String(opacity);
      }
      if (Math.abs(k - band.k) > 0.008) {
        band.k = k;
        band.el.style.setProperty('--k', String(k));
        if (band.settle) {
          // Three arrivals inside one band: headline, subline, then the buttons.
          band.el.style.setProperty('--ks-sub', String(clamp01((k - 0.5) * 3)));
          band.el.style.setProperty('--kb', String(clamp01((k - 0.72) * 4)));
        }
      }
    }
    updateHud(p);
  }

  var lastDepth = '';
  var lastDepthAt = 0;
  var lastLabel = '';

  function updateHud(p) {
    if (!hudDepth) return;
    var now = performance.now();
    if (now - lastDepthAt < 100) return;
    lastDepthAt = now;
    var text = Math.round(p * 100) + '%';
    if (text !== lastDepth) {
      lastDepth = text;
      hudDepth.textContent = text;
    }
    var label = p > 0.92 ? 'ARRIVED' : p > 0.5 ? 'RESOLVING' : 'DESCENDING';
    if (label !== lastLabel) {
      lastLabel = label;
      hudLabel.textContent = label;
    }
  }

  // ---- scroll drive --------------------------------------------------------

  function heroProgress() {
    if (!hero) return 0;
    var rect = hero.getBoundingClientRect();
    var range = hero.offsetHeight - window.innerHeight;
    if (range <= 0) return 0;
    return clamp01(-rect.top / range);
  }

  var target = 0;
  var shown = 0;
  var rafId = null;
  var lastTick = 0;
  var heroOnScreen = true;

  function tick(now) {
    var dt = Math.min(100, now - (lastTick || now));
    lastTick = now;
    var k = 0.16;
    shown += (target - shown) * (1 - Math.pow(1 - k, dt / 16.667));

    if (loadK < 1) {
      // A one-time, time-based ramp for band one. Once it reaches 1 the max
      // in updateCaptions holds it assembled.
      if (!loadStart) loadStart = now;
      loadK = clamp01((now - loadStart) / 900);
    }

    var converged = Math.abs(target - shown) < 0.0005;
    if (converged && loadK >= 1) {
      shown = target;
      rafId = null;
      lastTick = 0;
    } else {
      rafId = requestAnimationFrame(tick);
    }

    if (video.duration) requestSeek(shown * video.duration);
    updateCaptions(shown);
  }

  function wake() {
    if (rafId === null && heroOnScreen) {
      lastTick = 0;
      rafId = requestAnimationFrame(tick);
    }
  }

  function onScroll() {
    target = heroProgress();
    if (target > 0.02) stage.classList.add('scrolled');
    else stage.classList.remove('scrolled');
    wake();
  }

  // ---- gated seeking -------------------------------------------------------

  var seekBusy = false;
  var pendingTime = null;

  function requestSeek(t) {
    if (!video.duration) return;
    if (seekBusy) {
      pendingTime = t;
      return;
    }
    seekBusy = true;
    try {
      video.currentTime = t;
    } catch (e) {
      seekBusy = false;
    }
  }

  video.addEventListener('seeked', function () {
    seekBusy = false;
    if (pendingTime !== null) {
      var t = pendingTime;
      pendingTime = null;
      requestSeek(t);
    }
  });

  video.addEventListener('error', function () {
    // The deadlock escape, and the honest fallback.
    seekBusy = false;
    pendingTime = null;
    failVideo();
  });

  // ---- loading the video as a Blob ----------------------------------------

  var started = false;

  function startBlobFetch() {
    if (started) return;
    started = true;
    loadHeroBlob().catch(failVideo);
  }

  function initHeroOnce() {
    if (poster.dataset.ready) return;
    poster.dataset.ready = '1';
    poster.style.backgroundImage = "url('" + POSTER_URL + "')";
    var img = new Image();
    img.onload = startBlobFetch;
    img.onerror = startBlobFetch;
    img.src = POSTER_URL;
    // A hung poster must never block the video forever.
    setTimeout(startBlobFetch, 4000);
  }

  function loadHeroBlob() {
    var source = pickSource();
    if (!source) {
      // No codec this browser will take. The static hero is the right answer,
      // not a spinner that never resolves.
      return Promise.reject(new Error('no supported video codec'));
    }

    var ctrl = new AbortController();
    var watchdog = setTimeout(function () { ctrl.abort(); }, 20000);

    return fetch(source.url, { signal: ctrl.signal })
      .then(function (res) {
        if (!res.ok) throw new Error('video ' + res.status);
        var total = Number(res.headers.get('Content-Length')) || VIDEO_BYTES;
        // Carry the content type across. A Blob assembled from raw chunks has
        // an empty type, and a typeless blob: URL cannot be demuxed at all.
        var type = res.headers.get('Content-Type') || 'video/mp4';
        if (!res.body) return res.blob();

        var reader = res.body.getReader();
        var chunks = [];
        var got = 0;
        var lastRing = 0;

        function pump() {
          return reader.read().then(function (result) {
            if (result.done) return new Blob(chunks, { type: type });
            clearTimeout(watchdog);
            watchdog = setTimeout(function () { ctrl.abort(); }, 20000);
            chunks.push(result.value);
            got += result.value.length;
            var frac = Math.min(1, got / total);
            var now = performance.now();
            if (now - lastRing > 100 || frac === 1) {
              lastRing = now;
              ring.style.setProperty('--ld', String(Math.round(126 * (1 - frac))));
            }
            return pump();
          });
        }
        return pump();
      })
      .then(function (blob) {
        clearTimeout(watchdog);
        ring.style.setProperty('--ld', '0');
        // The element ships with preload="none" so a phone never fetches the
        // video it will not use. Once the Blob is in hand there is nothing
        // left to save, and leaving it at none means Chrome buffers nothing
        // and 'canplay' never fires.
        video.preload = 'auto';
        video.src = URL.createObjectURL(blob);
        video.load();
        video.addEventListener('canplay', function () {
          requestSeek(heroProgress() * video.duration);
          stage.classList.add('video-ready');
          onScroll();
        }, { once: true });
      });
  }

  function failVideo() {
    // An honest scroll cue, never a stuck ring. The page is complete without
    // the video: the poster stands in and every caption still plays.
    if (ring && ring.parentNode) ring.style.display = 'none';
    stage.classList.add('video-failed');
  }

  // ---- the five static-hero gates, kept live -------------------------------

  var GATES = [
    '(max-width: 720px)',
    '(orientation: portrait) and (max-width: 1024px)',
    '(orientation: portrait) and (pointer: coarse)',
    '(orientation: landscape) and (pointer: coarse) and (max-height: 560px)',
    '(prefers-reduced-motion: reduce)'
  ];
  var MQLS = GATES.map(function (q) { return window.matchMedia(q); });
  var scrubOn = false;

  function enableScrub() {
    if (scrubOn) return;
    scrubOn = true;
    initHeroOnce();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    bands.forEach(function (b) { b.op = -1; b.k = -1; });
    updateCaptions(heroProgress());
    onScroll();
  }

  function disableScrub() {
    if (!scrubOn) return;
    scrubOn = false;
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function applyHeroMode() {
    var staticHero = GATES.some(function (q, i) { return MQLS[i].matches; });
    if (staticHero) disableScrub();
    else enableScrub();
  }

  MQLS.forEach(function (m) {
    if (m.addEventListener) m.addEventListener('change', applyHeroMode);
    else if (m.addListener) m.addListener(applyHeroMode);
  });

  // The static hero uses the ending frame, the composed resting shot.
  document.querySelector('.static-hero').style.setProperty('--static-bg', "url('" + ENDING_URL + "')");

  if (hero) {
    var io = new IntersectionObserver(function (entries) {
      heroOnScreen = entries[0].isIntersecting;
      if (heroOnScreen) wake();
      else if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }, { rootMargin: '10% 0px' });
    io.observe(hero);
  }

  applyHeroMode();

  // ---- section entrances ---------------------------------------------------

  var revealObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var el = entry.target;
      el.classList.add('in');
      // Retire the stagger delay once the entrance has played, or every later
      // hover on the same element lags by it forever.
      setTimeout(function () { el.classList.add('done'); }, 1000);
      revealObserver.unobserve(el);
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });

  Array.prototype.slice.call(document.querySelectorAll('.reveal')).forEach(function (el) {
    revealObserver.observe(el);
  });

  // ---- the pipeline draws itself ------------------------------------------

  var pipeline = document.getElementById('pipeline');
  var pipeDraw = document.getElementById('pipeDraw');
  var pipeNodes = Array.prototype.slice.call(document.querySelectorAll('.pipe-node'));
  var pipeProgress = -1;

  function drawPipeline() {
    if (!pipeline || !pipeDraw) return;
    var rect = pipeline.getBoundingClientRect();
    var start = window.innerHeight * 0.85;
    var end = window.innerHeight * 0.32;
    var p = clamp01((start - rect.top) / (start - end));
    if (Math.abs(p - pipeProgress) < 0.01) return;
    pipeProgress = p;
    pipeDraw.style.setProperty('--pipe', String(Math.round(860 * (1 - p))));
    pipeNodes.forEach(function (node, i) {
      var threshold = i / (pipeNodes.length - 1);
      node.classList.toggle('on', p >= threshold - 0.02);
    });
  }

  window.addEventListener('scroll', drawPipeline, { passive: true });
  window.addEventListener('resize', drawPipeline, { passive: true });
  drawPipeline();

  // ---- the one interactive moment -----------------------------------------

  var gateBtn = document.getElementById('gateBtn');
  var gateFill = document.getElementById('gateFill');
  var gateStages = Array.prototype.slice.call(document.querySelectorAll('.gate-stage'));
  var gateValue = 0;
  var holding = false;
  var gateRaf = null;
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function gateFrame() {
    // Builds while held, eases back when released. It never snaps to zero,
    // which is what makes it feel like a mechanism rather than a toggle.
    gateValue += holding ? 0.014 : -0.02;
    gateValue = clamp01(gateValue);
    gateFill.style.width = (gateValue * 100).toFixed(1) + '%';
    gateStages.forEach(function (stage) {
      stage.classList.toggle('on', gateValue >= parseFloat(stage.getAttribute('data-at')));
    });
    gateBtn.textContent = gateValue >= 1 ? 'Approved. Filled on paper.' : holding ? 'Running the checks…' : 'Hold to run the gate';
    if ((holding && gateValue < 1) || (!holding && gateValue > 0)) {
      gateRaf = requestAnimationFrame(gateFrame);
    } else {
      gateRaf = null;
    }
  }

  function startHold(e) {
    if (e && e.cancelable) e.preventDefault();
    if (reducedMotion.matches) {
      // Reduced motion gets the finished state without the hold.
      gateValue = 1;
      gateFill.style.width = '100%';
      gateStages.forEach(function (s) { s.classList.add('on'); });
      gateBtn.textContent = 'Approved. Filled on paper.';
      return;
    }
    holding = true;
    if (gateRaf === null) gateRaf = requestAnimationFrame(gateFrame);
  }

  function endHold() {
    holding = false;
    if (gateRaf === null && gateValue > 0) gateRaf = requestAnimationFrame(gateFrame);
  }

  if (gateBtn) {
    gateBtn.addEventListener('pointerdown', startHold);
    window.addEventListener('pointerup', endHold);
    gateBtn.addEventListener('pointercancel', endHold);
    // Keyboard users hold with space or enter.
    gateBtn.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Enter') startHold(e);
    });
    gateBtn.addEventListener('keyup', endHold);
    gateBtn.addEventListener('blur', endHold);
  }

  // ---- reduced motion, honoured live in both directions --------------------

  function pinToFinalStates() {
    pipeDraw && pipeDraw.style.setProperty('--pipe', '0');
    pipeNodes.forEach(function (n) { n.classList.add('on'); });
    Array.prototype.slice.call(document.querySelectorAll('.reveal')).forEach(function (el) {
      el.classList.add('in', 'done');
    });
    Array.prototype.slice.call(document.querySelectorAll('.bucket')).forEach(function (el) {
      el.classList.add('in');
    });
  }

  function unpinFinalStates() {
    pipeProgress = -1;
    drawPipeline();
  }

  reducedMotion.addEventListener('change', function (e) {
    if (e.matches) {
      pinToFinalStates();
      disableScrub();
    } else {
      unpinFinalStates();
      applyHeroMode();
    }
  });

  if (reducedMotion.matches) pinToFinalStates();

  // Buckets fill their bars when they arrive.
  var bucketObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('in');
      bucketObserver.unobserve(entry.target);
    });
  }, { threshold: 0.3 });
  Array.prototype.slice.call(document.querySelectorAll('.bucket')).forEach(function (el) {
    bucketObserver.observe(el);
  });

  // ---- which build is running ---------------------------------------------
  // Served alongside the API, so the footer can say which version this is.
  // Silent when the page is opened on its own, with no API behind it.
  (function stampBuild() {
    var el = document.getElementById('build');
    if (!el) return;
    fetch('/api/health')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.appVersion) return;
        el.textContent = 'Running version ' + data.appVersion;
        el.hidden = false;
      })
      .catch(function () { /* no API here, so no stamp */ });
  })();

  // Pause every looping animation on a hidden tab. animation-play-state is not
  // inherited, so it has to be set on the elements and their pseudo-elements.
  document.addEventListener('visibilitychange', function () {
    document.body.classList.toggle('paused', document.hidden);
  });
})();
