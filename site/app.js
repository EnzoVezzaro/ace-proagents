/* ACE landing — Phosphor Terminal interactions
 * ES module. Sole import: the vendored Motion v14 bundle (site/vendor/motion.mjs).
 * Grammar: the page prints. The authored moment is the hero claim typing itself;
 * every other reveal is a quiet print-in, staggered per section type.
 * Progressive enhancement: all initial states are set from JS, never CSS.
 * prefers-reduced-motion: every path lands instantly on its final state.
 */

import { animate, inView } from "./vendor/motion.mjs";

const REDUCED =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const EASE = "easeOut";

/* ------------------------------------------------------------------ */
/* Live checkout — ACE Pro support subscription, $9.00 USD/month.      */
/* Real Stripe Payment Link, live mode (acct_1U7JJtLbT22cdeyL).        */
/* Never replace this with a test-mode or invented link.               */
/* ------------------------------------------------------------------ */
window.ACE_CHECKOUT_URL = "https://buy.stripe.com/dRmfZi94q0rv5q8dUHcs805";

(function setupCheckout() {
  const url = window.ACE_CHECKOUT_URL;
  const btn = document.getElementById("checkout-btn");
  const state = document.getElementById("checkout-state");
  if (!btn || !state) return;
  if (url) {
    btn.setAttribute("href", url);
    btn.removeAttribute("hidden");
    state.setAttribute("hidden", "");
  }
  /* else: keep the button hidden and the honest message visible. */
})();

/* ------------------------------------------------------------------ */
/* Copy — controls print their result, lowercase, terminal voice       */
/* ------------------------------------------------------------------ */
(function setupCopy() {
  const buttons = document.querySelectorAll("button.copy[data-copy]");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-copy");
      const target = id ? document.getElementById(id) : null;
      if (!target) return;
      const text = target.textContent;
      const done = () => {
        const original = btn.textContent;
        btn.textContent = "copied";
        btn.setAttribute("data-state", "copied");
        window.setTimeout(() => {
          btn.textContent = original;
          btn.removeAttribute("data-state");
        }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(done)
          .catch(() => fallbackCopy(text, done));
      } else {
        fallbackCopy(text, done);
      }
    });
  });

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    } catch (e) {
      /* clipboard unavailable — button text stays unchanged */
    }
  }
})();

/* ------------------------------------------------------------------ */
/* Typing — width-based print. Text lives in the HTML; JS measures the */
/* natural width, collapses it, and animates 0 → full. A failed module */
/* leaves the full text on screen (progressive enhancement).           */
/* ------------------------------------------------------------------ */
function typeLines(lines, { charMs = 18, lineGapMs = 180, startAt = 0 } = {}) {
  if (REDUCED || !lines.length) return Promise.resolve();

  const widths = lines.map((el) => el.getBoundingClientRect().width);
  lines.forEach((el) => {
    /* .c-line is nowrap, so width-collapse cannot explode its height */
    el.style.width = "0px";
    el.style.overflow = "hidden";
  });

  const clear = (el) => {
    el.style.width = "";
    el.style.overflow = "";
  };

  let chain = Promise.resolve();
  lines.forEach((el, i) => {
    const w = widths[i] || 60;
    /* constant typing speed: milliseconds per CHARACTER, not per pixel;
     * Motion durations are seconds. */
    const durS = Math.max(0.16, (el.textContent.length * charMs) / 1000);
    const gap = i === 0 ? startAt : lineGapMs;
    chain = chain.then(
      () =>
        new Promise((resolve) => {
          window.setTimeout(() => {
            animate(
              el,
              { width: ["0px", w + "px"] },
              {
                duration: durS,
                ease: "linear",
                onComplete: () => {
                  clear(el);
                  resolve();
                },
              }
            );
            /* safety: a stalled frame may never strand the text at width 0 */
            window.setTimeout(() => {
              clear(el);
              resolve();
            }, durS * 1000 + 900);
          }, gap);
        })
    );
  });
  return chain;
}

/* The authored moment: the claim prints itself on load. */
(function heroMoment() {
  const claim = document.querySelector(".claim");
  if (!claim) return;
  const lines = [...claim.querySelectorAll(".c-line")];
  if (REDUCED || !lines.length) return;
  typeLines(lines, { charMs: 18, lineGapMs: 200 });
})();

/* ------------------------------------------------------------------ */
/* Print-in helpers (set initial state from JS only)                   */
/* ------------------------------------------------------------------ */
function printIn(el, opts = {}) {
  if (REDUCED) return;
  animate(
    el,
    { opacity: [0, 1], transform: ["translateY(10px)", "translateY(0px)"] },
    { duration: 0.42, ease: EASE, ...opts }
  );
}

