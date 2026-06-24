/* ============================================
   BECKY WEXLIN CREATIVE — main.js
   ============================================ */

document.addEventListener('DOMContentLoaded', function () {

  /* ── MOBILE NAV HAMBURGER ── */
  const hamburger = document.getElementById('hamburger');
  const navLinks  = document.getElementById('nav-links');

  if (hamburger && navLinks) {
    hamburger.addEventListener('click', function () {
      const isOpen = navLinks.classList.toggle('nav-open');
      hamburger.setAttribute('aria-expanded', isOpen);
    });

    document.addEventListener('click', function (e) {
      if (!hamburger.contains(e.target) && !navLinks.contains(e.target)) {
        navLinks.classList.remove('nav-open');
        hamburger.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ── ACTIVE NAV LINK ── */
  // Links are clean root-relative URLs (e.g. /shop, /blog/). Compare normalized
  // pathnames so the active state works on the live clean-URL site.
  const norm = p => (p.replace(/\/+$/, '') || '/');
  const here = norm(window.location.pathname);
  document.querySelectorAll('.nav-links a').forEach(link => {
    const href = link.getAttribute('href');
    if (!href) return;
    const linkPath = norm(new URL(href, window.location.origin).pathname);
    if (linkPath === here) {
      link.classList.add('active');
    }
  });

});