function setInitial(nodes) {
  if (REDUCED) return;
  nodes.forEach((n) => {
    n.style.opacity = "0";
  });
}

/* Armed reveals: inView is primary; a 1s ticker re-checks any group that
 * has stayed intersecting at its amount without its callback delivering
 * (IntersectionObserver delivery races under machine-speed scrolls). A
 * reveal that has fired is never re-armed. */
const revealQueue = [];
function armReveal(el, amount, fire) {
  if (REDUCED || !el) return;
  const entry = { el, amount, done: false, fire: null };
  entry.go = () => {
    if (entry.done) return;
    entry.done = true;
    fire();
  };
  revealQueue.push(entry);
  inView(el, entry.go, { amount });
}
window.setInterval(() => {
  const vh = window.innerHeight;
  for (const e of revealQueue) {
    if (e.done) continue;
    const r = e.el.getBoundingClientRect();
    if (!r.height) continue;
    const overlap = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    const frac = Math.max(0, Math.min(1, overlap / Math.min(r.height, vh)));
    if (frac >= Math.min(e.amount, 0.85)) e.go();
  }
}, 1000);

/* ------------------------------------------------------------------ */
/* Session transcript: type each command, then print its output        */
/* ------------------------------------------------------------------ */
(function session() {
  const block = document.getElementById("session-block");
  if (!block) return;
  const rows = [...block.children];
  const cmds = rows.filter((r) => r.classList.contains("t-line"));
  const outs = rows.filter((r) => r.classList.contains("out"));
  const replay = document.getElementById("session-replay");

  if (REDUCED) return;

  /* measure once; pre-clip commands (clip-path does not affect layout, and
   * the observed parent block stays unclipped so inView can fire) */
  const widths = cmds.map((c) => c.getBoundingClientRect().width);
  setInitial(outs);
  cmds.forEach((c) => {
    c.style.clipPath = "inset(0 100% 0 0)";
  });

  let started = false;
  function run() {
    if (REDUCED) return;
    started = true;

    let t = 0;
    cmds.forEach((cmd, i) => {
      const durMs = Math.max(180, cmd.textContent.length * 12);
      const at = t;
      t += durMs + 140;
      const out = outs[i];
      window.setTimeout(() => {
        animate(
          cmd,
          { clipPath: ["inset(0 100% 0 0)", "inset(0 0% 0 0)"] },
          {
            duration: durMs / 1000,
            ease: "linear",
            onComplete: () => {
              cmd.style.clipPath = "none";
              if (out) printIn(out, { delay: 0.06, onComplete: () => out.classList.add("printed") });
            },
          }
        );
      }, at);
    });
    /* safety: nothing may stay hidden if a frame stalls */
    window.setTimeout(() => {
      outs.forEach((o) => {
        o.style.opacity = "";
      });
      cmds.forEach((c) => {
        c.style.clipPath = "none";
      });
    }, t + 2600);
  }

  armReveal(block, 0.3, run);

  if (replay) replay.addEventListener("click", run);
})();

/* ------------------------------------------------------------------ */
/* Spec: label rows stagger, the ace-key block wipes in like a printout */
/* ------------------------------------------------------------------ */
(function spec() {
  const grid = document.getElementById("spec-grid");
  if (grid) {
    const rows = [...grid.querySelectorAll(".row")];
    if (!REDUCED) {
      setInitial(rows);
      armReveal(grid, 0.15, () => {
        rows.forEach((r, i) => printIn(r, { delay: i * 0.045 }));
      });
    }
  }

  document.querySelectorAll("#spec .code-block, #state .code-block, #git .code-block").forEach((el) => {
    if (REDUCED) return;
    /* Only opacity pre-set here: a pre-applied clip-path zeroes the
     * element's intersection rect, so inView would never fire. The clip is
     * applied at enter time, in the same tick the animation starts. */
    el.style.opacity = "0";
    const clear = () => {
      el.style.clipPath = "none";
      el.style.opacity = "";
    };
    armReveal(el, 0.2, () => {
      el.style.clipPath = "inset(0 0 100% 0)";
      animate(
        el,
        { opacity: [0, 1], clipPath: ["inset(0 0 100% 0)", "inset(0 0 0% 0)"] },
        { duration: 0.55, ease: EASE, onComplete: clear }
      );
      window.setTimeout(clear, 2600);
    });
  });
})();

/* ------------------------------------------------------------------ */
/* CLI rows: fast stagger, a table printing line by line               */
/* ------------------------------------------------------------------ */
(function cli() {
  const rowsWrap = document.getElementById("cli-rows");
  if (!rowsWrap || REDUCED) return;
  const rows = [...rowsWrap.querySelectorAll(".row")];
  setInitial(rows);
  armReveal(rowsWrap, 0.1, () => {
    rows.forEach((r, i) => printIn(r, { delay: i * 0.035, duration: 0.32 }));
  });
})();

/* ------------------------------------------------------------------ */
/* Git-native: commands type, outputs and event rows print             */
/* ------------------------------------------------------------------ */
(function gitAndState() {
  const git = document.getElementById("git-block");
  if (git && !REDUCED) {
    const cmds = [...git.querySelectorAll(".t-line")];
    const outs = [...git.querySelectorAll(".out")];
    setInitial(outs);
    cmds.forEach((c) => {
      c.style.clipPath = "inset(0 100% 0 0)";
    });
    armReveal(git, 0.3, () => {
      cmds.forEach((c) => {
        animate(
          c,
          { clipPath: ["inset(0 100% 0 0)", "inset(0 0% 0 0)"] },
          {
            duration: Math.max(0.24, (c.textContent.length * 12) / 1000),
            ease: "linear",
            onComplete: () => {
              c.style.clipPath = "none";
            },
          }
        );
      });
      outs.forEach((o, i) => printIn(o, { delay: 0.5 + i * 0.28, onComplete: () => o.classList.add("printed") }));
      window.setTimeout(() => {
        outs.forEach((o) => (o.style.opacity = ""));
        cmds.forEach((c) => {
          c.style.clipPath = "none";
        });
      }, 3400);
    });
  }

  const events = document.getElementById("events-block");
  if (events && !REDUCED) {
    const rows = [...events.querySelectorAll(".out")];
    setInitial(rows);
    armReveal(events, 0.3, () => {
      rows.forEach((r, i) => printIn(r, { delay: i * 0.12, onComplete: () => r.classList.add("printed") }));
    });
  }
})();

/* ------------------------------------------------------------------ */
/* Close settles like the end of a session                             */
/* ------------------------------------------------------------------ */
(function closing() {
  const end = document.getElementById("end");
  if (!end || REDUCED) return;
  const parts = [...end.querySelectorAll(".read, .receipt, .action-line, .checkout-state, .cards, .fine")];
  setInitial(parts);
  armReveal(end, 0.15, () => {
    parts.forEach((p, i) => printIn(p, { delay: i * 0.09 }));
  });
  /* safety net: nothing stays hidden */
  window.setTimeout(() => parts.forEach((p) => (p.style.opacity = "")), 12000);
})();

/* ------------------------------------------------------------------ */
/* Scroll-spy: the rail prints the visitor's position in history.      */
/* Rect-based (viewport middle point), not IntersectionObserver —      */
/* deterministic under instant jumps as well as smooth scrolls.        */
/* ------------------------------------------------------------------ */
(function scrollSpy() {
  const links = [...document.querySelectorAll('.rail a[href^="#"]')];
  if (!links.length) return;
  const pairs = links
    .map((a) => ({ a, sec: document.querySelector(a.getAttribute("href")) }))
    .filter((p) => p.sec);

  function update() {
    const mid = window.innerHeight * 0.5;
    let current = null;
    /* bottom clamp: the last section owns the end of the page even when it
     * is shorter than the distance from the viewport middle to the bottom */
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
      current = pairs[pairs.length - 1].sec.id;
    } else {
      for (const { sec } of pairs) {
        const r = sec.getBoundingClientRect();
        if (r.top <= mid && r.bottom >= mid) current = sec.id;
      }
    }
    if (!current) return;
    for (const { a, sec } of pairs) {
      a.classList.toggle("active", sec.id === current);
    }
  }

  let ticking = false;
  window.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        ticking = false;
        update();
      });
    },
    { passive: true }
  );
  window.setInterval(update, 1000);
  update();
})();

/* ------------------------------------------------------------------ */
/* Press spring on copy controls — physical, interruptible             */
/* ------------------------------------------------------------------ */
(function pressSpring() {
  if (REDUCED) return;
  document.querySelectorAll("button.copy").forEach((btn) => {
    btn.addEventListener("pointerdown", () => {
      animate(btn, { scale: 0.97 }, { duration: 0.1, ease: EASE });
    });
    const release = () => {
      animate(
        btn,
        { transform: "scale(1)" },
        { type: "spring", stiffness: 520, damping: 24 }
      );
    };
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointerleave", release);
  });
})();
